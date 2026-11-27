const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../src/db');
const { seedBenchmarkData } = require('../../database/seed');
const {
  toMilliBase,
  milliToDisplay,
  computeGstLine,
  computeVarianceBps,
  rupeesToPaisa,
  formatPaisa,
} = require('../src/math');
const {
  getItemBalanceMilli,
  recordPurchase,
  startProductionRun,
  completeProductionRun,
  updateRunOverheads,
  createSalesOrder,
  approveAndInvoiceOrder,
  recordDispatch,
  cancelInvoiceWithCreditNote,
  recordPayment,
  getInvoiceById,
} = require('../src/ledger');
const { getMonthlyReports } = require('../src/reports');
const { generateInvoicePdf } = require('../src/pdf');

test('Unit conversions and integer-paisa GST arithmetic have zero float drift', () => {
  const flour = { name: 'Flour', base_unit: 'g', display_unit: 'kg', packets_per_carton: 1 };
  assert.equal(toMilliBase('40', 'kg', flour), 40000000);
  assert.equal(toMilliBase('500', 'g', flour), 500000);
  assert.equal(toMilliBase('1.2', 'kg', flour), 1200000);

  const murukku = { name: 'Murukku 200 g', base_unit: 'packet', display_unit: 'packet', packets_per_carton: 20 };
  assert.equal(toMilliBase(9, 'carton', murukku), 180000);
  assert.equal(rupeesToPaisa('187.50'), 18750);
  assert.equal(formatPaisa(787500), '7875.00');

  const intra = computeGstLine({ qtyPackets: 150, unitPricePaisa: 5000, gstRateBps: 500, isInterstate: false });
  assert.deepEqual(intra, {
    taxablePaisa: 750000,
    cgstPaisa: 18750,
    sgstPaisa: 18750,
    igstPaisa: 0,
    totalPaisa: 787500,
  });

  const inter = computeGstLine({ qtyPackets: 120, unitPricePaisa: 5000, gstRateBps: 500, isInterstate: true });
  assert.deepEqual(inter, {
    taxablePaisa: 600000,
    cgstPaisa: 0,
    sgstPaisa: 0,
    igstPaisa: 30000,
    totalPaisa: 630000,
  });

  assert.equal(computeVarianceBps(188, 200), -600);
  assert.equal(computeVarianceBps(10500000, 10000000), 500);
});

