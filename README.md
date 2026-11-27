# Order-to-Audit System — Small Food Manufacturer (Kaveri Craft Snacks)

An integrated **Order-to-Audit** prototype built for a small-scale South Indian snack manufacturer (murukku, mixture, chips, sweets). Every transaction is entered once at its source and flows automatically across **Sales Orders → Stock Checks → GST Tax Invoices → Dispatch → Payments** and **Raw Material Purchases → BOM Production Runs → Variance & FIFO Costing → Monthly Auditor Reports**.

---

## 1. Tech Stack & Justification

- **Backend:** Node.js (v24) + Express 5 + built-in `node:sqlite` (`DatabaseSync`)
- **Frontend:** React 19 + Vite (warm, light-themed, role-based UI with zero dark mode)
- **Why this stack:** Using Express with Node 24's built-in SQLite (`node:sqlite`) gives a real relational database with ACID transactions, foreign keys, and zero native compilation or external DB setup, while React + Vite serves responsive mobile-first salesman screens and desktop admin/auditor consoles from a single `npm start` command.

---

## 2. Quick Start (Run Locally)

### Prerequisites
- Node.js **v22.5+** or **v24+** (tested on Node v24.19.0)

### Single-Command Run (Production Build + API on `http://localhost:5000`)
```bash
npm --prefix backend install
npm --prefix frontend install
npm run build
npm start
```
Then open **http://localhost:5000** in your browser.

### Development Mode (Hot Reload)
In two terminals:
```bash
# Terminal 1 (API on :5000)
npm start

# Terminal 2 (Vite dev server on :5173, proxies /api to :5000)
npm --prefix frontend run dev
```

### Docker Compose
```bash
docker compose up --build
```

### Reset & Reseed Benchmark Data
```bash
npm run seed
```
Or click **Reset Seed Data** in the top bar of the app at any time.

### Run Automated Math, Benchmark & RBAC Tests
```bash
npm test
```

---

## 3. Test Logins (All 5 Roles)

All demo accounts use password **`demo123`** (also available as 1-click sign-in cards on the login screen):

