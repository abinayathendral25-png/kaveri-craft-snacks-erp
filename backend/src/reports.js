const { formatPaisa, milliToDisplay, formatBpsPercent } = require('./math');
const { getFactorySettings, getInventorySummary } = require('./ledger');

function buildDateFilter(column, fromDate, toDate) {
  const clauses = [];
  const params = [];
  if (fromDate) {
    clauses.push(`${column} >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    clauses.push(`${column} <= ?`);
    params.push(toDate);
  }
  return {
    sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function getMonthlyReports(db, { fromDate = '', toDate = '' } = {}) {
  const settings = getFactorySettings(db);
  const invFilter = buildDateFilter('inv.invoice_date', fromDate, toDate);
  const purFilter = buildDateFilter('p.purchase_date', fromDate, toDate);
  const ledFilter = buildDateFilter('sl.movement_date', fromDate, toDate);
  const runFilter = buildDateFilter('pr.run_date', fromDate, toDate);
  const payFilter = buildDateFilter('pay.payment_date', fromDate, toDate);

  // 1. Sales Register + Customer-wise + Product-wise
  const salesRegister = db
    .prepare(
      `SELECT inv.id, inv.invoice_no, inv.invoice_date, inv.status, inv.dispatch_status,
              c.name AS customer_name, c.customer_type, c.gstin AS customer_gstin,
              inv.place_of_supply_state, inv.is_interstate,
              inv.taxable_paisa, inv.cgst_paisa, inv.sgst_paisa, inv.igst_paisa, inv.total_paisa,
              COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.invoice_id = inv.id), 0) AS paid_paisa
       FROM invoices inv
       JOIN customers c ON c.id = inv.customer_id
       WHERE 1=1 ${invFilter.sql}
       ORDER BY inv.invoice_date DESC, inv.id DESC`
    )
    .all(...invFilter.params)
    .map((r) => ({
      ...r,
      outstanding_paisa: r.status === 'CANCELLED' ? 0 : Math.max(0, r.total_paisa - r.paid_paisa),
    }));

  const customerWiseSales = db
    .prepare(
      `SELECT c.id AS customer_id, c.name AS customer_name, c.customer_type, c.state_name,
              COUNT(inv.id) AS invoice_count,
              COALESCE(SUM(inv.taxable_paisa), 0) AS taxable_paisa,
              COALESCE(SUM(inv.cgst_paisa + inv.sgst_paisa + inv.igst_paisa), 0) AS tax_paisa,
              COALESCE(SUM(inv.total_paisa), 0) AS total_paisa
       FROM customers c
       LEFT JOIN invoices inv ON inv.customer_id = c.id AND inv.status = 'POSTED' ${invFilter.sql}
       GROUP BY c.id
       ORDER BY total_paisa DESC`
    )
    .all(...invFilter.params);

  const productWiseSales = db
    .prepare(
      `SELECT i.id AS item_id, i.name AS item_name, i.sku, i.hsn_code,
              COALESCE(SUM(ii.qty_packets), 0) AS qty_packets,
              COALESCE(SUM(ii.taxable_paisa), 0) AS taxable_paisa,
              COALESCE(SUM(ii.cgst_paisa + ii.sgst_paisa + ii.igst_paisa), 0) AS tax_paisa,
              COALESCE(SUM(ii.total_paisa), 0) AS total_paisa
       FROM items i
       LEFT JOIN invoice_items ii ON ii.item_id = i.id
       LEFT JOIN invoices inv ON inv.id = ii.invoice_id AND inv.status = 'POSTED' ${invFilter.sql}
       WHERE i.item_type = 'finished_good'
       GROUP BY i.id
       ORDER BY total_paisa DESC`
    )
    .all(...invFilter.params);

  // 2. GST Summary (GSTR-1 / GSTR-3B outward supplies shape)
  const gstBuckets = db
    .prepare(
      `SELECT CASE WHEN inv.is_interstate = 1 THEN 'Inter-State (IGST)' ELSE 'Intra-State (CGST + SGST)' END AS supply_type,
              CASE WHEN c.gstin IS NOT NULL AND c.gstin != '' THEN 'B2B Registered' ELSE 'B2C Unregistered' END AS gstr1_table,
              COUNT(inv.id) AS invoice_count,
              COALESCE(SUM(inv.taxable_paisa), 0) AS taxable_paisa,
              COALESCE(SUM(inv.cgst_paisa), 0) AS cgst_paisa,
              COALESCE(SUM(inv.sgst_paisa), 0) AS sgst_paisa,
              COALESCE(SUM(inv.igst_paisa), 0) AS igst_paisa,
              COALESCE(SUM(inv.total_paisa), 0) AS total_paisa
       FROM invoices inv
       JOIN customers c ON c.id = inv.customer_id
       WHERE inv.status = 'POSTED' ${invFilter.sql}
       GROUP BY supply_type, gstr1_table`
    )
    .all(...invFilter.params);

  const hsnSummary = db
    .prepare(
      `SELECT ii.hsn_code, i.name AS description,
              SUM(ii.qty_packets) AS total_packets,
              SUM(ii.taxable_paisa) AS taxable_paisa,
              SUM(ii.cgst_paisa) AS cgst_paisa,
              SUM(ii.sgst_paisa) AS sgst_paisa,
              SUM(ii.igst_paisa) AS igst_paisa,
              SUM(ii.total_paisa) AS total_paisa
       FROM invoice_items ii
       JOIN invoices inv ON inv.id = ii.invoice_id
       JOIN items i ON i.id = ii.item_id
       WHERE inv.status = 'POSTED' ${invFilter.sql}
       GROUP BY ii.hsn_code, i.name`
    )
    .all(...invFilter.params);

  // 3. Purchase Register
  const purchaseRegister = db
    .prepare(
      `SELECT p.id, p.purchase_no, p.purchase_date, p.supplier_bill_no, s.name AS supplier_name, s.gstin AS supplier_gstin,
              i.name AS item_name, pi.qty_milli, pi.input_unit, pi.rate_paisa_per_display, pi.line_total_paisa, pi.batch_no, pi.expiry_date,
              i.display_factor_milli
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN items i ON i.id = pi.item_id
       WHERE 1=1 ${purFilter.sql}
       ORDER BY p.purchase_date DESC, p.id DESC`
    )
    .all(...purFilter.params)
    .map((r) => ({
      ...r,
      qty_display: milliToDisplay(r.qty_milli, r.display_factor_milli),
    }));

  // 4. Stock Summary & Stock Ledger
  const stockSummary = getInventorySummary(db).map((it) => {
    const agg = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN movement_type = 'OPENING' THEN qty_delta_milli ELSE 0 END), 0) AS opening_milli,
           COALESCE(SUM(CASE WHEN movement_type IN ('PURCHASE_IN','PROD_OUTPUT','CREDIT_RETURN_IN') THEN qty_delta_milli ELSE 0 END), 0) AS receipts_milli,
           COALESCE(SUM(CASE WHEN movement_type IN ('PROD_ISSUE','DISPATCH_OUT','PROD_SCRAP') THEN -qty_delta_milli ELSE 0 END), 0) AS issues_milli,
           COALESCE(SUM(CASE WHEN movement_type = 'ADJUSTMENT' THEN qty_delta_milli ELSE 0 END), 0) AS adjustments_milli
         FROM stock_ledger sl
         WHERE sl.item_id = ? ${ledFilter.sql}`
      )
      .get(it.id, ...ledFilter.params);

    return {
      ...it,
      opening_display: milliToDisplay(agg.opening_milli, it.display_factor_milli),
      receipts_display: milliToDisplay(agg.receipts_milli, it.display_factor_milli),
      issues_display: milliToDisplay(agg.issues_milli, it.display_factor_milli),
      adjustments_display: milliToDisplay(agg.adjustments_milli, it.display_factor_milli),
    };
  });

  const stockLedger = db
    .prepare(
      `SELECT sl.*, i.name AS item_name, i.item_type, i.display_unit, i.display_factor_milli,
              lot.batch_no, lot.expiry_date, u.full_name AS user_name
       FROM stock_ledger sl
       JOIN items i ON i.id = sl.item_id
       LEFT JOIN stock_lots lot ON lot.id = sl.lot_id
       JOIN users u ON u.id = sl.created_by
       WHERE 1=1 ${ledFilter.sql}
       ORDER BY sl.id DESC
       LIMIT 300`
    )
    .all(...ledFilter.params)
    .map((r) => ({
      ...r,
      qty_delta_display: milliToDisplay(r.qty_delta_milli, r.display_factor_milli),
    }));

  // 5. Production Variance & Costing Report
  const productionReport = db
    .prepare(
      `SELECT pr.*, i.name AS finished_item_name, i.selling_price_paisa
       FROM production_runs pr
       JOIN items i ON i.id = pr.finished_item_id
       WHERE 1=1 ${runFilter.sql}
       ORDER BY pr.id DESC`
    )
    .all(...runFilter.params)
    .map((run) => {
      const consumptions = db
        .prepare(
          `SELECT pc.*, i.name AS item_name, i.display_unit, i.display_factor_milli
           FROM production_consumptions pc
           JOIN items i ON i.id = pc.item_id
           WHERE pc.run_id = ?`
        )
        .all(run.id)
        .map((c) => ({
          ...c,
          planned_display: milliToDisplay(c.planned_qty_milli, c.display_factor_milli),
          actual_used_display: milliToDisplay(c.actual_used_milli, c.display_factor_milli),
          damaged_display: milliToDisplay(c.damaged_qty_milli, c.display_factor_milli),
          total_consumed_display: milliToDisplay(c.total_consumed_milli, c.display_factor_milli),
        }));
      const marginPaisa = run.actual_good_packets > 0 ? run.selling_price_paisa - run.cost_per_packet_paisa : 0;
      const marginPct = run.selling_price_paisa > 0 ? Number(((marginPaisa / run.selling_price_paisa) * 100).toFixed(1)) : 0;
      return { ...run, margin_paisa: marginPaisa, margin_pct: marginPct, consumptions };
    });

  // 6. Payments & Receivables with Ageing
  const paymentsList = db
    .prepare(
      `SELECT pay.*, c.name AS customer_name, inv.invoice_no
       FROM payments pay
       JOIN customers c ON c.id = pay.customer_id
       LEFT JOIN invoices inv ON inv.id = pay.invoice_id
       WHERE 1=1 ${payFilter.sql}
       ORDER BY pay.payment_date DESC, pay.id DESC`
    )
    .all(...payFilter.params);

  const today = new Date().toISOString().slice(0, 10);
  const outstandingByCustomer = db
    .prepare(
      `SELECT c.id AS customer_id, c.name AS customer_name, c.customer_type, c.state_name,
              COALESCE(SUM(CASE WHEN inv.status = 'POSTED' THEN inv.total_paisa ELSE 0 END), 0) AS invoiced_paisa,
              COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.customer_id = c.id), 0) AS collected_paisa
       FROM customers c
       LEFT JOIN invoices inv ON inv.customer_id = c.id
       GROUP BY c.id`
    )
    .all()
    .map((c) => {
      const openInvoices = db
        .prepare(
          `SELECT inv.id, inv.invoice_no, inv.invoice_date, inv.total_paisa,
                  COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.invoice_id = inv.id), 0) AS paid_paisa
           FROM invoices inv
           WHERE inv.customer_id = ? AND inv.status = 'POSTED'`
        )
        .all(c.customer_id);
      let b0_30 = 0;
      let b31_60 = 0;
      let b61_plus = 0;
      for (const inv of openInvoices) {
        const rem = Math.max(0, inv.total_paisa - inv.paid_paisa);
        if (rem <= 0) continue;
        const ageDays = Math.floor((new Date(today) - new Date(inv.invoice_date)) / 86400000);
        if (ageDays <= 30) b0_30 += rem;
        else if (ageDays <= 60) b31_60 += rem;
        else b61_plus += rem;
      }
      return {
        ...c,
        outstanding_paisa: Math.max(0, c.invoiced_paisa - c.collected_paisa),
        bucket_0_30_paisa: b0_30,
        bucket_31_60_paisa: b31_60,
        bucket_61_plus_paisa: b61_plus,
      };
    });

  return {
    settings,
    sales_register: salesRegister,
    customer_wise_sales: customerWiseSales,
    product_wise_sales: productWiseSales,
    gst_summary: { buckets: gstBuckets, hsn_summary: hsnSummary },
    purchase_register: purchaseRegister,
    stock_summary: stockSummary,
    stock_ledger: stockLedger,
    production_report: productionReport,
    payments: paymentsList,
    outstanding_ageing: outstandingByCustomer,
  };
}

