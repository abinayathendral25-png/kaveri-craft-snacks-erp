const { hashPassword } = require('../backend/src/auth');
const { withTransaction } = require('../backend/src/db');
const { toMilliBase, computeCostPaisa } = require('../backend/src/math');

/**
 * Reset and seed the database with Section 5 Master Data + demo users & sample catalog.
 */
function seedBenchmarkData(db, { reset = true } = {}) {
  return withTransaction(db, () => {
    if (reset) {
      const tables = [
        'audit_logs',
        'salesman_visits',
        'payments',
        'dispatch_items',
        'dispatches',
        'credit_notes',
        'invoice_items',
        'invoices',
        'sales_order_items',
        'sales_orders',
        'production_consumptions',
        'production_runs',
        'stock_ledger',
        'stock_lots',
        'purchase_items',
        'purchases',
        'bom_lines',
        'boms',
        'items',
        'suppliers',
        'customers',
        'factory_settings',
        'users',
      ];
      for (const t of tables) {
        db.exec(`DELETE FROM ${t};`);
      }
      db.exec('DELETE FROM sqlite_sequence;');
    } else {
      const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
      if (userCount > 0) return { seeded: false, reason: 'Database already populated' };
    }

    // 1. Factory settings (Tamil Nadu, code 33)
    db.prepare(
      `INSERT INTO factory_settings (id, company_name, gstin, state_name, state_code, address, phone, variance_tolerance_bps, financial_year, valuation_method, overhead_rule)
       VALUES (1, ?, ?, ?, ?, ?, ?, 300, '2026-27', 'FIFO', ?)`
    ).run(
      'Kaveri Craft Snacks Pvt Ltd',
      '33AABCK4512F1Z8',
      'Tamil Nadu',
      '33',
      'Plot 14, SIDCO Industrial Estate, Tiruchirappalli - 620015',
      '+91 431 245 8890',
      'Direct batch allocation: (Labour + Gas/Power) divided by actual good packets produced'
    );

    // 2. Demo Users for all 5 roles
    const demoPass = hashPassword('demo123');
    const insertUser = db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, phone) VALUES (?, ?, ?, ?, ?)'
    );
    const salesmanAId = Number(insertUser.run('salesman_a', demoPass, 'Karthik (Salesman A)', 'salesman', '9842100001').lastInsertRowid);
    const salesmanBId = Number(insertUser.run('salesman_b', demoPass, 'Suresh (Salesman B)', 'salesman', '9842100002').lastInsertRowid);
    const adminId = Number(insertUser.run('admin', demoPass, 'Meenakshi (Factory Admin)', 'admin', '9842100003').lastInsertRowid);
    insertUser.run('supervisor', demoPass, 'Arun (Production Supervisor)', 'production', '9842100004');
    insertUser.run('auditor', demoPass, 'CA Sundaram (Auditor)', 'auditor', '9842100005');
    insertUser.run('owner', demoPass, 'Raghavan (Owner)', 'owner', '9842100006');

    // 3. Customers (Retailer A in Tamil Nadu, Distributor B in Karnataka, plus extra realistic customers)
    const insertCust = db.prepare(
      `INSERT INTO customers (code, name, customer_type, gstin, state_name, state_code, address, phone, assigned_salesman_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertCust.run(
      'CUST-RET-A',
      'Retailer A (Sri Murugan Stores)',
      'retailer',
      '33AAACS1122B1Z4',
      'Tamil Nadu',
      '33',
      '22 Big Bazaar Street, Tiruchirappalli, TN',
      '9842111111',
      salesmanAId
    );
    insertCust.run(
      'CUST-DIST-B',
      'Distributor B (Deccan Foods)',
      'distributor',
      '29AABFD7788K1Z2',
      'Karnataka',
      '29',
      '45 Yeshwanthpur APMC Yard, Bengaluru, KA',
      '9880222222',
      salesmanBId
    );
    insertCust.run(
      'CUST-RET-C',
      'Annapoorna Super Market',
      'retailer',
      '33AADCA9981E1Z7',
      'Tamil Nadu',
      '33',
      '88 RS Puram, Coimbatore, TN',
      '9843333333',
      salesmanAId
    );

    // 4. Suppliers
    const insertSup = db.prepare(
      'INSERT INTO suppliers (code, name, gstin, state_name, state_code, phone, address) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertSup.run(
      'SUP-MILL-01',
      'Cauvery Agro Mills & Traders',
      '33AABCC9081L1Z1',
      'Tamil Nadu',
      '33',
      '9443012345',
      'Thanjavur Main Road, Tiruchirappalli, TN'
    );
    insertSup.run(
      'SUP-PKG-01',
      'Madras Flexo Pack Pvt Ltd',
      '33AAACF4410M1Z9',
      'Tamil Nadu',
      '33',
      '9444054321',
      'Ambattur Industrial Estate, Chennai, TN'
    );

    // 5. Items (Raw materials, Packaging, Finished goods)
    const insertItem = db.prepare(
      `INSERT INTO items
       (sku, name, item_type, category, base_unit, display_unit, display_factor_milli, pack_size_g, packets_per_carton, hsn_code, selling_price_paisa, gst_rate_bps, reorder_level_milli, shelf_life_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const flourId = Number(insertItem.run('RM-FLOUR', 'Flour (Rice & Besan Mix)', 'raw_material', 'Grains & Flours', 'g', 'kg', 1000000, 0, 1, '11029090', 0, 0, 50000000, 120).lastInsertRowid);
    const oilId = Number(insertItem.run('RM-OIL', 'Cooking oil', 'raw_material', 'Edible Oils', 'ml', 'L', 1000000, 0, 1, '15121910', 0, 0, 15000000, 180).lastInsertRowid);
    const spiceId = Number(insertItem.run('RM-SPICE', 'Salt and spice mix', 'raw_material', 'Spices & Seasoning', 'g', 'kg', 1000000, 0, 1, '09109100', 0, 0, 2000000, 180).lastInsertRowid);
    const pouchId = Number(insertItem.run('PKG-POUCH-200', '200 g pouch', 'packaging', 'Pouches', 'piece', 'piece', 1000, 0, 1, '39232990', 0, 0, 150000, 365).lastInsertRowid);
    const cartonId = Number(insertItem.run('PKG-CTN-20', 'Carton (holds 20 packets)', 'packaging', 'Cartons', 'piece', 'piece', 1000, 0, 20, '48191010', 0, 0, 10000, 365).lastInsertRowid);

    const murukkuId = Number(insertItem.run('FG-MUR-200', 'Murukku 200 g', 'finished_good', 'Snacks', 'packet', 'packet', 1000, 200, 20, '21069099', 5000, 500, 40000, 60).lastInsertRowid);
    const mixtureId = Number(insertItem.run('FG-MIX-200', 'Madras Mixture 200 g', 'finished_good', 'Snacks', 'packet', 'packet', 1000, 200, 20, '21069099', 6000, 500, 30000, 60).lastInsertRowid);
    const chipsId = Number(insertItem.run('FG-CHP-200', 'Banana Chips 200 g', 'finished_good', 'Snacks', 'packet', 'packet', 1000, 200, 20, '20081940', 7000, 500, 30000, 45).lastInsertRowid);

    // 6. BOMs
    const insertBom = db.prepare(
      'INSERT INTO boms (finished_item_id, version, batch_size_packets, notes) VALUES (?, 1, ?, ?)'
    );
    const insertBomLine = db.prepare(
      'INSERT INTO bom_lines (bom_id, component_item_id, qty_per_batch_milli, input_unit, notes) VALUES (?, ?, ?, ?, ?)'
    );

    // Benchmark BOM for Murukku 200 g: 1 batch = 200 packets
    const murBomId = Number(insertBom.run(murukkuId, 200, 'Standard 200-packet Murukku 200g recipe').lastInsertRowid);
    insertBomLine.run(murBomId, flourId, 40000000, 'kg', '40 kg flour per batch');
    insertBomLine.run(murBomId, oilId, 10000000, 'L', '10 L cooking oil per batch');
    insertBomLine.run(murBomId, spiceId, 1200000, 'kg', '1.2 kg salt and spice mix per batch');
    insertBomLine.run(murBomId, pouchId, 200000, 'piece', '200 pouches per batch');
    insertBomLine.run(murBomId, cartonId, 10000, 'piece', '10 cartons (20 pkts each) per batch');

    // Bonus BOM for Madras Mixture 200 g: 1 batch = 150 packets
    const mixBomId = Number(insertBom.run(mixtureId, 150, 'Standard 150-packet Madras Mixture recipe').lastInsertRowid);
    insertBomLine.run(mixBomId, flourId, 25000000, 'kg', '25 kg besan/rice flour');
    insertBomLine.run(mixBomId, oilId, 8000000, 'L', '8 L cooking oil');
    insertBomLine.run(mixBomId, spiceId, 1500000, 'kg', '1.5 kg spice mix');
    insertBomLine.run(mixBomId, pouchId, 150000, 'piece', '150 pouches');
    insertBomLine.run(mixBomId, cartonId, 8000, 'piece', '8 cartons');

    // 7. Opening Stock Lots + Stock Ledger Entries (exact Section 5 Opening Balances!)
    const openingDate = '2026-11-01';
    const openingEntries = [
      { itemId: flourId, qty: 100, unit: 'kg', factor: 1000000, ratePaisa: 4200, batch: 'OPEN-FLR-01', expiry: '2027-02-28' },
      { itemId: oilId, qty: 30, unit: 'L', factor: 1000000, ratePaisa: 14000, batch: 'OPEN-OIL-01', expiry: '2027-04-30' },
      { itemId: spiceId, qty: 5, unit: 'kg', factor: 1000000, ratePaisa: 20000, batch: 'OPEN-SPC-01', expiry: '2027-05-15' },
      { itemId: pouchId, qty: 500, unit: 'piece', factor: 1000, ratePaisa: 250, batch: 'OPEN-PCH-01', expiry: '2028-01-01' },
      { itemId: cartonId, qty: 30, unit: 'piece', factor: 1000, ratePaisa: 1500, batch: 'OPEN-CTN-01', expiry: '2028-01-01' },
      { itemId: murukkuId, qty: 50, unit: 'packet', factor: 1000, ratePaisa: 3100, batch: 'OPEN-MUR-01', expiry: '2026-12-25' },
      { itemId: mixtureId, qty: 40, unit: 'packet', factor: 1000, ratePaisa: 3600, batch: 'OPEN-MIX-01', expiry: '2026-12-25' },
      { itemId: chipsId, qty: 35, unit: 'packet', factor: 1000, ratePaisa: 4200, batch: 'OPEN-CHP-01', expiry: '2026-12-20' },
    ];

    const insertLot = db.prepare(
      `INSERT INTO stock_lots (item_id, batch_no, expiry_date, received_date, source_type, source_id, initial_qty_milli, remaining_qty_milli, unit_cost_paisa)
       VALUES (?, ?, ?, ?, 'OPENING', 0, ?, ?, ?)`
    );
    const insertLedger = db.prepare(
      `INSERT INTO stock_ledger (item_id, movement_date, movement_type, qty_delta_milli, unit_cost_paisa, total_value_paisa, lot_id, source_type, source_id, source_ref, notes, created_by)
       VALUES (?, ?, 'OPENING', ?, ?, ?, ?, 'SEED', 0, 'OPENING-BAL', 'Benchmark Section 5 Opening Stock', ?)`
    );

    for (const op of openingEntries) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(op.itemId);
      const qtyMilli = toMilliBase(op.qty, op.unit, item);
      const valPaisa = computeCostPaisa(qtyMilli, op.ratePaisa, op.factor);
      const lotId = Number(insertLot.run(op.itemId, op.batch, op.expiry, openingDate, qtyMilli, qtyMilli, op.ratePaisa).lastInsertRowid);
      insertLedger.run(op.itemId, openingDate, qtyMilli, op.ratePaisa, valPaisa, lotId, adminId);
    }

    return { seeded: true, bom_id: murBomId, mix_bom_id: mixBomId };
  });
}

if (require.main === module) {
  const { getDb } = require('../backend/src/db');
  const db = getDb();
  const res = seedBenchmarkData(db, { reset: true });
  console.log('Seeded database successfully:', res);
}

module.exports = { seedBenchmarkData };
