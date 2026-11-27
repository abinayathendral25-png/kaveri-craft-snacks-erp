const { withTransaction } = require('./db');
const { logAudit } = require('./auth');
const {
  rupeesToPaisa,
  toMilliBase,
  milliToDisplay,
  computeCostPaisa,
  computeGstLine,
  computeVarianceBps,
} = require('./math');

function getFactorySettings(db) {
  return db.prepare('SELECT * FROM factory_settings WHERE id = 1').get();
}

function nextDocNumber(db, table, column, prefix, fy) {
  const pattern = `${prefix}/${fy}/%`;
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${column} LIKE ?`)
    .get(pattern);
  const seq = String((row ? row.cnt : 0) + 1).padStart(4, '0');
  return `${prefix}/${fy}/${seq}`;
}

function getItemBalanceMilli(db, itemId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(qty_delta_milli), 0) AS bal FROM stock_ledger WHERE item_id = ?')
    .get(itemId);
  return Number(row ? row.bal : 0);
}

function getInventorySummary(db) {
  const rows = db
    .prepare(
      `SELECT i.*,
              COALESCE((SELECT SUM(sl.qty_delta_milli) FROM stock_ledger sl WHERE sl.item_id = i.id), 0) AS balance_milli,
              COALESCE((SELECT SUM(ROUND(CAST(lot.remaining_qty_milli AS REAL) * lot.unit_cost_paisa / i.display_factor_milli))
                        FROM stock_lots lot WHERE lot.item_id = i.id AND lot.remaining_qty_milli > 0), 0) AS fifo_value_paisa,
              (SELECT MIN(lot.expiry_date) FROM stock_lots lot WHERE lot.item_id = i.id AND lot.remaining_qty_milli > 0 AND lot.expiry_date IS NOT NULL) AS earliest_expiry,
              (SELECT lot.unit_cost_paisa FROM stock_lots lot WHERE lot.item_id = i.id ORDER BY lot.id DESC LIMIT 1) AS latest_rate_paisa
       FROM items i
       WHERE i.active = 1
       ORDER BY CASE i.item_type WHEN 'raw_material' THEN 1 WHEN 'packaging' THEN 2 ELSE 3 END, i.id ASC`
    )
    .all();

  return rows.map((r) => ({
    ...r,
    balance_display: milliToDisplay(r.balance_milli, r.display_factor_milli),
    reorder_level_display: milliToDisplay(r.reorder_level_milli, r.display_factor_milli),
    is_low_stock: r.reorder_level_milli > 0 && r.balance_milli <= r.reorder_level_milli,
  }));
}

/**
 * Consume stock lots in FEFO/FIFO order and record stock_ledger rows.
 * Returns total FIFO cost in paisa.
 */
function consumeLotsFifo(
  db,
  { item, qtyMilli, movementDate, movementType, sourceType, sourceId, sourceRef, notes, userId }
) {
  if (qtyMilli <= 0) return 0;

  const currentBal = getItemBalanceMilli(db, item.id);
  if (currentBal < qtyMilli) {
    const avail = milliToDisplay(currentBal, item.display_factor_milli);
    const req = milliToDisplay(qtyMilli, item.display_factor_milli);
    throw new Error(
      `Insufficient stock for ${item.name}: available ${avail} ${item.display_unit}, required ${req} ${item.display_unit}`
    );
  }

  const lots = db
    .prepare(
      `SELECT * FROM stock_lots
       WHERE item_id = ? AND remaining_qty_milli > 0
       ORDER BY COALESCE(expiry_date, '9999-12-31') ASC, received_date ASC, id ASC`
    )
    .all(item.id);

  let remainingToIssue = qtyMilli;
  let totalCostPaisa = 0;

  for (const lot of lots) {
    if (remainingToIssue <= 0) break;
    const take = Math.min(remainingToIssue, lot.remaining_qty_milli);
    const costPaisa = computeCostPaisa(take, lot.unit_cost_paisa, item.display_factor_milli);

    db.prepare('UPDATE stock_lots SET remaining_qty_milli = remaining_qty_milli - ? WHERE id = ?').run(
      take,
      lot.id
    );

    db.prepare(
      `INSERT INTO stock_ledger
       (item_id, movement_date, movement_type, qty_delta_milli, unit_cost_paisa, total_value_paisa, lot_id, source_type, source_id, source_ref, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      item.id,
      movementDate,
      movementType,
      -take,
      lot.unit_cost_paisa,
      -costPaisa,
      lot.id,
      sourceType,
      sourceId,
      sourceRef,
      notes || `FIFO/FEFO issue from lot ${lot.batch_no}`,
      userId
    );

    totalCostPaisa += costPaisa;
    remainingToIssue -= take;
  }

  // Fallback if ledger balance existed without lot rows (should not happen in normal flow)
  if (remainingToIssue > 0) {
    throw new Error(`Lot reconciliation mismatch for ${item.name}`);
  }

  return totalCostPaisa;
}

/**
 * Record a raw material or packaging purchase.
 */