test('Full Section 5 Benchmark Scenario end-to-end verification', () => {
  const db = createDatabase(':memory:');
  const seedInfo = seedBenchmarkData(db, { reset: true });

  const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  const supervisor = db.prepare("SELECT * FROM users WHERE username = 'supervisor'").get();
  const salesmanA = db.prepare("SELECT * FROM users WHERE username = 'salesman_a'").get();
  const salesmanB = db.prepare("SELECT * FROM users WHERE username = 'salesman_b'").get();

  const supplier = db.prepare("SELECT * FROM suppliers WHERE code = 'SUP-MILL-01'").get();
  const retailerA = db.prepare("SELECT * FROM customers WHERE code = 'CUST-RET-A'").get();
  const distributorB = db.prepare("SELECT * FROM customers WHERE code = 'CUST-DIST-B'").get();

  const flour = db.prepare("SELECT * FROM items WHERE sku = 'RM-FLOUR'").get();
  const oil = db.prepare("SELECT * FROM items WHERE sku = 'RM-OIL'").get();
  const spice = db.prepare("SELECT * FROM items WHERE sku = 'RM-SPICE'").get();
  const pouch = db.prepare("SELECT * FROM items WHERE sku = 'PKG-POUCH-200'").get();
  const carton = db.prepare("SELECT * FROM items WHERE sku = 'PKG-CTN-20'").get();
  const murukku = db.prepare("SELECT * FROM items WHERE sku = 'FG-MUR-200'").get();

  // Step 1: Record purchase of 60 kg flour at Rs 45/kg
  recordPurchase(db, {
    supplierId: supplier.id,
    supplierBillNo: 'BILL-101',
    purchaseDate: '2026-11-27',
    items: [{ item_id: flour.id, qty: 60, unit: 'kg', rate_rupees: 45 }],
    user: admin,
  });
  assert.equal(milliToDisplay(getItemBalanceMilli(db, flour.id), flour.display_factor_milli), 160);

  // Step 2: Start production run of Murukku 200 g (40 kg flour, 10.5 L oil, 1.2 kg spice mix)
  const startedRun = startProductionRun(db, {
    bomId: seedInfo.bom_id,
    batchMultiplier: 1,
    runDate: '2026-11-27',
    issuedMaterials: [
      { item_id: flour.id, qty: 40, unit: 'kg' },
      { item_id: oil.id, qty: 10.5, unit: 'L' },
      { item_id: spice.id, qty: 1.2, unit: 'kg' },
    ],
    user: supervisor,
  });

  // Step 3: Record actual output: 188 good packets, 6 pouches damaged, 9 cartons used
  const completedRun = completeProductionRun(db, startedRun.id, {
    actualGoodPackets: 188,
    wastagePackets: 12,
    damagedPouches: 6,
    cartonsUsed: 9,
    user: supervisor,
  });

  // Verify raw material, packaging, finished goods balances & variances
  assert.equal(milliToDisplay(getItemBalanceMilli(db, flour.id), flour.display_factor_milli), 120); // 100 + 60 - 40
  assert.equal(milliToDisplay(getItemBalanceMilli(db, oil.id), oil.display_factor_milli), 19.5); // 30 - 10.5
  assert.equal(milliToDisplay(getItemBalanceMilli(db, spice.id), spice.display_factor_milli), 3.8); // 5 - 1.2
  assert.equal(milliToDisplay(getItemBalanceMilli(db, pouch.id), pouch.display_factor_milli), 306); // 500 - (188 + 6)
  assert.equal(milliToDisplay(getItemBalanceMilli(db, carton.id), carton.display_factor_milli), 21); // 30 - 9
  assert.equal(milliToDisplay(getItemBalanceMilli(db, murukku.id), murukku.display_factor_milli), 238); // 50 + 188

  assert.equal(completedRun.yield_variance_bps, -600); // -6%
  assert.equal(completedRun.has_variance_alert, 1);
  const oilCons = completedRun.consumptions.find((c) => c.item_id === oil.id);
  assert.equal(oilCons.variance_bps, 500); // +5%
  assert.equal(oilCons.is_flagged, 1);

  // Step 4: Salesman A places order for Retailer A (Tamil Nadu): 150 packets
  const orderA = createSalesOrder(db, {
    customerId: retailerA.id,
    salesmanUser: salesmanA,
    items: [{ item_id: murukku.id, qty_packets: 150 }],
    orderDate: '2026-11-27',
    clientOfflineId: 'offline-test-001',
  });
  // Idempotent offline sync check
  const orderADup = createSalesOrder(db, {
    customerId: retailerA.id,
    salesmanUser: salesmanA,
    items: [{ item_id: murukku.id, qty_packets: 150 }],
    orderDate: '2026-11-27',
    clientOfflineId: 'offline-test-001',
  });
  assert.equal(orderA.id, orderADup.id);

  // Step 5: Admin approves, raises GST invoice (CGST + SGST), records dispatch
  const invoiceA = approveAndInvoiceOrder(db, orderA.id, { invoiceDate: '2026-11-27', user: admin });
  assert.equal(invoiceA.is_interstate, 0);
  assert.equal(invoiceA.taxable_paisa, 750000); // Rs 7,500
  assert.equal(invoiceA.cgst_paisa, 18750); // Rs 187.50
  assert.equal(invoiceA.sgst_paisa, 18750); // Rs 187.50
  assert.equal(invoiceA.igst_paisa, 0);
  assert.equal(invoiceA.total_paisa, 787500); // Rs 7,875

  const dispatchedInvA = recordDispatch(db, invoiceA.id, { dispatchDate: '2026-11-27', user: admin });
  assert.equal(dispatchedInvA.dispatch_status, 'DISPATCHED');
  assert.equal(milliToDisplay(getItemBalanceMilli(db, murukku.id), murukku.display_factor_milli), 88); // 238 - 150

  // Verify PDF generation produces valid PDF header & trailer
  const pdfBuf = generateInvoicePdf(dispatchedInvA, db.prepare('SELECT * FROM factory_settings WHERE id = 1').get());
  assert.ok(pdfBuf.toString('latin1').startsWith('%PDF-1.4'));
  assert.ok(pdfBuf.toString('latin1').includes('%%EOF'));

  // Step 6: Salesman B places order for Distributor B (Karnataka): 120 packets -> shortage 32 flagged, IGST applies
  const orderB = createSalesOrder(db, {
    customerId: distributorB.id,
    salesmanUser: salesmanB,
    items: [{ item_id: murukku.id, qty_packets: 120 }],
    orderDate: '2026-11-27',
  });
  assert.equal(orderB.stock_check.all_sufficient, false);
  assert.equal(orderB.items[0].shortage_packets, 32);
  assert.equal(orderB.stock_check.is_interstate, true);
  assert.equal(orderB.stock_check.tax_type, 'IGST');
  assert.equal(orderB.stock_check.igst_paisa, 30000);

  assert.throws(
    () => approveAndInvoiceOrder(db, orderB.id, { user: admin }),
    (err) => err.statusCode === 409 && /short by 32 packets/i.test(err.message)
  );

  // Step 7: Record payment of Rs 4,000 from Retailer A -> Outstanding Rs 3,875
  recordPayment(db, {
    customerId: retailerA.id,
    invoiceId: invoiceA.id,
    amountRupees: 4000,
    paymentDate: '2026-11-27',
    paymentMode: 'NEFT',
    user: admin,
  });
  const invAfterPay = getInvoiceById(db, invoiceA.id);
  assert.equal(invAfterPay.paid_paisa, 400000);
  assert.equal(invAfterPay.outstanding_paisa, 387500); // Rs 3,875

  // Step 8: Add labour Rs 1,200 + gas/power Rs 600 -> verify FIFO cost per packet
  // Materials: 40kg flour*42 (1680) + 10.5L oil*140 (1470) + 1.2kg spice*200 (240) + 194 pouches*2.50 (485) + 9 cartons*15 (135) = 4010
  // Overheads: 1200 + 600 = 1800 -> Total = 5810 -> 581000 / 188 = 3090 paisa (Rs 30.90/pkt)
  const finalRun = updateRunOverheads(db, completedRun.id, {
    labourCostRupees: 1200,
    overheadCostRupees: 600,
    user: supervisor,
  });
  assert.equal(finalRun.material_cost_paisa, 401000);
  assert.equal(finalRun.total_cost_paisa, 581000);
  assert.equal(finalRun.cost_per_packet_paisa, 3090);

  // Step 9: Generate monthly reports & verify audit trail
  const reports = getMonthlyReports(db, {});
  assert.equal(reports.sales_register.length, 1);
  assert.equal(reports.gst_summary.buckets.length, 1);
  assert.equal(reports.purchase_register.length, 1);
  assert.equal(reports.production_report.length, 1);
  assert.equal(reports.outstanding_ageing.find((c) => c.customer_id === retailerA.id).outstanding_paisa, 387500);

  // Audit check: Credit note cancellation never deletes invoice
  const cancelled = cancelInvoiceWithCreditNote(db, invoiceA.id, {
    reason: 'Test credit note',
    restockGoods: true,
    user: admin,
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.credit_notes.length, 1);
  assert.equal(milliToDisplay(getItemBalanceMilli(db, murukku.id), murukku.display_factor_milli), 238); // 88 + 150 restocked
});
