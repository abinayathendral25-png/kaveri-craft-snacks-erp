import { useEffect, useState } from 'react';
import { apiFetch, formatBps, formatRs } from '../api';
import { Icon } from './Icons';

const LABELS = {
  en: {
    title: 'Production Floor & BOM Control',
    subtitle: 'Issue raw materials against BOM, log output & wastage, and track FIFO cost per packet',
    startRun: 'Start New Production Run',
    product: 'Finished Product & BOM',
    batches: 'Batch Size (1 batch = expected yield)',
    issueBtn: 'Issue Raw Materials & Start Run',
    completeTitle: 'Complete Run & Record Output',
    goodPkts: 'Actual Good Packets Produced',
    damagedPouches: 'Damaged / Wasted Pouches',
    cartonsUsed: 'Cartons Used',
    labour: 'Labour Cost (₹)',
    gasPower: 'Gas / Power Overhead (₹)',
    completeBtn: 'Complete Run & Update Finished Stock',
    stockTab: 'Raw & Packaging Stock',
    runsTab: 'Production Runs & Costing',
    planTab: 'Order Demand Planner',
  },
  ta: {
    title: 'உற்பத்தி தளம் & BOM கட்டுப்பாடு',
    subtitle: 'மூலப்பொருள் வழங்கல், உற்பத்தி அளவு, சேதம் மற்றும் ஒரு பாக்கெட் செலவு',
    startRun: 'புதிய உற்பத்தி தொடங்குக',
    product: 'தயாரிப்பு & செய்முறை (BOM)',
    batches: 'பேட்ச் அளவு',
    issueBtn: 'மூலப்பொருள் வழங்கி தொடங்கு',
    completeTitle: 'உற்பத்தி முடித்து அளவை பதிவு செய்',
    goodPkts: 'நல்ல பாக்கெட்டுகள் எண்ணிக்கை',
    damagedPouches: 'சேதமடைந்த பைகள்',
    cartonsUsed: 'பயன்படுத்திய அட்டைப்பெட்டிகள்',
    labour: 'தொழிலாளர் செலவு (₹)',
    gasPower: 'மின்சாரம் / எரிவாயு (₹)',
    completeBtn: 'முடித்து இருப்பில் சேர்க்கவும்',
    stockTab: 'மூலப்பொருள் இருப்பு',
    runsTab: 'உற்பத்தி & செலவு விபரம்',
    planTab: 'ஆர்டர் தேவை திட்டம்',
  },
};

