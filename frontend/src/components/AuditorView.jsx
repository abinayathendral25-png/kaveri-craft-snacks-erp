import { useEffect, useState } from 'react';
import { apiFetch, buildDownloadUrl, formatBps, formatRs } from '../api';
import { Icon } from './Icons';

export function AuditorView({ readOnlyLabel = true }) {
  const [tab, setTab] = useState('sales');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [reports, setReports] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const qs = new URLSearchParams();
    if (fromDate) qs.set('fromDate', fromDate);
    if (toDate) qs.set('toDate', toDate);
    Promise.all([
      apiFetch(`/api/reports/monthly?${qs.toString()}`),
      apiFetch('/api/audit-logs'),
    ])
      .then(([rep, logs]) => {
        if (!active) return;
        setError('');
        setReports(rep);
        setAuditLogs(logs);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [fromDate, toDate]);

  if (!reports) {
    return <div className="card">Loading monthly audit pack...</div>;
  }

  const querySuffix = `?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`;
  const csvMap = {
    sales: 'sales',
    gst: 'gst',
    purchases: 'purchases',
    stock: 'stock-summary',
    ledger: 'stock-ledger',
    production: 'production',
    ageing: 'outstanding',
  };

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div>
          <div className="flex-row">
            <h2 style={{ margin: 0, fontSize: 20 }}>Monthly Accounts & Auditor Reports</h2>
            {readOnlyLabel && <span className="badge badge-neutral">READ-ONLY AUDIT ACCESS</span>}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Filterable by date range · Exportable to Excel/CSV, PDF, and Tally XML · Ledger-reconciled
          </div>
        </div>

        <div className="flex-row">
          <input type="date" className="input" style={{ width: 145 }} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <span style={{ color: 'var(--text-muted)' }}>to</span>
          <input type="date" className="input" style={{ width: 145 }} value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <a className="btn btn-primary btn-sm" href={buildDownloadUrl(`/api/reports/export/monthly/pdf${querySuffix}`)} target="_blank" rel="noreferrer">
            <Icon name="download" size={14} /> Monthly PDF
          </a>
          <a className="btn btn-sm" href={buildDownloadUrl(`/api/reports/export/tally/xml${querySuffix}`)} target="_blank" rel="noreferrer">
            <Icon name="download" size={14} /> Tally XML
          </a>
          {csvMap[tab] && (
            <a className="btn btn-sm" href={buildDownloadUrl(`/api/reports/export/${csvMap[tab]}/csv${querySuffix}`)} target="_blank" rel="noreferrer">
              <Icon name="download" size={14} /> Export CSV
            </a>
          )}
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'sales' ? 'active' : ''}`} onClick={() => setTab('sales')}>Sales Register</button>
        <button className={`tab-btn ${tab === 'gst' ? 'active' : ''}`} onClick={() => setTab('gst')}>GST (GSTR-1/3B)</button>
        <button className={`tab-btn ${tab === 'purchases' ? 'active' : ''}`} onClick={() => setTab('purchases')}>Purchases</button>
        <button className={`tab-btn ${tab === 'stock' ? 'active' : ''}`} onClick={() => setTab('stock')}>Stock Summary</button>
        <button className={`tab-btn ${tab === 'ledger' ? 'active' : ''}`} onClick={() => setTab('ledger')}>Stock Ledger</button>
        <button className={`tab-btn ${tab === 'production' ? 'active' : ''}`} onClick={() => setTab('production')}>Production & Cost</button>
        <button className={`tab-btn ${tab === 'ageing' ? 'active' : ''}`} onClick={() => setTab('ageing')}>Receivables Ageing</button>
        <button className={`tab-btn ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Trail ({auditLogs.length})</button>
      </div>

      {tab === 'sales' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">Sales Register</div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Invoice No</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Place of Supply</th>
                    <th>Status</th>
                    <th className="text-right">Taxable</th>
                    <th className="text-right">CGST</th>
                    <th className="text-right">SGST</th>
                    <th className="text-right">IGST</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.sales_register.map((r) => (
                    <tr key={r.id}>
                      <td><strong>{r.invoice_no}</strong></td>
                      <td>{r.invoice_date}</td>
                      <td>{r.customer_name}</td>
                      <td>{r.place_of_supply_state}</td>
                      <td><span className={`badge ${r.status === 'CANCELLED' ? 'badge-danger' : 'badge-success'}`}>{r.status}</span></td>
                      <td className="text-right num">{formatRs(r.taxable_paisa)}</td>
                      <td className="text-right num">{formatRs(r.cgst_paisa)}</td>
                      <td className="text-right num">{formatRs(r.sgst_paisa)}</td>
                      <td className="text-right num">{formatRs(r.igst_paisa)}</td>
                      <td className="text-right num"><strong>{formatRs(r.total_paisa)}</strong></td>
                      <td className="text-right num">{formatRs(r.outstanding_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-title">Customer-wise Sales</div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>Customer</th><th className="text-right">Invoices</th><th className="text-right">Total</th></tr></thead>
                  <tbody>
                    {reports.customer_wise_sales.map((c) => (
                      <tr key={c.customer_id}>
                        <td>{c.customer_name}</td>
                        <td className="text-right num">{c.invoice_count}</td>
                        <td className="text-right num"><strong>{formatRs(c.total_paisa)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-title">Product-wise Sales</div>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>Product</th><th className="text-right">Packets</th><th className="text-right">Total</th></tr></thead>
                  <tbody>
                    {reports.product_wise_sales.map((p) => (
                      <tr key={p.item_id}>
                        <td>{p.item_name}</td>
                        <td className="text-right num">{p.qty_packets}</td>
                        <td className="text-right num"><strong>{formatRs(p.total_paisa)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'gst' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">GSTR-1 / GSTR-3B Outward Supplies Summary</div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Supply Regime</th>
                    <th>Table</th>
                    <th className="text-right">Taxable</th>
                    <th className="text-right">CGST</th>
                    <th className="text-right">SGST</th>
                    <th className="text-right">IGST</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.gst_summary.buckets.map((b, i) => (
                    <tr key={i}>
                      <td>{b.supply_type}</td>
                      <td>{b.gstr1_table}</td>
                      <td className="text-right num">{formatRs(b.taxable_paisa)}</td>
                      <td className="text-right num">{formatRs(b.cgst_paisa)}</td>
                      <td className="text-right num">{formatRs(b.sgst_paisa)}</td>
                      <td className="text-right num">{formatRs(b.igst_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title">HSN-wise Summary</div>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>HSN</th>
                    <th>Product</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Taxable</th>
                    <th className="text-right">Total Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.gst_summary.hsn_summary.map((h, i) => (
                    <tr key={i}>
                      <td><code>{h.hsn_code}</code></td>
                      <td>{h.description}</td>
                      <td className="text-right num">{h.total_packets}</td>
                      <td className="text-right num">{formatRs(h.taxable_paisa)}</td>
                      <td className="text-right num">{formatRs(h.cgst_paisa + h.sgst_paisa + h.igst_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'purchases' && (
        <div className="card">
          <div className="card-title">Purchase Register</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Purchase No</th>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Total</th>
                  <th>Batch / Expiry</th>
                </tr>
              </thead>
              <tbody>
                {reports.purchase_register.map((p, idx) => (
                  <tr key={idx}>
                    <td><strong>{p.purchase_no}</strong></td>
                    <td>{p.purchase_date}</td>
                    <td>{p.supplier_name}</td>
                    <td>{p.item_name}</td>
                    <td className="text-right num">{p.qty_display} {p.input_unit}</td>
                    <td className="text-right num">{formatRs(p.rate_paisa_per_display)}</td>
                    <td className="text-right num"><strong>{formatRs(p.line_total_paisa)}</strong></td>
                    <td><code>{p.batch_no}</code> · {p.expiry_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'stock' && (
        <div className="card">
          <div className="card-title">Stock Summary (Opening + Receipts − Issues ± Adjustments = Closing)</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right">Opening</th>
                  <th className="text-right">Receipts (+)</th>
                  <th className="text-right">Issues / Sales (−)</th>
                  <th className="text-right">Closing Balance</th>
                  <th className="text-right">FIFO Valuation</th>
                </tr>
              </thead>
              <tbody>
                {reports.stock_summary.map((s) => (
                  <tr key={s.id}>
                    <td><code>{s.sku}</code></td>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.item_type.replace('_', ' ')}</td>
                    <td className="text-right num">{s.opening_display} {s.display_unit}</td>
                    <td className="text-right num">{s.receipts_display} {s.display_unit}</td>
                    <td className="text-right num">{s.issues_display} {s.display_unit}</td>
                    <td className="text-right num"><strong>{s.balance_display} {s.display_unit}</strong></td>
                    <td className="text-right num">{formatRs(s.fifo_value_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'ledger' && (
        <div className="card">
          <div className="card-title">Traceable Stock Ledger (Every Movement & Source Document)</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Movement</th>
                  <th className="text-right">Delta</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Value</th>
                  <th>Batch</th>
                  <th>Source Document</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {reports.stock_ledger.map((l) => (
                  <tr key={l.id}>
                    <td>{l.movement_date}</td>
                    <td><strong>{l.item_name}</strong></td>
                    <td><span className={`badge ${l.qty_delta_milli >= 0 ? 'badge-success' : 'badge-warn'}`}>{l.movement_type}</span></td>
                    <td className="text-right num">
                      <strong>{l.qty_delta_display > 0 ? `+${l.qty_delta_display}` : l.qty_delta_display}</strong> {l.display_unit}
                    </td>
                    <td className="text-right num">{formatRs(l.unit_cost_paisa)}</td>
                    <td className="text-right num">{formatRs(l.total_value_paisa)}</td>
                    <td><code>{l.batch_no || '-'}</code></td>
                    <td><strong>{l.source_ref}</strong></td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'production' && (
        <div className="card">
          <div className="card-title">Production Variance & Costing Report</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Run No</th>
                  <th>Product</th>
                  <th className="text-right">Expected / Good</th>
                  <th className="text-right">Yield Var</th>
                  <th className="text-right">Material (FIFO)</th>
                  <th className="text-right">Overheads</th>
                  <th className="text-right">Total Cost</th>
                  <th className="text-right">Cost / Packet</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {reports.production_report.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.run_no}</strong></td>
                    <td>{r.finished_item_name}</td>
                    <td className="text-right num">{r.expected_packets} / {r.actual_good_packets}</td>
                    <td className="text-right num">
                      <span className={`badge ${Math.abs(r.yield_variance_bps) > 300 ? 'badge-danger' : 'badge-success'}`}>
                        {formatBps(r.yield_variance_bps)}
                      </span>
                    </td>
                    <td className="text-right num">{formatRs(r.material_cost_paisa)}</td>
                    <td className="text-right num">{formatRs(r.labour_cost_paisa + r.overhead_cost_paisa)}</td>
                    <td className="text-right num"><strong>{formatRs(r.total_cost_paisa)}</strong></td>
                    <td className="text-right num"><strong>{formatRs(r.cost_per_packet_paisa)}</strong></td>
                    <td className="text-right num">{formatRs(r.margin_paisa)} ({r.margin_pct}%)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'ageing' && (
        <div className="card">
          <div className="card-title">Payments & Customer Outstanding Ageing</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>State</th>
                  <th className="text-right">Invoiced</th>
                  <th className="text-right">Collected</th>
                  <th className="text-right">Outstanding</th>
                  <th className="text-right">0–30 Days</th>
                  <th className="text-right">31–60 Days</th>
                  <th className="text-right">61+ Days</th>
                </tr>
              </thead>
              <tbody>
                {reports.outstanding_ageing.map((c) => (
                  <tr key={c.customer_id}>
                    <td><strong>{c.customer_name}</strong></td>
                    <td>{c.state_name}</td>
                    <td className="text-right num">{formatRs(c.invoiced_paisa)}</td>
                    <td className="text-right num">{formatRs(c.collected_paisa)}</td>
                    <td className="text-right num"><strong>{formatRs(c.outstanding_paisa)}</strong></td>
                    <td className="text-right num">{formatRs(c.bucket_0_30_paisa)}</td>
                    <td className="text-right num">{formatRs(c.bucket_31_60_paisa)}</td>
                    <td className="text-right num">{formatRs(c.bucket_61_plus_paisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <div className="card-title">System Audit Trail</div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User (Role)</th>
                  <th>Entity</th>
                  <th>Action</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{a.created_at}</td>
                    <td><strong>{a.username}</strong> ({a.user_role})</td>
                    <td>{a.entity_type} · <code>{a.entity_ref}</code></td>
                    <td><span className="badge badge-info">{a.action}</span></td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.notes || a.after_json || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
