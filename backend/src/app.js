const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');

const { getDb } = require('./db');
const { verifyPassword, signToken, requireAuth, requireRole, logAudit } = require('./auth');
const { formatPaisa, rupeesToPaisa, toMilliBase, milliToDisplay } = require('./math');
const {
  getFactorySettings,
  getInventorySummary,
  recordPurchase,
  startProductionRun,
  completeProductionRun,
  updateRunOverheads,
  getProductionRunById,
  createSalesOrder,
  getSalesOrderById,
  approveAndInvoiceOrder,
  rejectSalesOrder,
  recordDispatch,
  cancelInvoiceWithCreditNote,
  recordPayment,
  getInvoiceById,
} = require('./ledger');
const {
  getMonthlyReports,
  getProductionPlanFromPendingOrders,
  generateCsvExport,
  generateTallyXml,
} = require('./reports');
const { generateInvoicePdf, generateMonthlyReportPdf } = require('./pdf');
const { seedBenchmarkData } = require('../../database/seed');

function createApp(customDb = null) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const dbGetter = () => customDb || getDb();
  const auth = requireAuth(dbGetter);

  // Ensure DB is initialized & seeded on first boot if empty
  seedBenchmarkData(dbGetter(), { reset: false });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'order-to-audit-api' });
  });

  // Public demo accounts list (no secrets) for quick role login UI
  app.get('/api/auth/demo-users', (req, res) => {
    const db = dbGetter();
    const users = db
      .prepare('SELECT id, username, full_name, role, phone FROM users WHERE active = 1 ORDER BY id ASC')
      .all();
    res.json(users);
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const db = dbGetter();
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        phone: user.phone,
      },
    });
  });

  app.get('/api/auth/me', auth, (req, res) => {
    const db = dbGetter();
    res.json({
      user: req.user,
      settings: getFactorySettings(db),
    });
  });

  // Reset to clean Section 5 benchmark master data (for evaluator & demo replay)
  app.post('/api/demo/reset-seed', auth, (req, res) => {
    const db = dbGetter();
    const result = seedBenchmarkData(db, { reset: true });
    res.json({ ok: true, ...result });
  });

  // Role-filtered master data
  app.get('/api/masters', auth, (req, res) => {
    const db = dbGetter();
    const settings = getFactorySettings(db);
    const role = req.user.role;

    const customers =
      role === 'salesman'
        ? db
            .prepare(
              'SELECT * FROM customers WHERE active = 1 AND (assigned_salesman_id = ? OR assigned_salesman_id IS NULL) ORDER BY id ASC'
            )
            .all(req.user.id)
        : db.prepare('SELECT * FROM customers WHERE active = 1 ORDER BY id ASC').all();

    const inventory = getInventorySummary(db);
    const finishedGoods = inventory.filter((i) => i.item_type === 'finished_good');

    if (role === 'salesman') {
      return res.json({
        settings,
        customers,
        finished_goods: finishedGoods,
      });
    }

    const suppliers = db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY id ASC').all();
    const boms = db
      .prepare(
        `SELECT b.*, i.name AS finished_item_name, i.sku AS finished_sku, i.selling_price_paisa
         FROM boms b JOIN items i ON i.id = b.finished_item_id WHERE b.active = 1 ORDER BY b.id ASC`
      )
      .all()
      .map((b) => ({
        ...b,
        lines: db
          .prepare(
            `SELECT bl.*, i.name AS component_name, i.item_type, i.display_unit, i.display_factor_milli
             FROM bom_lines bl JOIN items i ON i.id = bl.component_item_id WHERE bl.bom_id = ?`
          )
          .all(b.id)
          .map((l) => ({
            ...l,
            qty_per_batch_display: milliToDisplay(l.qty_per_batch_milli, l.display_factor_milli),
          })),
      }));

    res.json({
      settings,
      customers,
      suppliers,
      items: inventory,
      finished_goods: finishedGoods,
      boms,
    });
  });

  // Add a product / pack size (also supports interview scenario: add 500g pack size sharing a BOM!)
  app.post('/api/masters/products', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const {
        sku,
        name,
        pack_size_g = 200,
        packets_per_carton = 20,
        hsn_code = '21069099',
        selling_price_rupees,
        gst_rate_pct = 5,
        copy_bom_from_item_id = null,
        scale_factor = 1,
      } = req.body || {};
      if (!sku || !name || !selling_price_rupees) {
        return res.status(400).json({ error: 'sku, name, and selling_price_rupees are required' });
      }
      const pricePaisa = rupeesToPaisa(selling_price_rupees);
      const gstBps = Math.round(Number(gst_rate_pct) * 100);
      const itemRes = db
        .prepare(
          `INSERT INTO items
           (sku, name, item_type, category, base_unit, display_unit, display_factor_milli, pack_size_g, packets_per_carton, hsn_code, selling_price_paisa, gst_rate_bps, reorder_level_milli, shelf_life_days)
           VALUES (?, ?, 'finished_good', 'Snacks', 'packet', 'packet', 1000, ?, ?, ?, ?, ?, 20000, 60)`
        )
        .run(
          String(sku).trim(),
          String(name).trim(),
          Number(pack_size_g),
          Number(packets_per_carton),
          hsn_code,
          pricePaisa,
          gstBps
        );
      const newItemId = Number(itemRes.lastInsertRowid);

      if (copy_bom_from_item_id) {
        const srcBom = db
          .prepare('SELECT * FROM boms WHERE finished_item_id = ? AND active = 1 LIMIT 1')
          .get(copy_bom_from_item_id);
        if (srcBom) {
          const factor = Number(scale_factor || 1);
          const expectedPkts = Math.max(1, Math.round(srcBom.batch_size_packets / factor));
          const newBomId = Number(
            db
              .prepare('INSERT INTO boms (finished_item_id, version, batch_size_packets, notes) VALUES (?, 1, ?, ?)')
              .run(newItemId, expectedPkts, `Scaled from BOM #${srcBom.id} (factor ${factor}x)`).lastInsertRowid
          );
          const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id = ?').all(srcBom.id);
          for (const l of lines) {
            db.prepare(
              'INSERT INTO bom_lines (bom_id, component_item_id, qty_per_batch_milli, input_unit, notes) VALUES (?, ?, ?, ?, ?)'
            ).run(newBomId, l.component_item_id, l.qty_per_batch_milli, l.input_unit, l.notes);
          }
        }
      }

      logAudit(db, {
        entityType: 'item',
        entityId: newItemId,
        entityRef: sku,
        action: 'CREATE_PRODUCT',
        user: req.user,
        after: { sku, name, pack_size_g, selling_price_paisa: pricePaisa },
      });

      res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(newItemId));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/masters/customers', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { code, name, customer_type, gstin, state_name, state_code, address, phone, assigned_salesman_id } =
        req.body || {};
      if (!code || !name || !customer_type || !state_name || !state_code) {
        return res.status(400).json({ error: 'code, name, customer_type, state_name, state_code are required' });
      }
      const r = db
        .prepare(
          `INSERT INTO customers (code, name, customer_type, gstin, state_name, state_code, address, phone, assigned_salesman_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(code, name, customer_type, gstin || null, state_name, state_code, address || '', phone || '', assigned_salesman_id || null);
      res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid)));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Inventory
  app.get('/api/inventory', auth, requireRole('admin', 'production', 'owner', 'auditor'), (req, res) => {
    const db = dbGetter();
    res.json(getInventorySummary(db));
  });

  // Purchases
  app.get('/api/purchases', auth, requireRole('admin', 'production', 'owner', 'auditor'), (req, res) => {
    const db = dbGetter();
    const list = db
      .prepare(
        `SELECT p.*, s.name AS supplier_name, u.full_name AS created_by_name
         FROM purchases p
         JOIN suppliers s ON s.id = p.supplier_id
         JOIN users u ON u.id = p.created_by
         ORDER BY p.id DESC`
      )
      .all()
      .map((p) => ({
        ...p,
        items: db
          .prepare(
            `SELECT pi.*, i.name AS item_name, i.display_factor_milli
             FROM purchase_items pi JOIN items i ON i.id = pi.item_id WHERE pi.purchase_id = ?`
          )
          .all(p.id)
          .map((it) => ({ ...it, qty_display: milliToDisplay(it.qty_milli, it.display_factor_milli) })),
      }));
    res.json(list);
  });

  app.post('/api/purchases', auth, requireRole('admin', 'production'), (req, res) => {
    try {
      const db = dbGetter();
      const { supplier_id, supplier_bill_no, purchase_date, items, notes } = req.body || {};
      const created = recordPurchase(db, {
        supplierId: Number(supplier_id),
        supplierBillNo: supplier_bill_no,
        purchaseDate: purchase_date,
        items,
        notes,
        user: req.user,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Production Runs
  app.get('/api/production/runs', auth, requireRole('production', 'admin', 'owner', 'auditor'), (req, res) => {
    const db = dbGetter();
    const ids = db.prepare('SELECT id FROM production_runs ORDER BY id DESC').all();
    res.json(ids.map((r) => getProductionRunById(db, r.id)));
  });

  app.post('/api/production/runs/start', auth, requireRole('production', 'admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { bom_id, batch_multiplier = 1, run_date, issued_materials = [], batch_no, expiry_date, notes } =
        req.body || {};
      const run = startProductionRun(db, {
        bomId: Number(bom_id),
        batchMultiplier: Number(batch_multiplier),
        runDate: run_date,
        issuedMaterials: issued_materials,
        batchNo: batch_no,
        expiryDate: expiry_date,
        notes,
        user: req.user,
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/production/runs/:id/complete', auth, requireRole('production', 'admin'), (req, res) => {
    try {
      const db = dbGetter();
      const {
        actual_good_packets,
        wastage_packets = 0,
        packaging_used = [],
        damaged_pouches = 0,
        cartons_used = null,
        labour_cost_rupees = 0,
        overhead_cost_rupees = 0,
        notes,
      } = req.body || {};
      const run = completeProductionRun(db, Number(req.params.id), {
        actualGoodPackets: actual_good_packets,
        wastagePackets: wastage_packets,
        packagingUsed: packaging_used,
        damagedPouches: damaged_pouches,
        cartonsUsed: cartons_used,
        labourCostRupees: labour_cost_rupees,
        overheadCostRupees: overhead_cost_rupees,
        notes,
        user: req.user,
      });
      res.json(run);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/production/runs/:id/overheads', auth, requireRole('production', 'admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { labour_cost_rupees, overhead_cost_rupees, notes } = req.body || {};
      const run = updateRunOverheads(db, Number(req.params.id), {
        labourCostRupees: labour_cost_rupees,
        overheadCostRupees: overhead_cost_rupees,
        notes,
        user: req.user,
      });
      res.json(run);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Sales Orders
  app.get('/api/orders', auth, requireRole('salesman', 'admin', 'owner', 'auditor'), (req, res) => {
    const db = dbGetter();
    const rows =
      req.user.role === 'salesman'
        ? db.prepare('SELECT id FROM sales_orders WHERE salesman_id = ? ORDER BY id DESC').all(req.user.id)
        : db.prepare('SELECT id FROM sales_orders ORDER BY id DESC').all();
    res.json(rows.map((r) => getSalesOrderById(db, r.id)));
  });

  app.post('/api/orders', auth, requireRole('salesman', 'admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { customer_id, items, order_date, client_offline_id, notes } = req.body || {};
      const order = createSalesOrder(db, {
        customerId: Number(customer_id),
        salesmanUser: req.user,
        items,
        orderDate: order_date,
        clientOfflineId: client_offline_id,
        notes,
      });
      res.status(201).json(order);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/orders/sync-batch', auth, requireRole('salesman'), (req, res) => {
    try {
      const db = dbGetter();
      const { orders = [] } = req.body || {};
      const synced = orders.map((o) =>
        createSalesOrder(db, {
          customerId: Number(o.customer_id),
          salesmanUser: req.user,
          items: o.items,
          orderDate: o.order_date,
          clientOfflineId: o.client_offline_id,
          notes: o.notes,
        })
      );
      res.json({ synced_count: synced.length, orders: synced });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/orders/:id/approve', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { edited_items = null, invoice_date = null, allow_backorder = false } = req.body || {};
      const invoice = approveAndInvoiceOrder(db, Number(req.params.id), {
        editedItems: edited_items,
        invoiceDate: invoice_date,
        allowBackorder: Boolean(allow_backorder),
        user: req.user,
      });
      res.status(201).json(invoice);
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message, details: err.details || null });
    }
  });

  app.post('/api/orders/:id/reject', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { reason } = req.body || {};
      const order = rejectSalesOrder(db, Number(req.params.id), { reason, user: req.user });
      res.json(order);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Invoices & Dispatches
  app.get('/api/invoices', auth, requireRole('admin', 'owner', 'auditor', 'salesman'), (req, res) => {
    const db = dbGetter();
    const rows =
      req.user.role === 'salesman'
        ? db
            .prepare(
              `SELECT inv.id FROM invoices inv
               JOIN sales_orders so ON so.id = inv.order_id
               WHERE so.salesman_id = ? ORDER BY inv.id DESC`
            )
            .all(req.user.id)
        : db.prepare('SELECT id FROM invoices ORDER BY id DESC').all();
    res.json(rows.map((r) => getInvoiceById(db, r.id)));
  });

  app.get('/api/invoices/:id', auth, requireRole('admin', 'owner', 'auditor', 'salesman'), (req, res) => {
    const db = dbGetter();
    const inv = getInvoiceById(db, Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(inv);
  });

  app.get('/api/invoices/:id/pdf', auth, requireRole('admin', 'owner', 'auditor', 'salesman'), (req, res) => {
    const db = dbGetter();
    const inv = getInvoiceById(db, Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const factory = getFactorySettings(db);
    const pdfBuffer = generateInvoicePdf(inv, factory);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoice_no.replace(/\//g, '_')}.pdf"`);
    res.send(pdfBuffer);
  });

  app.post('/api/invoices/:id/dispatch', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { items = null, dispatch_date, vehicle_or_lr, notes } = req.body || {};
      const updated = recordDispatch(db, Number(req.params.id), {
        items,
        dispatchDate: dispatch_date,
        vehicleOrLr: vehicle_or_lr,
        notes,
        user: req.user,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/invoices/:id/credit-note', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { reason, restock_goods = false } = req.body || {};
      const updated = cancelInvoiceWithCreditNote(db, Number(req.params.id), {
        reason,
        restockGoods: Boolean(restock_goods),
        user: req.user,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Payments
  app.get('/api/payments', auth, requireRole('admin', 'owner', 'auditor'), (req, res) => {
    const db = dbGetter();
    const rows = db
      .prepare(
        `SELECT pay.*, c.name AS customer_name, inv.invoice_no
         FROM payments pay
         JOIN customers c ON c.id = pay.customer_id
         LEFT JOIN invoices inv ON inv.id = pay.invoice_id
         ORDER BY pay.id DESC`
      )
      .all();
    res.json(rows);
  });

  app.post('/api/payments', auth, requireRole('admin'), (req, res) => {
    try {
      const db = dbGetter();
      const { customer_id, invoice_id = null, amount_rupees, payment_date, payment_mode, reference_no, notes } =
        req.body || {};
      const pay = recordPayment(db, {
        customerId: Number(customer_id),
        invoiceId: invoice_id ? Number(invoice_id) : null,
        amountRupees: amount_rupees,
        paymentDate: payment_date,
        paymentMode: payment_mode,
        referenceNo: reference_no,
        notes,
        user: req.user,
      });
      res.status(201).json(pay);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Salesman visits (stretch goal)
  app.get('/api/visits', auth, requireRole('salesman', 'admin', 'owner'), (req, res) => {
    const db = dbGetter();
    const rows =
      req.user.role === 'salesman'
        ? db
            .prepare(
              `SELECT v.*, c.name AS customer_name FROM salesman_visits v JOIN customers c ON c.id = v.customer_id WHERE v.salesman_id = ? ORDER BY v.id DESC`
            )
            .all(req.user.id)
        : db
            .prepare(
              `SELECT v.*, c.name AS customer_name, u.full_name AS salesman_name FROM salesman_visits v JOIN customers c ON c.id = v.customer_id JOIN users u ON u.id = v.salesman_id ORDER BY v.id DESC`
            )
            .all();
    res.json(rows);
  });

  app.post('/api/visits', auth, requireRole('salesman'), (req, res) => {
    const db = dbGetter();
    const { customer_id, outcome = 'Order Taken', latitude = null, longitude = null, notes = '' } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
    const r = db
      .prepare(
        'INSERT INTO salesman_visits (salesman_id, customer_id, outcome, latitude, longitude, notes) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(req.user.id, Number(customer_id), outcome, latitude, longitude, notes);
    res.status(201).json(db.prepare('SELECT * FROM salesman_visits WHERE id = ?').get(Number(r.lastInsertRowid)));
  });

  // Owner summary & Production planner
  app.get('/api/dashboard/owner', auth, requireRole('owner', 'admin', 'auditor'), (req, res) => {
    const db = dbGetter();
    const rep = getMonthlyReports(db, {});
    const today = new Date().toISOString().slice(0, 10);
    const todayOrders = db
      .prepare("SELECT COUNT(*) AS cnt FROM sales_orders WHERE order_date = ? OR date(created_at) = date('now')")
      .get().cnt;
    const pendingOrders = db
      .prepare("SELECT COUNT(*) AS cnt FROM sales_orders WHERE status = 'SUBMITTED'")
      .get().cnt;

    const totalOutstandingPaisa = rep.outstanding_ageing.reduce((acc, r) => acc + r.outstanding_paisa, 0);
    const totalSalesPaisa = rep.sales_register
      .filter((i) => i.status === 'POSTED')
      .reduce((acc, i) => acc + i.total_paisa, 0);
    const varianceAlerts = rep.production_report.filter((r) => r.has_variance_alert);
    const lowStockItems = rep.stock_summary.filter((i) => i.is_low_stock);
    const productionPlan = getProductionPlanFromPendingOrders(db);

    res.json({
      date: today,
      kpis: {
        today_orders: todayOrders,
        pending_orders: pendingOrders,
        total_sales_paisa: totalSalesPaisa,
        total_outstanding_paisa: totalOutstandingPaisa,
        variance_alert_count: varianceAlerts.length,
        low_stock_count: lowStockItems.length,
      },
      stock_summary: rep.stock_summary,
      low_stock_items: lowStockItems,
      variance_alerts: varianceAlerts,
      production_runs: rep.production_report,
      outstanding_ageing: rep.outstanding_ageing,
      production_plan: productionPlan,
    });
  });

  app.get('/api/reports/production-plan', auth, requireRole('production', 'admin', 'owner'), (req, res) => {
    res.json(getProductionPlanFromPendingOrders(dbGetter()));
  });

  // Monthly Auditor Reports & Exports
  app.get('/api/reports/monthly', auth, requireRole('auditor', 'admin', 'owner'), (req, res) => {
    const db = dbGetter();
    const { fromDate = '', toDate = '' } = req.query;
    res.json(getMonthlyReports(db, { fromDate, toDate }));
  });

  app.get('/api/reports/export/:type/csv', auth, requireRole('auditor', 'admin', 'owner'), (req, res) => {
    try {
      const db = dbGetter();
      const { fromDate = '', toDate = '' } = req.query;
      const csv = generateCsvExport(db, req.params.type, { fromDate, toDate });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-report.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/reports/export/tally/xml', auth, requireRole('auditor', 'admin', 'owner'), (req, res) => {
    const db = dbGetter();
    const { fromDate = '', toDate = '' } = req.query;
    const xml = generateTallyXml(db, { fromDate, toDate });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tally-sales-vouchers.xml"');
    res.send(xml);
  });

  app.get('/api/reports/export/monthly/pdf', auth, requireRole('auditor', 'admin', 'owner'), (req, res) => {
    const db = dbGetter();
    const { fromDate = '', toDate = '' } = req.query;
    const rep = getMonthlyReports(db, { fromDate, toDate });
    const pdfBuffer = generateMonthlyReportPdf({
      title: 'Monthly Audit & Compliance Pack',
      subtitle: fromDate || toDate ? `Period: ${fromDate || 'Start'} to ${toDate || 'Now'}` : 'All Recorded Transactions',
      factory: rep.settings,
      sections: [
        {
          heading: '1. Sales & GST Register',
          columns: [
            { x: 40, label: 'Invoice', max: 16 },
            { x: 125, label: 'Date', max: 11 },
            { x: 185, label: 'Customer', max: 22 },
            { x: 315, label: 'Taxable', max: 12 },
            { x: 380, label: 'GST', max: 12 },
            { x: 440, label: 'Total', max: 12 },
            { x: 500, label: 'Due', max: 12 },
          ],
          rows: rep.sales_register.map((r) => [
            r.invoice_no,
            r.invoice_date,
            r.customer_name,
            `Rs.${formatPaisa(r.taxable_paisa)}`,
            `Rs.${formatPaisa(r.cgst_paisa + r.sgst_paisa + r.igst_paisa)}`,
            `Rs.${formatPaisa(r.total_paisa)}`,
            `Rs.${formatPaisa(r.outstanding_paisa)}`,
          ]),
        },
        {
          heading: '2. Closing Stock Summary (Ledger Derived)',
          columns: [
            { x: 40, label: 'SKU', max: 14 },
            { x: 120, label: 'Item Name', max: 26 },
            { x: 265, label: 'Type', max: 14 },
            { x: 345, label: 'Opening', max: 10 },
            { x: 400, label: 'In', max: 10 },
            { x: 450, label: 'Out', max: 10 },
            { x: 500, label: 'Closing', max: 12 },
          ],
          rows: rep.stock_summary.map((s) => [
            s.sku,
            s.name,
            s.item_type,
            `${s.opening_display} ${s.display_unit}`,
            `${s.receipts_display}`,
            `${s.issues_display}`,
            `${s.balance_display} ${s.display_unit}`,
          ]),
        },
        {
          heading: '3. Production Variance & Costing',
          columns: [
            { x: 40, label: 'Run No', max: 16 },
            { x: 125, label: 'Product', max: 20 },
            { x: 245, label: 'Exp/Act', max: 14 },
            { x: 320, label: 'Yield Var', max: 12 },
            { x: 390, label: 'Total Cost', max: 14 },
            { x: 475, label: 'Cost/Pkt', max: 12 },
          ],
          rows: rep.production_report.map((r) => [
            r.run_no,
            r.finished_item_name,
            `${r.expected_packets} / ${r.actual_good_packets}`,
            `${(r.yield_variance_bps / 100).toFixed(2)}%`,
            `Rs.${formatPaisa(r.total_cost_paisa)}`,
            `Rs.${formatPaisa(r.cost_per_packet_paisa)}`,
          ]),
        },
      ],
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="monthly-audit-report.pdf"');
    res.send(pdfBuffer);
  });

  app.get('/api/audit-logs', auth, requireRole('auditor', 'admin', 'owner'), (req, res) => {
    const db = dbGetter();
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all();
    res.json(rows);
  });

  // Serve built frontend in single-command production mode if dist/ exists
  const distDir = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

module.exports = { createApp };
