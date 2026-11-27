-- Order-to-Audit System Database Schema (SQLite)
-- All money values stored as integer PAISA (1 INR = 100 paisa).
-- All inventory quantities stored as integer MILLI-BASE-UNITS (1/1000th of g, ml, piece, packet).
-- Percentages/tax rates stored in BASIS POINTS (1% = 100 bps, e.g. 5% GST = 500 bps, 3% tolerance = 300 bps).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('salesman', 'admin', 'production', 'auditor', 'owner')),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factory_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL,
  gstin TEXT NOT NULL,
  state_name TEXT NOT NULL,
  state_code TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  variance_tolerance_bps INTEGER NOT NULL DEFAULT 300,
  financial_year TEXT NOT NULL DEFAULT '2026-27',
  valuation_method TEXT NOT NULL DEFAULT 'FIFO',
  overhead_rule TEXT NOT NULL DEFAULT 'Direct batch allocation (labour + gas/power divided by actual good packets produced)'
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  customer_type TEXT NOT NULL CHECK (customer_type IN ('retailer', 'distributor')),
  gstin TEXT,
  state_name TEXT NOT NULL,
  state_code TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT,
  assigned_salesman_id INTEGER REFERENCES users(id),
  credit_limit_paisa INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gstin TEXT,
  state_name TEXT NOT NULL,
  state_code TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('raw_material', 'packaging', 'finished_good')),
  category TEXT NOT NULL,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('g', 'ml', 'piece', 'packet')),
  display_unit TEXT NOT NULL CHECK (display_unit IN ('kg', 'g', 'L', 'ml', 'piece', 'packet')),
  display_factor_milli INTEGER NOT NULL,
  pack_size_g INTEGER NOT NULL DEFAULT 0,
  packets_per_carton INTEGER NOT NULL DEFAULT 20,
  hsn_code TEXT,
  selling_price_paisa INTEGER NOT NULL DEFAULT 0,
  gst_rate_bps INTEGER NOT NULL DEFAULT 500,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0,
  shelf_life_days INTEGER NOT NULL DEFAULT 90,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_item_id INTEGER NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL DEFAULT 1,
  batch_size_packets INTEGER NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(finished_item_id, version)
);

CREATE TABLE IF NOT EXISTS bom_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  component_item_id INTEGER NOT NULL REFERENCES items(id),
  qty_per_batch_milli INTEGER NOT NULL,
  input_unit TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_bill_no TEXT,
  purchase_date TEXT NOT NULL,
  total_paisa INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_milli INTEGER NOT NULL,
  input_unit TEXT NOT NULL,
  rate_paisa_per_display INTEGER NOT NULL,
  line_total_paisa INTEGER NOT NULL,
  batch_no TEXT,
  expiry_date TEXT
);

CREATE TABLE IF NOT EXISTS stock_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_no TEXT NOT NULL,
  expiry_date TEXT,
  received_date TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('OPENING', 'PURCHASE', 'PRODUCTION', 'ADJUSTMENT')),
  source_id INTEGER,
  initial_qty_milli INTEGER NOT NULL,
  remaining_qty_milli INTEGER NOT NULL,
  unit_cost_paisa INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  movement_date TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (
    movement_type IN (
      'OPENING',
      'PURCHASE_IN',
      'PROD_ISSUE',
      'PROD_OUTPUT',
      'PROD_SCRAP',
      'DISPATCH_OUT',
      'CREDIT_RETURN_IN',
      'ADJUSTMENT'
    )
  ),
  qty_delta_milli INTEGER NOT NULL,
  unit_cost_paisa INTEGER NOT NULL DEFAULT 0,
  total_value_paisa INTEGER NOT NULL DEFAULT 0,
  lot_id INTEGER REFERENCES stock_lots(id),
  source_type TEXT NOT NULL,
  source_id INTEGER,
  source_ref TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL UNIQUE,
  bom_id INTEGER NOT NULL REFERENCES boms(id),
  finished_item_id INTEGER NOT NULL REFERENCES items(id),
  batch_multiplier_milli INTEGER NOT NULL DEFAULT 1000,
  expected_packets INTEGER NOT NULL,
  actual_good_packets INTEGER NOT NULL DEFAULT 0,
  wastage_packets INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  run_date TEXT NOT NULL,
  batch_no TEXT NOT NULL,
  expiry_date TEXT,
  labour_cost_paisa INTEGER NOT NULL DEFAULT 0,
  overhead_cost_paisa INTEGER NOT NULL DEFAULT 0,
  material_cost_paisa INTEGER NOT NULL DEFAULT 0,
  total_cost_paisa INTEGER NOT NULL DEFAULT 0,
  cost_per_packet_paisa INTEGER NOT NULL DEFAULT 0,
  yield_variance_bps INTEGER NOT NULL DEFAULT 0,
  has_variance_alert INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  planned_qty_milli INTEGER NOT NULL,
  actual_used_milli INTEGER NOT NULL DEFAULT 0,
  damaged_qty_milli INTEGER NOT NULL DEFAULT 0,
  total_consumed_milli INTEGER NOT NULL DEFAULT 0,
  variance_bps INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  fifo_cost_paisa INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  order_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('SUBMITTED', 'APPROVED', 'INVOICED', 'PARTIAL_DISPATCH', 'DISPATCHED', 'REJECTED')
  ),
  client_offline_id TEXT UNIQUE,
  notes TEXT,
  rejection_reason TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_packets INTEGER NOT NULL,
  unit_price_paisa INTEGER NOT NULL,
  gst_rate_bps INTEGER NOT NULL,
  line_taxable_paisa INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,
  financial_year TEXT NOT NULL,
  order_id INTEGER REFERENCES sales_orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  place_of_supply_state TEXT NOT NULL,
  place_of_supply_code TEXT NOT NULL,
  is_interstate INTEGER NOT NULL DEFAULT 0,
  taxable_paisa INTEGER NOT NULL,
  cgst_paisa INTEGER NOT NULL,
  sgst_paisa INTEGER NOT NULL,
  igst_paisa INTEGER NOT NULL,
  total_paisa INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('POSTED', 'CANCELLED')),
  dispatch_status TEXT NOT NULL CHECK (dispatch_status IN ('PENDING', 'PARTIAL', 'DISPATCHED')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  hsn_code TEXT NOT NULL,
  qty_packets INTEGER NOT NULL,
  dispatched_packets INTEGER NOT NULL DEFAULT 0,
  unit_price_paisa INTEGER NOT NULL,
  taxable_paisa INTEGER NOT NULL,
  gst_rate_bps INTEGER NOT NULL,
  cgst_paisa INTEGER NOT NULL,
  sgst_paisa INTEGER NOT NULL,
  igst_paisa INTEGER NOT NULL,
  total_paisa INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_no TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  reason TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL,
  restock_goods INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_no TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  dispatch_date TEXT NOT NULL,
  vehicle_or_lr TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  invoice_item_id INTEGER NOT NULL REFERENCES invoice_items(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_packets INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  payment_date TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('CASH', 'UPI', 'NEFT', 'CHEQUE')),
  reference_no TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS salesman_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  visit_time TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_ref TEXT,
  action TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL,
  user_role TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_item ON stock_ledger(item_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_lots_item_rem ON stock_lots(item_id, remaining_qty_milli);
CREATE INDEX IF NOT EXISTS idx_orders_salesman ON sales_orders(salesman_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, created_at);