function recordPurchase(db, { supplierId, supplierBillNo, purchaseDate, items, notes, user }) {
  if (!items || items.length === 0) {
    throw new Error('At least one purchase item is required');
  }
  const settings = getFactorySettings(db);
  const dateStr = purchaseDate || new Date().toISOString().slice(0, 10);

  return withTransaction(db, () => {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
    if (!supplier) throw new Error('Supplier not found');

    const purchaseNo = nextDocNumber(db, 'purchases', 'purchase_no', 'PUR', settings.financial_year);
    const purRes = db
      .prepare(
        `INSERT INTO purchases (purchase_no, supplier_id, supplier_bill_no, purchase_date, total_paisa, notes, created_by)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(purchaseNo, supplierId, supplierBillNo || null, dateStr, notes || null, user.id);
    const purchaseId = Number(purRes.lastInsertRowid);

    let totalPaisa = 0;

    for (const line of items) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(line.item_id);
      if (!item) throw new Error(`Item ${line.item_id} not found`);

      const unit = line.unit || item.display_unit;
      const qtyMilli = toMilliBase(line.qty, unit, item);
      if (qtyMilli <= 0) throw new Error(`Quantity must be positive for ${item.name}`);

      const ratePaisa =
        line.rate_paisa !== undefined ? Number(line.rate_paisa) : rupeesToPaisa(line.rate_rupees);
      const lineTotalPaisa = computeCostPaisa(qtyMilli, ratePaisa, item.display_factor_milli);
      const batchNo =
        line.batch_no || `${item.sku}-${dateStr.replace(/-/g, '')}-${purchaseId}`;
      const expiryDate =
        line.expiry_date ||
        new Date(new Date(dateStr).getTime() + item.shelf_life_days * 86400000)
          .toISOString()
          .slice(0, 10);

      db.prepare(
        `INSERT INTO purchase_items (purchase_id, item_id, qty_milli, input_unit, rate_paisa_per_display, line_total_paisa, batch_no, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(purchaseId, item.id, qtyMilli, unit, ratePaisa, lineTotalPaisa, batchNo, expiryDate);

      const lotRes = db
        .prepare(
          `INSERT INTO stock_lots (item_id, batch_no, expiry_date, received_date, source_type, source_id, initial_qty_milli, remaining_qty_milli, unit_cost_paisa)
           VALUES (?, ?, ?, ?, 'PURCHASE', ?, ?, ?, ?)`
        )
        .run(item.id, batchNo, expiryDate, dateStr, purchaseId, qtyMilli, qtyMilli, ratePaisa);
      const lotId = Number(lotRes.lastInsertRowid);

      db.prepare(
        `INSERT INTO stock_ledger (item_id, movement_date, movement_type, qty_delta_milli, unit_cost_paisa, total_value_paisa, lot_id, source_type, source_id, source_ref, notes, created_by)
         VALUES (?, ?, 'PURCHASE_IN', ?, ?, ?, ?, 'PURCHASE', ?, ?, ?, ?)`
      ).run(
        item.id,
        dateStr,
        qtyMilli,
        ratePaisa,
        lineTotalPaisa,
        lotId,
        purchaseId,
        purchaseNo,
        `Purchased from ${supplier.name}`,
        user.id
      );

      totalPaisa += lineTotalPaisa;
    }

    db.prepare('UPDATE purchases SET total_paisa = ? WHERE id = ?').run(totalPaisa, purchaseId);

    logAudit(db, {
      entityType: 'purchase',
      entityId: purchaseId,
      entityRef: purchaseNo,
      action: 'CREATE',
      user,
      after: { purchase_no: purchaseNo, supplier_id: supplierId, total_paisa: totalPaisa },
    });

    return db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  });
}

/**
 * Start a production run: issues raw materials (not packaging yet unless included) against a BOM.
 */
function startProductionRun(
  db,
  { bomId, batchMultiplier = 1, runDate, issuedMaterials = [], batchNo, expiryDate, notes, user }
) {
  const settings = getFactorySettings(db);
  const dateStr = runDate || new Date().toISOString().slice(0, 10);
  const multMilli = Math.round(Number(batchMultiplier) * 1000);
  if (multMilli <= 0) throw new Error('Batch multiplier must be positive');

  return withTransaction(db, () => {
    const bom = db.prepare('SELECT * FROM boms WHERE id = ?').get(bomId);
    if (!bom) throw new Error('BOM not found');
    const finishedItem = db.prepare('SELECT * FROM items WHERE id = ?').get(bom.finished_item_id);
    const bomLines = db
      .prepare(
        `SELECT bl.*, i.name AS item_name, i.item_type, i.base_unit, i.display_unit, i.display_factor_milli, i.packets_per_carton
         FROM bom_lines bl
         JOIN items i ON i.id = bl.component_item_id
         WHERE bl.bom_id = ?`
      )
      .all(bomId);

    const expectedPackets = Math.round((bom.batch_size_packets * multMilli) / 1000);
    const runNo = nextDocNumber(db, 'production_runs', 'run_no', 'RUN', settings.financial_year);
    const finalBatchNo = batchNo || `FG-${finishedItem.sku}-${dateStr.replace(/-/g, '')}-${runNo.slice(-4)}`;
    const finalExpiry =
      expiryDate ||
      new Date(new Date(dateStr).getTime() + finishedItem.shelf_life_days * 86400000)
        .toISOString()
        .slice(0, 10);

    const runRes = db
      .prepare(
        `INSERT INTO production_runs
         (run_no, bom_id, finished_item_id, batch_multiplier_milli, expected_packets, status, run_date, batch_no, expiry_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, ?)`
      )
      .run(
        runNo,
        bomId,
        finishedItem.id,
        multMilli,
        expectedPackets,
        dateStr,
        finalBatchNo,
        finalExpiry,
        notes || null,
        user.id
      );
    const runId = Number(runRes.lastInsertRowid);

    const issuedMap = new Map();
    for (const m of issuedMaterials) {
      issuedMap.set(Number(m.item_id), m);
    }

    let materialCostPaisa = 0;
    let hasVariance = 0;

    for (const line of bomLines) {
      const plannedMilli = Math.round((line.qty_per_batch_milli * multMilli) / 1000);
      const itemObj = {
        id: line.component_item_id,
        name: line.item_name,
        item_type: line.item_type,
        base_unit: line.base_unit,
        display_unit: line.display_unit,
        display_factor_milli: line.display_factor_milli,
        packets_per_carton: line.packets_per_carton,
      };

      if (line.item_type === 'raw_material') {
        const override = issuedMap.get(line.component_item_id);
        const actualUsedMilli = override
          ? toMilliBase(override.qty, override.unit || line.display_unit, itemObj)
          : plannedMilli;

        const fifoCost = consumeLotsFifo(db, {
          item: itemObj,
          qtyMilli: actualUsedMilli,
          movementDate: dateStr,
          movementType: 'PROD_ISSUE',
          sourceType: 'PRODUCTION_RUN',
          sourceId: runId,
          sourceRef: runNo,
          notes: `Issued to ${runNo} (${finishedItem.name})`,
          userId: user.id,
        });

        const varianceBps = computeVarianceBps(actualUsedMilli, plannedMilli);
        const flagged = Math.abs(varianceBps) > settings.variance_tolerance_bps ? 1 : 0;
        if (flagged) hasVariance = 1;
        materialCostPaisa += fifoCost;

        db.prepare(
          `INSERT INTO production_consumptions
           (run_id, item_id, planned_qty_milli, actual_used_milli, damaged_qty_milli, total_consumed_milli, variance_bps, is_flagged, fifo_cost_paisa)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
        ).run(
          runId,
          line.component_item_id,
          plannedMilli,
          actualUsedMilli,
          actualUsedMilli,
          varianceBps,
          flagged,
          fifoCost
        );
      } else {
        // Packaging lines are planned here and issued on run completion (based on good + damaged output)
        db.prepare(
          `INSERT INTO production_consumptions
           (run_id, item_id, planned_qty_milli, actual_used_milli, damaged_qty_milli, total_consumed_milli, variance_bps, is_flagged, fifo_cost_paisa)
           VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)`
        ).run(runId, line.component_item_id, plannedMilli);
      }
    }

    db.prepare(
      'UPDATE production_runs SET material_cost_paisa = ?, has_variance_alert = ? WHERE id = ?'
    ).run(materialCostPaisa, hasVariance, runId);

    logAudit(db, {
      entityType: 'production_run',
      entityId: runId,
      entityRef: runNo,
      action: 'START_RUN',
      user,
      after: { run_no: runNo, expected_packets: expectedPackets, material_cost_paisa: materialCostPaisa },
    });

    return getProductionRunById(db, runId);
  });
}

/**
 * Complete an IN_PROGRESS production run: records actual output, damaged pouches, cartons used,
 * deducts packaging via FIFO, receives finished goods into ledger & FIFO lot, computes variance & cost/packet.
 */
function completeProductionRun(
  db,
  runId,
  {
    actualGoodPackets,
    wastagePackets = 0,
    packagingUsed = [],
    damagedPouches = 0,
    cartonsUsed = null,
    labourCostRupees = 0,
    overheadCostRupees = 0,
    notes,
    user,
  }
) {
  const settings = getFactorySettings(db);
  const goodQty = Math.round(Number(actualGoodPackets));
  if (!Number.isFinite(goodQty) || goodQty <= 0) {
    throw new Error('Actual good packets must be a positive integer');
  }

  return withTransaction(db, () => {
    const run = db.prepare('SELECT * FROM production_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Production run not found');
    if (run.status === 'COMPLETED') {
      throw new Error('Production run is already completed');
    }

    const finishedItem = db.prepare('SELECT * FROM items WHERE id = ?').get(run.finished_item_id);
    const consumptions = db
      .prepare(
        `SELECT pc.*, i.name AS item_name, i.item_type, i.base_unit, i.display_unit, i.display_factor_milli, i.packets_per_carton, i.sku
         FROM production_consumptions pc
         JOIN items i ON i.id = pc.item_id
         WHERE pc.run_id = ?`
      )
      .all(runId);

    const pkgOverrideMap = new Map();
    for (const p of packagingUsed) {
      pkgOverrideMap.set(Number(p.item_id), p);
    }

    let materialCostPaisa = run.material_cost_paisa;
    let hasVariance = run.has_variance_alert;

    for (const cons of consumptions) {
      if (cons.item_type !== 'packaging') continue;

      const itemObj = {
        id: cons.item_id,
        name: cons.item_name,
        item_type: cons.item_type,
        base_unit: cons.base_unit,
        display_unit: cons.display_unit,
        display_factor_milli: cons.display_factor_milli,
        packets_per_carton: cons.packets_per_carton,
      };

      const override = pkgOverrideMap.get(cons.item_id);
      let usedCount = goodQty;
      let damagedCount = 0;

      if (override) {
        usedCount = Number(override.used_qty ?? goodQty);
        damagedCount = Number(override.damaged_qty ?? 0);
      } else if (cons.item_name.toLowerCase().includes('carton') || cons.sku.startsWith('PKG-CTN')) {
        const perCarton = finishedItem.packets_per_carton || 20;
        usedCount = cartonsUsed !== null && cartonsUsed !== undefined ? Number(cartonsUsed) : Math.floor(goodQty / perCarton);
        damagedCount = 0;
      } else {
        // Pouch / label
        usedCount = goodQty;
        damagedCount = Number(damagedPouches || 0);
      }

      const usedMilli = toMilliBase(usedCount, cons.display_unit, itemObj);
      const damagedMilli = toMilliBase(damagedCount, cons.display_unit, itemObj);
      const totalConsumedMilli = usedMilli + damagedMilli;

      const fifoCost = consumeLotsFifo(db, {
        item: itemObj,
        qtyMilli: totalConsumedMilli,
        movementDate: run.run_date,
        movementType: 'PROD_ISSUE',
        sourceType: 'PRODUCTION_RUN',
        sourceId: run.id,
        sourceRef: run.run_no,
        notes: damagedCount > 0
          ? `Packaging for ${run.run_no}: ${usedCount} used + ${damagedCount} damaged`
          : `Packaging for ${run.run_no}: ${usedCount} used`,
        userId: user.id,
      });

      const varianceBps = computeVarianceBps(totalConsumedMilli, cons.planned_qty_milli);
      const flagged = Math.abs(varianceBps) > settings.variance_tolerance_bps ? 1 : 0;
      if (flagged) hasVariance = 1;
      materialCostPaisa += fifoCost;

      db.prepare(
        `UPDATE production_consumptions
         SET actual_used_milli = ?, damaged_qty_milli = ?, total_consumed_milli = ?, variance_bps = ?, is_flagged = ?, fifo_cost_paisa = ?
         WHERE id = ?`
      ).run(usedMilli, damagedMilli, totalConsumedMilli, varianceBps, flagged, fifoCost, cons.id);
    }

    const labourPaisa = rupeesToPaisa(labourCostRupees || 0);
    const overheadPaisa = rupeesToPaisa(overheadCostRupees || 0);
    const totalCostPaisa = materialCostPaisa + labourPaisa + overheadPaisa;
    const costPerPacketPaisa = Math.round(totalCostPaisa / goodQty);

    const yieldVarianceBps = computeVarianceBps(goodQty, run.expected_packets);
    if (Math.abs(yieldVarianceBps) > settings.variance_tolerance_bps) {
      hasVariance = 1;
    }

    const goodMilli = goodQty * 1000;
    const fgLotRes = db
      .prepare(
        `INSERT INTO stock_lots
         (item_id, batch_no, expiry_date, received_date, source_type, source_id, initial_qty_milli, remaining_qty_milli, unit_cost_paisa)
         VALUES (?, ?, ?, ?, 'PRODUCTION', ?, ?, ?, ?)`
      )
      .run(
        finishedItem.id,
        run.batch_no,
        run.expiry_date,
        run.run_date,
        run.id,
        goodMilli,
        goodMilli,
        costPerPacketPaisa
      );
    const fgLotId = Number(fgLotRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO stock_ledger
       (item_id, movement_date, movement_type, qty_delta_milli, unit_cost_paisa, total_value_paisa, lot_id, source_type, source_id, source_ref, notes, created_by)
       VALUES (?, ?, 'PROD_OUTPUT', ?, ?, ?, ?, 'PRODUCTION_RUN', ?, ?, ?, ?)`
    ).run(
      finishedItem.id,
      run.run_date,
      goodMilli,
      costPerPacketPaisa,
      totalCostPaisa,
      fgLotId,
      run.id,
      run.run_no,
      `Produced ${goodQty} packets (expected ${run.expected_packets})`,
      user.id
    );

    db.prepare(
      `UPDATE production_runs
       SET actual_good_packets = ?, wastage_packets = ?, status = 'COMPLETED',
           labour_cost_paisa = ?, overhead_cost_paisa = ?, material_cost_paisa = ?,
           total_cost_paisa = ?, cost_per_packet_paisa = ?, yield_variance_bps = ?,
           has_variance_alert = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      goodQty,
      Math.round(Number(wastagePackets || Math.max(0, run.expected_packets - goodQty))),
      labourPaisa,
      overheadPaisa,
      materialCostPaisa,
      totalCostPaisa,
      costPerPacketPaisa,
      yieldVarianceBps,
      hasVariance,
      notes || null,
      run.id
    );

    logAudit(db, {
      entityType: 'production_run',
      entityId: run.id,
      entityRef: run.run_no,
      action: 'COMPLETE_RUN',
      user,
      before: { status: 'IN_PROGRESS', expected_packets: run.expected_packets },
      after: {
        status: 'COMPLETED',
        actual_good_packets: goodQty,
        yield_variance_bps: yieldVarianceBps,
        total_cost_paisa: totalCostPaisa,
        cost_per_packet_paisa: costPerPacketPaisa,
      },
    });

    return getProductionRunById(db, run.id);
  });
}

/**
 * Update overheads (labour, gas/power) on a completed production run (logged in audit trail).
 */
function updateRunOverheads(db, runId, { labourCostRupees, overheadCostRupees, notes, user }) {
  return withTransaction(db, () => {
    const run = db.prepare('SELECT * FROM production_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Production run not found');
    if (run.status !== 'COMPLETED' || run.actual_good_packets <= 0) {
      throw new Error('Complete the production run before allocating final overheads');
    }

    const before = {
      labour_cost_paisa: run.labour_cost_paisa,
      overhead_cost_paisa: run.overhead_cost_paisa,
      total_cost_paisa: run.total_cost_paisa,
      cost_per_packet_paisa: run.cost_per_packet_paisa,
    };

    const labourPaisa = rupeesToPaisa(labourCostRupees ?? 0);
    const overheadPaisa = rupeesToPaisa(overheadCostRupees ?? 0);
    const totalCostPaisa = run.material_cost_paisa + labourPaisa + overheadPaisa;
    const costPerPacketPaisa = Math.round(totalCostPaisa / run.actual_good_packets);

    db.prepare(
      `UPDATE production_runs
       SET labour_cost_paisa = ?, overhead_cost_paisa = ?, total_cost_paisa = ?, cost_per_packet_paisa = ?,
           notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?`
    ).run(labourPaisa, overheadPaisa, totalCostPaisa, costPerPacketPaisa, notes || null, runId);

    // Keep finished-goods lot & ledger valuation in sync with updated batch cost
    db.prepare(
      `UPDATE stock_lots SET unit_cost_paisa = ? WHERE source_type = 'PRODUCTION' AND source_id = ? AND item_id = ?`
    ).run(costPerPacketPaisa, runId, run.finished_item_id);
    db.prepare(
      `UPDATE stock_ledger SET unit_cost_paisa = ?, total_value_paisa = ?
       WHERE source_type = 'PRODUCTION_RUN' AND source_id = ? AND movement_type = 'PROD_OUTPUT'`
    ).run(costPerPacketPaisa, totalCostPaisa, runId);

    logAudit(db, {
      entityType: 'production_run',
      entityId: runId,
      entityRef: run.run_no,
      action: 'UPDATE_OVERHEADS',
      user,
      before,
      after: {
        labour_cost_paisa: labourPaisa,
        overhead_cost_paisa: overheadPaisa,
        total_cost_paisa: totalCostPaisa,
        cost_per_packet_paisa: costPerPacketPaisa,
      },
      notes: notes || 'Overheads allocated to batch',
    });

    return getProductionRunById(db, runId);
  });
}

function getProductionRunById(db, runId) {
  const run = db
    .prepare(
      `SELECT pr.*, i.name AS finished_item_name, i.selling_price_paisa, i.sku AS finished_sku, u.full_name AS created_by_name
       FROM production_runs pr
       JOIN items i ON i.id = pr.finished_item_id
       JOIN users u ON u.id = pr.created_by
       WHERE pr.id = ?`
    )
    .get(runId);
  if (!run) return null;

  const consumptions = db
    .prepare(
      `SELECT pc.*, i.name AS item_name, i.item_type, i.display_unit, i.display_factor_milli
       FROM production_consumptions pc
       JOIN items i ON i.id = pc.item_id
       WHERE pc.run_id = ?
       ORDER BY CASE i.item_type WHEN 'raw_material' THEN 1 ELSE 2 END, pc.id ASC`
    )
    .all(runId)
    .map((c) => ({
      ...c,
      planned_display: milliToDisplay(c.planned_qty_milli, c.display_factor_milli),
      actual_used_display: milliToDisplay(c.actual_used_milli, c.display_factor_milli),
      damaged_display: milliToDisplay(c.damaged_qty_milli, c.display_factor_milli),
      total_consumed_display: milliToDisplay(c.total_consumed_milli, c.display_factor_milli),
    }));

  return { ...run, consumptions };
}

/**
 * Place a sales order (supports idempotent offline sync via client_offline_id).
 */
function createSalesOrder(db, { customerId, salesmanUser, items, orderDate, clientOfflineId, notes }) {
  if (!items || items.length === 0) {
    throw new Error('Order must contain at least one product');
  }
  const settings = getFactorySettings(db);
  const dateStr = orderDate || new Date().toISOString().slice(0, 10);

  return withTransaction(db, () => {
    if (clientOfflineId) {
      const existing = db
        .prepare('SELECT id FROM sales_orders WHERE client_offline_id = ?')
        .get(clientOfflineId);
      if (existing) {
        return getSalesOrderById(db, existing.id);
      }
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('Customer not found');

    const orderNo = nextDocNumber(db, 'sales_orders', 'order_no', 'ORD', settings.financial_year);
    const ordRes = db
      .prepare(
        `INSERT INTO sales_orders (order_no, customer_id, salesman_id, order_date, status, client_offline_id, notes)
         VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?)`
      )
      .run(orderNo, customerId, salesmanUser.id, dateStr, clientOfflineId || null, notes || null);
    const orderId = Number(ordRes.lastInsertRowid);

    for (const line of items) {
      const item = db
        .prepare("SELECT * FROM items WHERE id = ? AND item_type = 'finished_good'")
        .get(line.item_id);
      if (!item) throw new Error(`Finished good ${line.item_id} not found`);

      const qtyPackets = Math.round(Number(line.qty_packets));
      if (!Number.isFinite(qtyPackets) || qtyPackets <= 0) {
        throw new Error(`Invalid quantity for ${item.name}`);
      }
      const unitPricePaisa =
        line.unit_price_paisa !== undefined ? Number(line.unit_price_paisa) : item.selling_price_paisa;
      const lineTaxablePaisa = qtyPackets * unitPricePaisa;

      db.prepare(
        `INSERT INTO sales_order_items (order_id, item_id, qty_packets, unit_price_paisa, gst_rate_bps, line_taxable_paisa)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(orderId, item.id, qtyPackets, unitPricePaisa, item.gst_rate_bps, lineTaxablePaisa);
    }

    logAudit(db, {
      entityType: 'sales_order',
      entityId: orderId,
      entityRef: orderNo,
      action: 'SUBMIT',
      user: salesmanUser,
      after: { order_no: orderNo, customer_id: customerId, item_count: items.length },
    });

    return getSalesOrderById(db, orderId);
  });
}

function getOrderStockAndTaxCheck(db, orderId) {
  const settings = getFactorySettings(db);
  const order = db
    .prepare(
      `SELECT so.*, c.name AS customer_name, c.customer_type, c.gstin AS customer_gstin,
              c.state_name AS customer_state, c.state_code AS customer_state_code
       FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
       WHERE so.id = ?`
    )
    .get(orderId);
  if (!order) return null;

  const isInterstate = order.customer_state_code !== settings.state_code;
  const lines = db
    .prepare(
      `SELECT soi.*, i.name AS item_name, i.sku, i.hsn_code, i.packets_per_carton
       FROM sales_order_items soi
       JOIN items i ON i.id = soi.item_id
       WHERE soi.order_id = ?`
    )
    .all(orderId);

  let allSufficient = true;
  let taxablePaisa = 0;
  let cgstPaisa = 0;
  let sgstPaisa = 0;
  let igstPaisa = 0;
  let totalPaisa = 0;

  const checkedLines = lines.map((l) => {
    const balMilli = getItemBalanceMilli(db, l.item_id);
    const availablePackets = Math.floor(balMilli / 1000);
    const shortagePackets = Math.max(0, l.qty_packets - availablePackets);
    if (shortagePackets > 0) allSufficient = false;

    const gst = computeGstLine({
      qtyPackets: l.qty_packets,
      unitPricePaisa: l.unit_price_paisa,
      gstRateBps: l.gst_rate_bps,
      isInterstate,
    });

    taxablePaisa += gst.taxablePaisa;
    cgstPaisa += gst.cgstPaisa;
    sgstPaisa += gst.sgstPaisa;
    igstPaisa += gst.igstPaisa;
    totalPaisa += gst.totalPaisa;

    return {
      ...l,
      available_packets: availablePackets,
      shortage_packets: shortagePackets,
      stock_ok: shortagePackets === 0,
      ...gst,
    };
  });

  return {
    order_id: order.id,
    order_no: order.order_no,
    all_sufficient: allSufficient,
    is_interstate: isInterstate,
    tax_type: isInterstate ? 'IGST' : 'CGST + SGST',
    place_of_supply: `${order.customer_state} (${order.customer_state_code})`,
    taxable_paisa: taxablePaisa,
    cgst_paisa: cgstPaisa,
    sgst_paisa: sgstPaisa,
    igst_paisa: igstPaisa,
    total_paisa: totalPaisa,
    lines: checkedLines,
  };
}

function getSalesOrderById(db, orderId) {
  const order = db
    .prepare(
      `SELECT so.*, c.name AS customer_name, c.customer_type, c.state_name AS customer_state,
              c.state_code AS customer_state_code, c.gstin AS customer_gstin,
              u.full_name AS salesman_name,
              inv.id AS invoice_id, inv.invoice_no, inv.status AS invoice_status, inv.dispatch_status, inv.total_paisa AS invoice_total_paisa
       FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
       JOIN users u ON u.id = so.salesman_id
       LEFT JOIN invoices inv ON inv.order_id = so.id AND inv.status = 'POSTED'
       WHERE so.id = ?`
    )
    .get(orderId);
  if (!order) return null;

  const check = getOrderStockAndTaxCheck(db, orderId);
  return {
    ...order,
    items: check.lines,
    stock_check: {
      all_sufficient: check.all_sufficient,
      is_interstate: check.is_interstate,
      tax_type: check.tax_type,
      taxable_paisa: check.taxable_paisa,
      cgst_paisa: check.cgst_paisa,
      sgst_paisa: check.sgst_paisa,
      igst_paisa: check.igst_paisa,
      total_paisa: check.total_paisa,
    },
  };
}

/**
 * Admin approves order (with optional quantity/price edits) and generates a posted GST Tax Invoice.
 */
function approveAndInvoiceOrder(db, orderId, { editedItems = null, invoiceDate, allowBackorder = false, user }) {
  const settings = getFactorySettings(db);
  const dateStr = invoiceDate || new Date().toISOString().slice(0, 10);

  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'SUBMITTED' && order.status !== 'APPROVED') {
      throw new Error(`Order ${order.order_no} cannot be invoiced in status ${order.status}`);
    }

    if (editedItems && Array.isArray(editedItems) && editedItems.length > 0) {
      const beforeItems = db.prepare('SELECT * FROM sales_order_items WHERE order_id = ?').all(orderId);
      for (const edit of editedItems) {
        const qtyPackets = Math.round(Number(edit.qty_packets));
        if (qtyPackets <= 0) throw new Error('Edited quantity must be positive');
        const current = db
          .prepare('SELECT * FROM sales_order_items WHERE order_id = ? AND item_id = ?')
          .get(orderId, edit.item_id);
        if (!current) continue;
        const unitPrice =
          edit.unit_price_paisa !== undefined ? Number(edit.unit_price_paisa) : current.unit_price_paisa;
        db.prepare(
          'UPDATE sales_order_items SET qty_packets = ?, unit_price_paisa = ?, line_taxable_paisa = ? WHERE id = ?'
        ).run(qtyPackets, unitPrice, qtyPackets * unitPrice, current.id);
      }
      logAudit(db, {
        entityType: 'sales_order',
        entityId: orderId,
        entityRef: order.order_no,
        action: 'ADMIN_EDIT',
        user,
        before: beforeItems,
        after: editedItems,
      });
    }

    const check = getOrderStockAndTaxCheck(db, orderId);
    if (!check.all_sufficient && !allowBackorder) {
      const shortLine = check.lines.find((l) => l.shortage_packets > 0);
      const err = new Error(
        `Insufficient stock for ${shortLine.item_name}: ordered ${shortLine.qty_packets}, available ${shortLine.available_packets}, short by ${shortLine.shortage_packets} packets.`
      );
      err.statusCode = 409;
      err.details = check;
      throw err;
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
    const invoiceNo = nextDocNumber(db, 'invoices', 'invoice_no', 'INV', settings.financial_year);
    const dueDate = new Date(new Date(dateStr).getTime() + 15 * 86400000).toISOString().slice(0, 10);

    const invRes = db
      .prepare(
        `INSERT INTO invoices
         (invoice_no, financial_year, order_id, customer_id, invoice_date, due_date,
          place_of_supply_state, place_of_supply_code, is_interstate,
          taxable_paisa, cgst_paisa, sgst_paisa, igst_paisa, total_paisa,
          status, dispatch_status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', 'PENDING', ?)`
      )
      .run(
        invoiceNo,
        settings.financial_year,
        orderId,
        customer.id,
        dateStr,
        dueDate,
        customer.state_name,
        customer.state_code,
        check.is_interstate ? 1 : 0,
        check.taxable_paisa,
        check.cgst_paisa,
        check.sgst_paisa,
        check.igst_paisa,
        check.total_paisa,
        user.id
      );
    const invoiceId = Number(invRes.lastInsertRowid);

    for (const l of check.lines) {
      db.prepare(
        `INSERT INTO invoice_items
         (invoice_id, item_id, hsn_code, qty_packets, dispatched_packets, unit_price_paisa, taxable_paisa, gst_rate_bps, cgst_paisa, sgst_paisa, igst_paisa, total_paisa)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        invoiceId,
        l.item_id,
        l.hsn_code || '21069099',
        l.qty_packets,
        l.unit_price_paisa,
        l.taxablePaisa,
        l.gst_rate_bps,
        l.cgstPaisa,
        l.sgstPaisa,
        l.igstPaisa,
        l.totalPaisa
      );
    }

    db.prepare(
      "UPDATE sales_orders SET status = 'INVOICED', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(user.id, orderId);

    logAudit(db, {
      entityType: 'invoice',
      entityId: invoiceId,
      entityRef: invoiceNo,
      action: 'CREATE_FROM_ORDER',
      user,
      after: {
        invoice_no: invoiceNo,
        order_no: order.order_no,
        total_paisa: check.total_paisa,
        is_interstate: check.is_interstate,
      },
    });

    return getInvoiceById(db, invoiceId);
  });
}

function rejectSalesOrder(db, orderId, { reason, user }) {
  return withTransaction(db, () => {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'SUBMITTED') {
      throw new Error('Only submitted orders can be rejected');
    }
    db.prepare(
      "UPDATE sales_orders SET status = 'REJECTED', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(reason || 'Rejected by factory admin', orderId);

    logAudit(db, {
      entityType: 'sales_order',
      entityId: orderId,
      entityRef: order.order_no,
      action: 'REJECT',
      user,
      notes: reason || 'Rejected by factory admin',
    });

    return getSalesOrderById(db, orderId);
  });
}

/**
 * Record dispatch (full or partial) against a posted invoice and deduct finished-goods stock via FEFO/FIFO.
 */
function recordDispatch(db, invoiceId, { items = null, dispatchDate, vehicleOrLr, notes, user }) {
  const settings = getFactorySettings(db);
  const dateStr = dispatchDate || new Date().toISOString().slice(0, 10);

  return withTransaction(db, () => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status !== 'POSTED') throw new Error('Cannot dispatch a cancelled invoice');

    const invItems = db
      .prepare(
        `SELECT ii.*, i.name AS item_name, i.base_unit, i.display_unit, i.display_factor_milli, i.packets_per_carton
         FROM invoice_items ii
         JOIN items i ON i.id = ii.item_id
         WHERE ii.invoice_id = ?`
      )
      .all(invoiceId);

    const overrideMap = new Map();
    if (items && Array.isArray(items)) {
      for (const it of items) {
        overrideMap.set(Number(it.item_id), Math.round(Number(it.qty_packets)));
      }
    }

    const toDispatch = [];
    for (const ii of invItems) {
      const pending = ii.qty_packets - ii.dispatched_packets;
      if (pending <= 0) continue;
      const reqQty = overrideMap.size > 0 ? overrideMap.get(ii.item_id) || 0 : pending;
      if (reqQty <= 0) continue;
      if (reqQty > pending) {
        throw new Error(`Dispatch qty ${reqQty} exceeds pending qty ${pending} for ${ii.item_name}`);
      }
      toDispatch.push({ invItem: ii, qtyPackets: reqQty });
    }

    if (toDispatch.length === 0) {
      throw new Error('No pending quantities left to dispatch');
    }

    const dispatchNo = nextDocNumber(db, 'dispatches', 'dispatch_no', 'DSP', settings.financial_year);
    const dspRes = db
      .prepare(
        `INSERT INTO dispatches (dispatch_no, invoice_id, dispatch_date, vehicle_or_lr, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(dispatchNo, invoiceId, dateStr, vehicleOrLr || null, notes || null, user.id);
    const dispatchId = Number(dspRes.lastInsertRowid);

    for (const entry of toDispatch) {
      const { invItem, qtyPackets } = entry;
      const itemObj = {
        id: invItem.item_id,
        name: invItem.item_name,
        base_unit: invItem.base_unit,
        display_unit: invItem.display_unit,
        display_factor_milli: invItem.display_factor_milli,
        packets_per_carton: invItem.packets_per_carton,
      };

      consumeLotsFifo(db, {
        item: itemObj,
        qtyMilli: qtyPackets * 1000,
        movementDate: dateStr,
        movementType: 'DISPATCH_OUT',
        sourceType: 'DISPATCH',
        sourceId: dispatchId,
        sourceRef: `${dispatchNo} (${invoice.invoice_no})`,
        notes: `Dispatched against ${invoice.invoice_no}`,
        userId: user.id,
      });

      db.prepare('INSERT INTO dispatch_items (dispatch_id, invoice_item_id, item_id, qty_packets) VALUES (?, ?, ?, ?)').run(
        dispatchId,
        invItem.id,
        invItem.item_id,
        qtyPackets
      );

      db.prepare('UPDATE invoice_items SET dispatched_packets = dispatched_packets + ? WHERE id = ?').run(
        qtyPackets,
        invItem.id
      );
    }

    const updatedItems = db.prepare('SELECT qty_packets, dispatched_packets FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
    const allDone = updatedItems.every((i) => i.dispatched_packets >= i.qty_packets);
    const anyDone = updatedItems.some((i) => i.dispatched_packets > 0);
    const dispatchStatus = allDone ? 'DISPATCHED' : anyDone ? 'PARTIAL' : 'PENDING';

    db.prepare("UPDATE invoices SET dispatch_status = ?, updated_at = datetime('now') WHERE id = ?").run(
      dispatchStatus,
      invoiceId
    );

    if (invoice.order_id) {
      const orderStatus = dispatchStatus === 'DISPATCHED' ? 'DISPATCHED' : 'PARTIAL_DISPATCH';
      db.prepare("UPDATE sales_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
        orderStatus,
        invoice.order_id
      );
    }

    logAudit(db, {
      entityType: 'dispatch',
      entityId: dispatchId,
      entityRef: dispatchNo,
      action: 'DISPATCH',
      user,
      after: { invoice_no: invoice.invoice_no, dispatch_status: dispatchStatus, items: toDispatch.map((d) => ({ item_id: d.invItem.item_id, qty_packets: d.qtyPackets })) },
    });

    return getInvoiceById(db, invoiceId);
  });
}

/**
 * Cancel a posted invoice via Credit Note (never deleted).
 */
function cancelInvoiceWithCreditNote(db, invoiceId, { reason, restockGoods = false, user }) {
  const settings = getFactorySettings(db);
  return withTransaction(db, () => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'CANCELLED') throw new Error('Invoice is already cancelled');

    const cnNo = nextDocNumber(db, 'credit_notes', 'credit_note_no', 'CN', settings.financial_year);
    const cnRes = db
      .prepare(
        `INSERT INTO credit_notes (credit_note_no, invoice_id, reason, amount_paisa, restock_goods, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(cnNo, invoiceId, reason || 'Invoice cancelled', invoice.total_paisa, restockGoods ? 1 : 0, user.id);
    const cnId = Number(cnRes.lastInsertRowid);

    if (restockGoods) {
      const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
      for (const ii of items) {
        if (ii.dispatched_packets > 0) {
          const qtyMilli = ii.dispatched_packets * 1000;
          const lotRes = db
            .prepare(
              `INSERT INTO stock_lots (item_id, batch_no, received_date, source_type, source_id, initial_qty_milli, remaining_qty_milli, unit_cost_paisa)
               VALUES (?, ?, date('now'), 'ADJUSTMENT', ?, ?, ?, ?)`
            )
            .run(ii.item_id, `RET-${cnNo}`, cnId, qtyMilli, qtyMilli, ii.unit_price_paisa);
          db.prepare(
            `INSERT INTO stock_ledger (item_id, movement_date, movement_type, qty_delta_milli, unit_cost_paisa, total_value_paisa, lot_id, source_type, source_id, source_ref, notes, created_by)
             VALUES (?, date('now'), 'CREDIT_RETURN_IN', ?, ?, ?, ?, 'CREDIT_NOTE', ?, ?, ?, ?)`
          ).run(
            ii.item_id,
            qtyMilli,
            ii.unit_price_paisa,
            qtyMilli / 1000 * ii.unit_price_paisa,
            Number(lotRes.lastInsertRowid),
            cnId,
            cnNo,
            `Returned against ${invoice.invoice_no}`,
            user.id
          );
        }
      }
    }

    db.prepare("UPDATE invoices SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?").run(
      invoiceId
    );

    logAudit(db, {
      entityType: 'invoice',
      entityId: invoiceId,
      entityRef: invoice.invoice_no,
      action: 'CANCEL_WITH_CREDIT_NOTE',
      user,
      before: { status: 'POSTED' },
      after: { status: 'CANCELLED', credit_note_no: cnNo, restock_goods: restockGoods },
      notes: reason,
    });

    return getInvoiceById(db, invoiceId);
  });
}

function recordPayment(db, { customerId, invoiceId = null, amountRupees, paymentDate, paymentMode = 'UPI', referenceNo, notes, user }) {
  const settings = getFactorySettings(db);
  const dateStr = paymentDate || new Date().toISOString().slice(0, 10);
  const amountPaisa = rupeesToPaisa(amountRupees);
  if (amountPaisa <= 0) throw new Error('Payment amount must be greater than zero');

  return withTransaction(db, () => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('Customer not found');

    if (invoiceId) {
      const inv = getInvoiceById(db, invoiceId);
      if (!inv || inv.customer_id !== Number(customerId)) {
        throw new Error('Invoice does not belong to this customer');
      }
      if (inv.status !== 'POSTED') throw new Error('Cannot record payment against cancelled invoice');
    }

    const receiptNo = nextDocNumber(db, 'payments', 'receipt_no', 'RCP', settings.financial_year);
    const payRes = db
      .prepare(
        `INSERT INTO payments (receipt_no, customer_id, invoice_id, payment_date, amount_paisa, payment_mode, reference_no, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receiptNo,
        customerId,
        invoiceId || null,
        dateStr,
        amountPaisa,
        paymentMode,
        referenceNo || null,
        notes || null,
        user.id
      );
    const payId = Number(payRes.lastInsertRowid);

    logAudit(db, {
      entityType: 'payment',
      entityId: payId,
      entityRef: receiptNo,
      action: 'RECORD_PAYMENT',
      user,
      after: { receipt_no: receiptNo, customer_id: customerId, invoice_id: invoiceId, amount_paisa: amountPaisa },
    });

    return db.prepare('SELECT * FROM payments WHERE id = ?').get(payId);
  });
}

function getInvoiceById(db, invoiceId) {
  const invoice = db
    .prepare(
      `SELECT inv.*,
              c.name AS customer_name, c.customer_type, c.gstin AS customer_gstin,
              c.address AS customer_address, c.phone AS customer_phone,
              so.order_no,
              COALESCE((SELECT SUM(p.amount_paisa) FROM payments p WHERE p.invoice_id = inv.id), 0) AS paid_paisa
       FROM invoices inv
       JOIN customers c ON c.id = inv.customer_id
       LEFT JOIN sales_orders so ON so.id = inv.order_id
       WHERE inv.id = ?`
    )
    .get(invoiceId);
  if (!invoice) return null;

  const items = db
    .prepare(
      `SELECT ii.*, i.name AS item_name, i.sku, i.pack_size_g
       FROM invoice_items ii
       JOIN items i ON i.id = ii.item_id
       WHERE ii.invoice_id = ?`
    )
    .all(invoiceId);

  const dispatches = db
    .prepare('SELECT * FROM dispatches WHERE invoice_id = ? ORDER BY id ASC')
    .all(invoiceId);

  const payments = db
    .prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id ASC')
    .all(invoiceId);

  const creditNotes = db
    .prepare('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY id ASC')
    .all(invoiceId);

  return {
    ...invoice,
    outstanding_paisa: invoice.status === 'CANCELLED' ? 0 : Math.max(0, invoice.total_paisa - invoice.paid_paisa),
    items,
    dispatches,
    payments,
    credit_notes: creditNotes,
  };
}

module.exports = {
  getFactorySettings,
  getItemBalanceMilli,
  getInventorySummary,
  consumeLotsFifo,
  recordPurchase,
  startProductionRun,
  completeProductionRun,
  updateRunOverheads,
  getProductionRunById,
  createSalesOrder,
  getOrderStockAndTaxCheck,
  getSalesOrderById,
  approveAndInvoiceOrder,
  rejectSalesOrder,
  recordDispatch,
  cancelInvoiceWithCreditNote,
  recordPayment,
  getInvoiceById,
};
