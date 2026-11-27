import { useEffect, useState } from 'react';
import { apiFetch, formatBps, formatRs } from '../api';
import { AuditorView } from './AuditorView';
import { Icon } from './Icons';

export function OwnerView() {
  const [data, setData] = useState(null);
  const [showReports, setShowReports] = useState(false);

  useEffect(() => {
    apiFetch('/api/dashboard/owner').then(setData).catch(() => {});
  }, []);

  if (!data) return <div className="card">Loading executive summary...</div>;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Owner Executive Summary</h2>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Real-time health across sales orders, stock balances, production variance, cost per packet & dues
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setShowReports((v) => !v)}>
          {showReports ? 'Back to Summary' : 'Open Full Audit Reports'}
        </button>
      </div>

      {showReports ? (
        <AuditorView readOnlyLabel={false} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="grid-4">
            <div className="kpi-card">
              <div className="kpi-label">Orders Today / Pending</div>
              <div className="kpi-value num">{data.kpis.today_orders} / {data.kpis.pending_orders}</div>
              <div className="kpi-hint">Submitted field orders awaiting verification</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Total Invoiced Sales</div>
              <div className="kpi-value num" style={{ color: 'var(--primary)' }}>{formatRs(data.kpis.total_sales_paisa)}</div>
              <div className="kpi-hint">Posted GST invoices</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Outstanding Dues</div>
              <div className="kpi-value num" style={{ color: 'var(--accent)' }}>{formatRs(data.kpis.total_outstanding_paisa)}</div>
              <div className="kpi-hint">Receivables across retailers & distributors</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Variance / Low-Stock Alerts</div>
              <div className="kpi-value num" style={{ color: data.kpis.variance_alert_count > 0 ? 'var(--danger-text)' : 'var(--primary)' }}>
                {data.kpis.variance_alert_count} / {data.kpis.low_stock_count}
              </div>
              <div className="kpi-hint">BOM tolerance threshold: ±3.00%</div>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-title">Variance Alerts & Cost per Packet</div>
              {data.production_runs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>No production runs logged yet.</div>
              ) : (
                data.production_runs.map((r) => (
                  <div key={r.id} className="card-soft" style={{ marginTop: 10 }}>
                    <div className="row-between">
                      <strong>{r.run_no} · {r.finished_item_name}</strong>
                      <span className={`badge ${r.has_variance_alert ? 'badge-danger' : 'badge-success'}`}>
                        Yield {formatBps(r.yield_variance_bps)}
                      </span>
                    </div>
                    <div className="row-between" style={{ marginTop: 6, fontSize: 13 }}>
                      <span>Good Output: <strong>{r.actual_good_packets}</strong> / {r.expected_packets} pkts</span>
                      <span>Cost/Packet: <strong className="num" style={{ color: 'var(--primary)' }}>{formatRs(r.cost_per_packet_paisa)}</strong> (Margin {r.margin_pct}%)</span>
                    </div>
                    {r.consumptions.filter((c) => c.is_flagged).map((c) => (
                      <div key={c.id} style={{ fontSize: 12, color: 'var(--danger-text)', marginTop: 4 }}>
                        <Icon name="alert" size={12} /> {c.item_name}: {c.total_consumed_display} vs {c.planned_display} {c.display_unit} ({formatBps(c.variance_bps)})
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <div className="card-title">Current Stock Levels & Reorder Status</div>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Balance</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stock_summary.map((s) => (
                      <tr key={s.id}>
                        <td><strong>{s.name}</strong></td>
                        <td className="text-right num"><strong>{s.balance_display}</strong> {s.display_unit}</td>
                        <td>
                          {s.is_low_stock ? (
                            <span className="badge badge-warn">Low Stock</span>
                          ) : (
                            <span className="badge badge-success">Healthy</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {data.production_plan.length > 0 && (
            <div className="card">
              <div className="card-title">Pending-Order Production Recommendations</div>
              {data.production_plan.map((p) => (
                <div key={p.item_id} className="alert alert-warn" style={{ marginTop: 8, marginBottom: 0 }}>
                  <span><strong>{p.item_name}:</strong> {p.recommendation}</span>
                  <span className="badge badge-warn">Shortfall: {p.shortfall_packets} pkts</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
