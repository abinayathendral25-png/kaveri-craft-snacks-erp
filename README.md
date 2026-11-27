# Order-to-Audit System — Small Food Manufacturer (Kaveri Craft Snacks)

An integrated **Order-to-Audit** prototype built for a small-scale South Indian snack manufacturer (murukku, mixture, chips, sweets). Every transaction is entered once at its source and flows automatically across **Sales Orders → Stock Checks → GST Tax Invoices → Dispatch → Payments** and **Raw Material Purchases → BOM Production Runs → Variance & FIFO Costing → Monthly Auditor Reports**.

---

## 1. Tech Stack & Justification

- **Backend:** Node.js (v24) + Express 5 + built-in `node:sqlite` (`DatabaseSync`)
- **Frontend:** React 19 + Vite
- **Database:** SQLite
- **Why this stack:** Express with Node 24's built-in SQLite provides a relational database with ACID transactions and foreign-key support, while React + Vite provides responsive interfaces for salesmen, administrators, production supervisors, and auditors.

---

## 2. Quick Start (Run Locally)

### Prerequisites
- Node.js v22.5+ or v24+ (tested on Node v24.19.0)

### Single-Command Run

```bash
npm --prefix backend install
npm --prefix frontend install
npm run build
npm start
```

Open http://localhost:5000.

### Development Mode

```bash
# Terminal 1
npm start

# Terminal 2
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

### Run Automated Tests

```bash
npm test
```

---

## 3. Test Logins

All demo accounts use password `demo123`.

| Role | Username | Password |
|---|---|---|
| Salesman A | `salesman_a` | `demo123` |
| Salesman B | `salesman_b` | `demo123` |
| Factory Admin | `admin` | `demo123` |
| Production Supervisor | `supervisor` | `demo123` |
| Accountant / Auditor | `auditor` | `demo123` |
| Owner | `owner` | `demo123` |

---

## 4. Scope Coverage

### Must-Have
- Role-based login and backend permissions.
- Product, customer, supplier, raw material, packaging, and BOM masters.
- Salesman order entry and admin verification.
- GST invoices with CGST, SGST, or IGST.
- Production runs updating raw material and finished goods stock.
- Planned-versus-actual material and yield variance.
- Stock summaries and traceable stock ledger.
- Sales and stock reports.

### Should-Have
- Purchases and supplier records.
- Payments, outstanding balances, and ageing.
- Cost per packet and overhead allocation.
- GST summaries and variance alerts.
- Owner dashboard.

### Stretch Goals
- Offline order capture and synchronization.
- Batch and expiry tracking.
- Reorder alerts.
- Production planning.
- Salesman visit logging.
- Tally-compatible XML export.
- Tamil interface option for production staff.

---

## 5. Benchmark Scenario Results

| Check | Expected | System Result |
|---|---:|---:|
| Flour closing balance | 120 kg | 120 kg |
| Oil closing balance | 19.5 L | 19.5 L |
| Pouches closing balance | 306 | 306 |
| Cartons closing balance | 21 | 21 |
| Finished goods after production | 238 packets | 238 packets |
| Finished goods after dispatch | 88 packets | 88 packets |
| Yield variance | -6% | -6.00% (flagged) |
| Oil consumption variance | +5% | +5.00% (flagged) |
| Retailer A invoice | ₹7,875 | ₹7,875 |
| Retailer A outstanding | ₹3,875 | ₹3,875 |
| Distributor B shortage | 32 packets | 32 packets |

### Costing Explanation

- Flour: ₹1,680 (FIFO)
- Oil: ₹1,470
- Spice mix: ₹240
- Pouches: ₹485
- Cartons: ₹135
- **Total material and packaging cost: ₹4,010**
- Labour and gas/power: ₹1,800
- **Total batch cost: ₹5,810**
- Actual good output: 188 packets
- **Cost per packet: ₹30.90**
- Selling price: ₹50
- **Gross margin per packet: ₹19.10**

Costing uses FIFO material valuation and direct batch overhead allocation.

---

## 6. Assumptions & Known Gaps

### Assumptions
- Money is stored in integer paisa.
- Physical stock quantities use integer milli-base-units.
- Posted invoices are corrected through credit notes rather than deletion.
- Production overheads are allocated directly to production batches.

### Known Gaps
- Customer-specific pricing is handled through admin order editing rather than a separate customer-tier pricing table.
- Government e-Invoice and e-Way Bill API integration is not connected.

---

## 7. Project Purpose

This prototype demonstrates an integrated workflow connecting sales, purchasing, production, inventory, costing, GST invoicing, and audit reporting for a small food manufacturer.