export function ProductionView() {
  const [lang, setLang] = useState('en');
  const [tab, setTab] = useState('runs');
  const [masters, setMasters] = useState({ items: [], boms: [], suppliers: [] });
  const [runs, setRuns] = useState([]);
  const [plan, setPlan] = useState([]);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  // Start Run state
  const [bomId, setBomId] = useState('');
  const [batchMult, setBatchMult] = useState('1');
  const [issuedOverride, setIssuedOverride] = useState({});

  // Complete Run modal/form state
  const [activeRunId, setActiveRunId] = useState(null);
  const [goodPackets, setGoodPackets] = useState('188');
  const [damagedPouches, setDamagedPouches] = useState('6');
  const [cartonsUsed, setCartonsUsed] = useState('9');
  const [labourRupees, setLabourRupees] = useState('0');
  const [overheadRupees, setOverheadRupees] = useState('0');

  // Overhead edit state on completed runs
  const [overheadEdits, setOverheadEdits] = useState({});

  // Quick RM receipt form
  const [purSupplierId, setPurSupplierId] = useState('');
  const [purItemId, setPurItemId] = useState('');
  const [purQty, setPurQty] = useState('60');
  const [purRate, setPurRate] = useState('45');

  const t = LABELS[lang];

  async function loadAll() {
    try {
      const [m, r, p] = await Promise.all([
        apiFetch('/api/masters'),
        apiFetch('/api/production/runs'),
        apiFetch('/api/reports/production-plan'),
      ]);
      setMasters(m);
      setRuns(r);
      setPlan(p);
      if (!bomId && m.boms.length > 0) setBomId(String(m.boms[0].id));
      if (!purSupplierId && m.suppliers.length > 0) setPurSupplierId(String(m.suppliers[0].id));
      if (!purItemId && m.items.length > 0) {
        const flour = m.items.find((i) => i.sku === 'RM-FLOUR') || m.items[0];
        setPurItemId(String(flour.id));
      }
      const inProg = r.find((x) => x.status === 'IN_PROGRESS');
      if (inProg) setActiveRunId(inProg.id);
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch('/api/masters'),
      apiFetch('/api/production/runs'),
      apiFetch('/api/reports/production-plan'),
    ])
      .then(([m, r, p]) => {
        if (!active) return;
        setMasters(m);
        setRuns(r);
        setPlan(p);
        if (m.boms[0]) setBomId(String(m.boms[0].id));
        if (m.suppliers[0]) setPurSupplierId(String(m.suppliers[0].id));
        const flour = m.items.find((i) => i.sku === 'RM-FLOUR') || m.items[0];
        if (flour) setPurItemId(String(flour.id));
        const inProg = r.find((x) => x.status === 'IN_PROGRESS');
        if (inProg) setActiveRunId(inProg.id);
      })
      .catch((err) => {
        if (active) setBanner({ type: 'danger', text: err.message });
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedBom = masters.boms.find((b) => String(b.id) === String(bomId));
  const rawBomLines = selectedBom ? selectedBom.lines.filter((l) => l.item_type === 'raw_material') : [];

  async function handleStartRun(e) {
    e.preventDefault();
    if (!selectedBom) return;
    setBusy(true);
    setBanner(null);
    try {
      const mult = Number(batchMult || 1);
      const issuedMaterials = rawBomLines.map((l) => ({
        item_id: l.component_item_id,
        qty: issuedOverride[l.component_item_id] ?? Number((l.qty_per_batch_display * mult).toFixed(3)),
        unit: l.display_unit,
      }));
      const created = await apiFetch('/api/production/runs/start', {
        method: 'POST',
        body: {
          bom_id: selectedBom.id,
          batch_multiplier: mult,
          issued_materials: issuedMaterials,
        },
      });
      setActiveRunId(created.id);
      setIssuedOverride({});
      setBanner({
        type: created.has_variance_alert ? 'warn' : 'success',
        text: `Started ${created.run_no} (${created.finished_item_name}). Raw materials deducted from stock ledger!`,
      });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteRun(e) {
    e.preventDefault();
    if (!activeRunId) return;
    setBusy(true);
    try {
      const completed = await apiFetch(`/api/production/runs/${activeRunId}/complete`, {
        method: 'POST',
        body: {
          actual_good_packets: Number(goodPackets),
          damaged_pouches: Number(damagedPouches),
          cartons_used: Number(cartonsUsed),
          labour_cost_rupees: Number(labourRupees || 0),
          overhead_cost_rupees: Number(overheadRupees || 0),
        },
      });
      setActiveRunId(null);
      setBanner({
        type: completed.has_variance_alert ? 'warn' : 'success',
        text: `Completed ${completed.run_no}: +${completed.actual_good_packets} good packets added to Finished Goods. Cost/packet: ${formatRs(completed.cost_per_packet_paisa)}.`,
      });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateOverheads(run) {
    const edit = overheadEdits[run.id] || {
      labour: (run.labour_cost_paisa / 100).toFixed(0),
      gas: (run.overhead_cost_paisa / 100).toFixed(0),
    };
    setBusy(true);
    try {
      const updated = await apiFetch(`/api/production/runs/${run.id}/overheads`, {
        method: 'PATCH',
        body: {
          labour_cost_rupees: Number(edit.labour || 0),
          overhead_cost_rupees: Number(edit.gas || 0),
        },
      });
      setBanner({
        type: 'success',
        text: `Updated overheads for ${updated.run_no}. Final Cost/Packet: ${formatRs(updated.cost_per_packet_paisa)}`,
      });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickPurchase(e) {
    e.preventDefault();
    const item = masters.items.find((i) => String(i.id) === String(purItemId));
    if (!item) return;
    setBusy(true);
    try {
      const p = await apiFetch('/api/purchases', {
        method: 'POST',
        body: {
          supplier_id: Number(purSupplierId),
          items: [{ item_id: item.id, qty: purQty, unit: item.display_unit, rate_rupees: purRate }],
        },
      });
      setBanner({ type: 'success', text: `Receipt ${p.purchase_no} logged (${purQty} ${item.display_unit} ${item.name}).` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const activeRun = runs.find((r) => r.id === activeRunId && r.status === 'IN_PROGRESS');

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>{t.title}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t.subtitle}</div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setLang((l) => (l === 'en' ? 'ta' : 'en'))}
        >
          {lang === 'en' ? 'தமிழ் (Tamil UI)' : 'Switch to English'}
        </button>
      </div>

      {banner && (
        <div className={`alert alert-${banner.type}`}>
          <span>{banner.text}</span>
          <button type="button" className="btn btn-sm" onClick={() => setBanner(null)}>✕</button>
        </div>
      )}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
          <Icon name="factory" /> {t.runsTab} ({runs.length})
        </button>
        <button className={`tab-btn ${tab === 'stock' ? 'active' : ''}`} onClick={() => setTab('stock')}>
          <Icon name="box" /> {t.stockTab}
        </button>
        <button className={`tab-btn ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>
          <Icon name="chart" /> {t.planTab}
        </button>
      </div>

      {tab === 'runs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="grid-2">
            {/* Step 1: Start Production Run */}
            <div className="card">
              <div className="card-title">{t.startRun}</div>
              <div className="card-subtitle">Select BOM and confirm actual raw materials issued from store.</div>

              <form onSubmit={handleStartRun}>
                <div className="grid-2">
                  <div className="form-group">
                    <label className="form-label">{t.product}</label>
                    <select className="select" value={bomId} onChange={(e) => { setBomId(e.target.value); setIssuedOverride({}); }}>
                      {masters.boms.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.finished_item_name} (1 batch = {b.batch_size_packets} pkts)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t.batches}</label>
                    <input className="input" type="number" step="0.5" min="0.5" value={batchMult} onChange={(e) => setBatchMult(e.target.value)} />
                  </div>
                </div>

                {rawBomLines.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 12 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Raw Material</th>
                          <th className="text-right">BOM Planned</th>
                          <th className="text-right">Actual Issued</th>
                          <th className="text-right">Live Var</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rawBomLines.map((l) => {
                          const planned = Number((l.qty_per_batch_display * Number(batchMult || 1)).toFixed(3));
                          const actual = Number(issuedOverride[l.component_item_id] ?? planned);
                          const pct = planned > 0 ? ((actual - planned) / planned) * 100 : 0;
                          const flagged = Math.abs(pct) > 3;
                          return (
                            <tr key={l.id}>
                              <td><strong>{l.component_name}</strong></td>
                              <td className="text-right num">{planned} {l.display_unit}</td>
                              <td className="text-right">
                                <input
                                  type="number"
                                  step="0.01"
                                  className="input"
                                  style={{ width: 90, textAlign: 'right', padding: '4px 8px' }}
                                  value={issuedOverride[l.component_item_id] ?? planned}
                                  onChange={(e) => setIssuedOverride((p) => ({ ...p, [l.component_item_id]: e.target.value }))}
                                />
                              </td>
                              <td className="text-right num">
                                <span className={`badge ${flagged ? 'badge-danger' : 'badge-neutral'}`}>
                                  {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <button type="submit" className="btn btn-primary" disabled={busy || !selectedBom} style={{ width: '100%' }}>
                  {t.issueBtn}
                </button>
              </form>
            </div>

            {/* Step 2: Complete In-Progress Run */}
            <div className="card">
              <div className="card-title">{t.completeTitle}</div>
              {!activeRun ? (
                <div className="card-soft" style={{ marginTop: 12, color: 'var(--text-muted)' }}>
                  No production run currently in progress. Start a run on the left (or select an in-progress run below) to enter actual good packets, damaged pouches, and cartons used.
                </div>
              ) : (
                <form onSubmit={handleCompleteRun}>
                  <div className="alert alert-info" style={{ marginTop: 8 }}>
                    <span>
                      Active: <strong>{activeRun.run_no}</strong> · {activeRun.finished_item_name} (Expected: <strong>{activeRun.expected_packets}</strong> pkts)
                    </span>
                  </div>
                  <div className="grid-3">
                    <div className="form-group">
                      <label className="form-label">{t.goodPkts}</label>
                      <input className="input" type="number" min="1" value={goodPackets} onChange={(e) => setGoodPackets(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t.damagedPouches}</label>
                      <input className="input" type="number" min="0" value={damagedPouches} onChange={(e) => setDamagedPouches(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t.cartonsUsed}</label>
                      <input className="input" type="number" min="0" value={cartonsUsed} onChange={(e) => setCartonsUsed(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid-2">
                    <div className="form-group">
                      <label className="form-label">{t.labour}</label>
                      <input className="input" type="number" min="0" value={labourRupees} onChange={(e) => setLabourRupees(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">{t.gasPower}</label>
                      <input className="input" type="number" min="0" value={overheadRupees} onChange={(e) => setOverheadRupees(e.target.value)} />
                    </div>
                  </div>
                  <button type="submit" className="btn btn-accent btn-lg" disabled={busy} style={{ width: '100%' }}>
                    <Icon name="check" /> {t.completeBtn}
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* Runs List with Planned vs Actual & Cost/Packet */}
          {runs.map((run) => {
            const ov = overheadEdits[run.id] || {
              labour: (run.labour_cost_paisa / 100).toFixed(0),
              gas: (run.overhead_cost_paisa / 100).toFixed(0),
            };
            const marginPaisa = run.actual_good_packets > 0 ? run.selling_price_paisa - run.cost_per_packet_paisa : 0;
            return (
              <div key={run.id} className="card">
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <div>
                    <div className="flex-row">
                      <strong style={{ fontSize: 16 }}>{run.run_no}</strong>
                      <span className={`badge ${run.status === 'COMPLETED' ? 'badge-success' : 'badge-info'}`}>{run.status}</span>
                      {run.has_variance_alert === 1 && (
                        <span className="badge badge-danger">
                          <Icon name="alert" size={12} /> Variance Alert (&gt;3%)
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>
                      {run.finished_item_name} · Batch: <code>{run.batch_no}</code> · Expiry: {run.expiry_date} · Date: {run.run_date}
                    </div>
                  </div>
                  {run.status === 'IN_PROGRESS' && (
                    <button type="button" className="btn btn-accent btn-sm" onClick={() => setActiveRunId(run.id)}>
                      Enter Output
                    </button>
                  )}
                </div>

                {run.status === 'COMPLETED' && (
                  <div className="grid-4" style={{ background: 'var(--surface-soft)', padding: 12, borderRadius: 8, marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Yield (Expected / Actual)</div>
                      <strong className="num">
                        {run.expected_packets} / {run.actual_good_packets} pkts{' '}
                        <span className={`badge ${Math.abs(run.yield_variance_bps) > 300 ? 'badge-danger' : 'badge-success'}`}>
                          {formatBps(run.yield_variance_bps)}
                        </span>
                      </strong>
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Materials (FIFO) + Overheads</div>
                      <strong className="num">
                        {formatRs(run.material_cost_paisa)} + {formatRs(run.labour_cost_paisa + run.overhead_cost_paisa)}
                      </strong>
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Total Batch Cost</div>
                      <strong className="num">{formatRs(run.total_cost_paisa)}</strong>
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Cost / Packet & Margin</div>
                      <strong className="num" style={{ color: 'var(--primary)', fontSize: 15 }}>
                        {formatRs(run.cost_per_packet_paisa)}
                      </strong>{' '}
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        (Margin {formatRs(marginPaisa)} on {formatRs(run.selling_price_paisa)})
                      </span>
                    </div>
                  </div>
                )}

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Component</th>
                        <th>Type</th>
                        <th className="text-right">Planned (BOM)</th>
                        <th className="text-right">Actual Used</th>
                        <th className="text-right">Damaged</th>
                        <th className="text-right">Total Consumed</th>
                        <th className="text-right">Variance</th>
                        <th className="text-right">FIFO Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.consumptions.map((c) => (
                        <tr key={c.id}>
                          <td><strong>{c.item_name}</strong></td>
                          <td>{c.item_type.replace('_', ' ')}</td>
                          <td className="text-right num">{c.planned_display} {c.display_unit}</td>
                          <td className="text-right num">{c.actual_used_display} {c.display_unit}</td>
                          <td className="text-right num">{c.damaged_display} {c.display_unit}</td>
                          <td className="text-right num"><strong>{c.total_consumed_display} {c.display_unit}</strong></td>
                          <td className="text-right num">
                            <span className={`badge ${c.is_flagged ? 'badge-danger' : 'badge-success'}`}>
                              {formatBps(c.variance_bps)} {c.is_flagged ? 'FLAGGED' : ''}
                            </span>
                          </td>
                          <td className="text-right num">{formatRs(c.fifo_cost_paisa)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {run.status === 'COMPLETED' && (
                  <div className="row-between" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      Allocate / Update Batch Overheads (Labour + Gas/Power):
                    </span>
                    <div className="flex-row">
                      <label style={{ fontSize: 12 }}>Labour ₹</label>
                      <input
                        type="number"
                        className="input"
                        style={{ width: 95, padding: '5px 8px' }}
                        value={ov.labour}
                        onChange={(e) => setOverheadEdits((p) => ({ ...p, [run.id]: { ...ov, labour: e.target.value } }))}
                      />
                      <label style={{ fontSize: 12 }}>Gas/Power ₹</label>
                      <input
                        type="number"
                        className="input"
                        style={{ width: 95, padding: '5px 8px' }}
                        value={ov.gas}
                        onChange={(e) => setOverheadEdits((p) => ({ ...p, [run.id]: { ...ov, gas: e.target.value } }))}
                      />
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => handleUpdateOverheads(run)} disabled={busy}>
                        Recalculate Cost/Packet
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'stock' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Record Raw Material / Packaging Receipt</div>
            <form onSubmit={handleQuickPurchase} style={{ marginTop: 10 }}>
              <div className="form-group">
                <label className="form-label">Supplier</label>
                <select className="select" value={purSupplierId} onChange={(e) => setPurSupplierId(e.target.value)}>
                  {masters.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Item</label>
                <select className="select" value={purItemId} onChange={(e) => setPurItemId(e.target.value)}>
                  {masters.items.filter((i) => i.item_type !== 'finished_good').map((i) => (
                    <option key={i.id} value={i.id}>{i.name} ({i.display_unit})</option>
                  ))}
                </select>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Qty</label>
                  <input className="input" type="number" step="0.01" value={purQty} onChange={(e) => setPurQty(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Rate (₹)</label>
                  <input className="input" type="number" step="0.01" value={purRate} onChange={(e) => setPurRate(e.target.value)} />
                </div>
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>Record Receipt</button>
            </form>
          </div>

          <div className="card">
            <div className="card-title">Always-Current Floor Stock</div>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Type</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right">Earliest Expiry</th>
                  </tr>
                </thead>
                <tbody>
                  {masters.items.map((it) => (
                    <tr key={it.id}>
                      <td><strong>{it.name}</strong></td>
                      <td>{it.item_type.replace('_', ' ')}</td>
                      <td className="text-right num"><strong>{it.balance_display}</strong> {it.display_unit}</td>
                      <td className="text-right">{it.earliest_expiry || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'plan' && (
        <div className="card">
          <div className="card-title">Production Planning from Pending Orders</div>
          <div className="card-subtitle">Automatically calculates how many batches are required to fulfil open sales orders.</div>
          {plan.length === 0 ? (
            <div style={{ color: 'var(--text-muted)' }}>No pending submitted sales orders right now.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="text-right">Pending Orders</th>
                    <th className="text-right">Available FG</th>
                    <th className="text-right">Shortfall</th>
                    <th className="text-right">Batches Needed</th>
                    <th>Action Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((p) => (
                    <tr key={p.item_id}>
                      <td><strong>{p.item_name}</strong></td>
                      <td className="text-right num">{p.pending_order_packets} pkts</td>
                      <td className="text-right num">{p.available_packets} pkts</td>
                      <td className="text-right num">
                        {p.shortfall_packets > 0 ? <span className="badge badge-danger">{p.shortfall_packets} pkts</span> : '0'}
                      </td>
                      <td className="text-right num"><strong>{p.batches_needed}</strong></td>
                      <td>{p.recommendation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