/**
 * Stretch Goal: Production Planning from pending (SUBMITTED) orders.
 */
function getProductionPlanFromPendingOrders(db) {
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.name AS item_name, i.sku,
              SUM(soi.qty_packets) AS pending_order_packets,
              COALESCE((SELECT SUM(sl.qty_delta_milli) FROM stock_ledger sl WHERE sl.item_id = i.id), 0) AS stock_milli,
              b.id AS bom_id, b.batch_size_packets
       FROM sales_order_items soi
       JOIN sales_orders so ON so.id = soi.order_id
       JOIN items i ON i.id = soi.item_id
       LEFT JOIN boms b ON b.finished_item_id = i.id AND b.active = 1
       WHERE so.status = 'SUBMITTED'
       GROUP BY i.id`
    )
    .all();

  return rows.map((r) => {
    const availablePackets = Math.floor(r.stock_milli / 1000);
    const shortfallPackets = Math.max(0, r.pending_order_packets - availablePackets);
    const batchSize = r.batch_size_packets || 200;
    const batchesNeeded = shortfallPackets > 0 ? Math.ceil(shortfallPackets / batchSize) : 0;
    return {
      ...r,
      available_packets: availablePackets,
      shortfall_packets: shortfallPackets,
      batches_needed: batchesNeeded,
      recommendation:
        batchesNeeded > 0
          ? `To fulfil pending orders, schedule ${batchesNeeded} batch${batchesNeeded > 1 ? 'es' : ''} of ${r.item_name} (${batchesNeeded * batchSize} packets expected)`
          : 'Current finished-goods stock covers pending orders',
    };
  });
}

function toCsv(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return '\uFEFF' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

function generateCsvExport(db, reportType, filters) {
  const rep = getMonthlyReports(db, filters);
  switch (reportType) {
    case 'sales':
      return toCsv(
        ['Invoice No', 'Date', 'Customer', 'Type', 'State', 'Status', 'Dispatch', 'Taxable (INR)', 'CGST', 'SGST', 'IGST', 'Total (INR)', 'Paid', 'Outstanding'],
        rep.sales_register.map((r) => [
          r.invoice_no, r.invoice_date, r.customer_name, r.customer_type, r.place_of_supply_state,
          r.status, r.dispatch_status, formatPaisa(r.taxable_paisa), formatPaisa(r.cgst_paisa),
          formatPaisa(r.sgst_paisa), formatPaisa(r.igst_paisa), formatPaisa(r.total_paisa),
          formatPaisa(r.paid_paisa), formatPaisa(r.outstanding_paisa),
        ])
      );
    case 'gst':
      return toCsv(
        ['HSN Code', 'Description', 'Packets', 'Taxable (INR)', 'CGST', 'SGST', 'IGST', 'Total (INR)'],
        rep.gst_summary.hsn_summary.map((r) => [
          r.hsn_code, r.description, r.total_packets, formatPaisa(r.taxable_paisa),
          formatPaisa(r.cgst_paisa), formatPaisa(r.sgst_paisa), formatPaisa(r.igst_paisa), formatPaisa(r.total_paisa),
        ])
      );
    case 'purchases':
      return toCsv(
        ['Purchase No', 'Date', 'Supplier', 'Bill No', 'Item', 'Qty', 'Unit', 'Rate (INR)', 'Total (INR)', 'Batch No', 'Expiry'],
        rep.purchase_register.map((r) => [
          r.purchase_no, r.purchase_date, r.supplier_name, r.supplier_bill_no || '', r.item_name,
          r.qty_display, r.input_unit, formatPaisa(r.rate_paisa_per_display), formatPaisa(r.line_total_paisa),
          r.batch_no, r.expiry_date,
        ])
      );
    case 'stock-summary':
      return toCsv(
        ['SKU', 'Item', 'Category', 'Unit', 'Opening', 'Receipts', 'Issues/Sales', 'Adjustments', 'Closing Balance', 'FIFO Value (INR)'],
        rep.stock_summary.map((r) => [
          r.sku, r.name, r.item_type, r.display_unit, r.opening_display, r.receipts_display,
          r.issues_display, r.adjustments_display, r.balance_display, formatPaisa(r.fifo_value_paisa),
        ])
      );
    case 'stock-ledger':
      return toCsv(
        ['Date', 'Item', 'Type', 'Delta', 'Unit', 'Rate (INR)', 'Value (INR)', 'Batch', 'Source Ref', 'Notes', 'User'],
        rep.stock_ledger.map((r) => [
          r.movement_date, r.item_name, r.movement_type, r.qty_delta_display, r.display_unit,
          formatPaisa(r.unit_cost_paisa), formatPaisa(r.total_value_paisa), r.batch_no || '', r.source_ref, r.notes || '', r.user_name,
        ])
      );
    case 'production':
      return toCsv(
        ['Run No', 'Date', 'Product', 'Expected Pkts', 'Actual Good Pkts', 'Yield Variance', 'Material Cost', 'Labour', 'Gas/Power', 'Total Cost', 'Cost/Packet'],
        rep.production_report.map((r) => [
          r.run_no, r.run_date, r.finished_item_name, r.expected_packets, r.actual_good_packets,
          formatBpsPercent(r.yield_variance_bps), formatPaisa(r.material_cost_paisa), formatPaisa(r.labour_cost_paisa),
          formatPaisa(r.overhead_cost_paisa), formatPaisa(r.total_cost_paisa), formatPaisa(r.cost_per_packet_paisa),
        ])
      );
    case 'outstanding':
      return toCsv(
        ['Customer', 'Type', 'State', 'Total Invoiced', 'Collected', 'Outstanding', '0-30 Days', '31-60 Days', '61+ Days'],
        rep.outstanding_ageing.map((r) => [
          r.customer_name, r.customer_type, r.state_name, formatPaisa(r.invoiced_paisa),
          formatPaisa(r.collected_paisa), formatPaisa(r.outstanding_paisa),
          formatPaisa(r.bucket_0_30_paisa), formatPaisa(r.bucket_31_60_paisa), formatPaisa(r.bucket_61_plus_paisa),
        ])
      );
    default:
      throw new Error(`Unknown export report type: ${reportType}`);
  }
}

/**
 * Stretch goal: Tally-compatible XML vouchers export for Sales Invoices.
 */
function generateTallyXml(db, filters) {
  const rep = getMonthlyReports(db, filters);
  const vouchers = rep.sales_register
    .filter((i) => i.status === 'POSTED')
    .map((inv) => {
      const dateXml = inv.invoice_date.replace(/-/g, '');
      const taxEntries = inv.is_interstate
        ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${formatPaisa(inv.igst_paisa)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
        : `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${formatPaisa(inv.cgst_paisa)}</AMOUNT></ALLLEDGERENTRIES.LIST>
           <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${formatPaisa(inv.sgst_paisa)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Sales" ACTION="Create">
          <DATE>${dateXml}</DATE>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <VOUCHERNUMBER>${inv.invoice_no}</VOUCHERNUMBER>
          <PARTYLEDGERNAME>${inv.customer_name}</PARTYLEDGERNAME>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>${inv.customer_name}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${formatPaisa(inv.total_paisa)}</AMOUNT></ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST><LEDGERNAME>Snack Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${formatPaisa(inv.taxable_paisa)}</AMOUNT></ALLLEDGERENTRIES.LIST>
          ${taxEntries}
        </VOUCHER>
      </TALLYMESSAGE>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${vouchers}</REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;
}

module.exports = {
  getMonthlyReports,
  getProductionPlanFromPendingOrders,
  generateCsvExport,
  generateTallyXml,
};