| Role | Username | Password | Screen / Permissions |
| --- | --- | --- | --- |
| Salesman A | `salesman_a` | `demo123` | Mobile field order entry, offline queue + sync, own orders, customer sales, GPS check-in |
| Salesman B | `salesman_b` | `demo123` | Mobile field order entry (isolated from Salesman A's orders) |
| Factory Admin | `admin` | `demo123` | Order verification & qty/price edit, stock checks, GST PDF invoices, dispatch, credit notes, payments, purchases, product/BOM masters |
| Production Supervisor | `supervisor` | `demo123` | Raw material receipts, BOM production runs, actual output & wastage, overhead allocation, English / தமிழ் toggle |
| Accountant / Auditor | `auditor` | `demo123` | **Strictly read-only** monthly reports, date filters, CSV/Excel, PDF, Tally XML exports, audit trail |
| Owner | `owner` | `demo123` | Executive KPIs, stock health, variance alerts, cost/packet margins, production demand planner |

---

## 4. Scope Coverage vs Section 6 Tiers

### Must-Have
- [x] Role-based login across all 5 roles (`salesman`, `admin`, `production`, `auditor`, `owner`) with strict backend RBAC
- [x] Product, customer, supplier, raw material, packaging, and BOM masters
- [x] Mobile-friendly salesman order entry (<1 min) and admin verification/edit/approval
- [x] Downloadable GST Tax Invoice PDF (`CGST+SGST` intra-state / `IGST` inter-state, HSN, GSTIN, FY numbering `INV/2026-27/0001`) + WhatsApp share link
- [x] Production run updating raw materials, packaging, and finished-goods stock automatically inside SQLite transactions
- [x] Planned vs actual consumption and yield variance flagged beyond `±3%`
- [x] Ledger-derived stock summary (`opening + receipts - issues ± adjustments = closing`) and traceable stock ledger
- [x] Sales register & stock reports exportable to CSV/Excel and PDF

### Should-Have
- [x] Purchases and supplier records with batch & expiry
- [x] Payments, customer outstanding, and `0–30 / 31–60 / 61+` days ageing
- [x] Cost per packet with overheads (labour + gas/power) and gross margin
- [x] GST summary report shaped for GSTR-1 / GSTR-3B + HSN summary
- [x] Variance alerts (`> 3%`) & Owner dashboard

### Stretch Goals Implemented
- [x] Offline order capture (`localStorage`) with idempotent batch sync (`client_offline_id`)
- [x] Batch & expiry tracking with **FEFO/FIFO** lot consumption
- [x] Reorder levels & low-stock alerts
- [x] Production planning from pending orders ("to fulfil orders, make N batches")
- [x] Salesman route visit log with GPS coordinates
- [x] Tally-compatible Sales Voucher XML export
- [x] Tamil (`தமிழ்`) floor-staff toggle in Production Supervisor view

---

## 5. Benchmark Scenario Results (Section 5)

| Check | Expected | Our System Result | Notes / Rule |
| --- | --- | --- | --- |
| Flour closing balance | `120 kg` (`100 + 60 − 40`) | **`120 kg`** | Exact integer milli-grams |
| Oil closing balance | `19.5 L` (`30 − 10.5`) | **`19.5 L`** | Exact integer milli-litres |
| Pouches closing balance | `306` (`500 − 188 − 6`) | **`306 piece`** | Both good + damaged deducted |
| Cartons closing balance | `21` (`30 − 9`) | **`21 piece`** | 1 carton = 20 packets |
| Finished goods after run | `238 packets` (`50 + 188`) | **`238 packets`** | Ledger-derived |
| Finished goods after Retailer A dispatch | `88 packets` (`238 − 150`) | **`88 packets`** | Ledger-derived |
| Yield variance | `188 vs 200`, `−6%`, flagged | **`-6.00%` (FLAGGED)** | Exceeds `±3.00%` tolerance |
| Oil consumption variance | `10.5 vs 10`, `+5%`, flagged | **`+5.00%` (FLAGGED)** | Exceeds `±3.00%` tolerance |
| Retailer A invoice | `₹7,500 + ₹187.50 CGST + ₹187.50 SGST = ₹7,875` | **`₹7,875.00`** | Tamil Nadu (`33`) intra-state |
| Retailer A outstanding | `₹3,875` (`₹7,875 − ₹4,000`) | **`₹3,875.00`** | Paid via NEFT receipt |
| Distributor B order (120 pkts) | Shortage `32` flagged; IGST applies | **`Short 32 pkts` (`88 avail`), `IGST 5%` (`₹300` on 120 pkts)** | Karnataka (`29`) inter-state; approval blocked with `409 Conflict` |
| **Cost per packet** | Your figure + valuation & overhead rule | **`₹30.90 / packet`** (Margin `₹19.10` / `38.2%`) | **FIFO** valuation + **Direct Batch Overhead** |

### Costing & Valuation Explanation
- **Inventory Valuation Method (FIFO / FEFO):** Every purchase/opening creates an immutable cost lot (`stock_lots`). Under FIFO, the `40 kg` of flour issued to the benchmark run is drawn from the oldest opening lot (`100 kg @ ₹42/kg = ₹1,680.00`), leaving `60 kg @ ₹42` + `60 kg @ ₹45` in closing stock.
- **Direct Material + Packaging Cost:** `₹1,680` (Flour) + `₹1,470` (10.5 L Oil @ ₹140) + `₹240` (1.2 kg Spice @ ₹200) + `₹485` (194 Pouches @ ₹2.50) + `₹135` (9 Cartons @ ₹15) = **`₹4,010.00`**.
- **Overhead Allocation Rule:** Direct batch allocation — Labour (`₹1,200`) + Gas/Power (`₹600`) = **`₹1,800.00`** allocated directly to the batch's actual good output (`188 packets`).
- **Total Cost / Packet:** `₹5,810.00 / 188 packets` = **`₹30.90 / packet`** (`3090` paisa).

---

## 6. Assumptions & Known Gaps

- **Assumptions:**
  - All money is stored as integer **paisa** (`1 ₹ = 100 paisa`) and all physical stock quantities are stored as integer **milli-base-units** (`1/1000th` of `g`, `ml`, `piece`, `packet`) to eliminate floating-point rounding drift.
  - Posted invoices are immutable and can only be cancelled via a **Credit Note** (`CN/2026-27/XXXX`), never deleted.
  - Overheads (labour & gas/power) can be entered at run completion or updated afterwards (both logged in `audit_logs`).
- **Known Gaps:**
  - Customer-specific price lists are supported via Admin inline price editing on order approval rather than a separate customer-tier price table.
  - e-Invoice / e-Way Bill government API integration is not wired in this prototype.
