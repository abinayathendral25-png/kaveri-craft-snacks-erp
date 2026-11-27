import { useEffect, useState } from 'react';
import { apiFetch, buildDownloadUrl, formatRs, generateOfflineId, getOfflineQueue, saveOfflineQueue } from '../api';
import { Icon } from './Icons';

export function SalesmanView({ user }) {
  const [tab, setTab] = useState('new');
  const [mobilePreview, setMobilePreview] = useState(true);
  const [simulateOffline, setSimulateOffline] = useState(!navigator.onLine);
  const [masters, setMasters] = useState({ customers: [], finished_goods: [] });
  const [orders, setOrders] = useState([]);
  const [visits, setVisits] = useState([]);
  const [offlineQueue, setOfflineQueue] = useState(() => getOfflineQueue(user.username));

  const [customerId, setCustomerId] = useState('');
  const [quantities, setQuantities] = useState({});
  const [unitMode, setUnitMode] = useState({}); // 'packet' | 'carton'
  const [notes, setNotes] = useState('');
  const [visitOutcome, setVisitOutcome] = useState('Order Taken');
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadData() {
    try {
      const [m, o, v] = await Promise.all([
        apiFetch('/api/masters'),
        apiFetch('/api/orders'),
        apiFetch('/api/visits'),
      ]);
      setMasters(m);
      setOrders(o);
      setVisits(v);
      if (!customerId && m.customers.length > 0) {
        setCustomerId(String(m.customers[0].id));
      }
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([apiFetch('/api/masters'), apiFetch('/api/orders'), apiFetch('/api/visits')])
      .then(([m, o, v]) => {
        if (!active) return;
        setMasters(m);
        setOrders(o);
        setVisits(v);
        if (m.customers.length > 0) {
          setCustomerId((prev) => prev || String(m.customers[0].id));
        }
      })
      .catch((err) => {
        if (active) setBanner({ type: 'danger', text: err.message });
      });
    const handleOnline = () => setSimulateOffline(false);
    const handleOffline = () => setSimulateOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [user.username]);

  const selectedCustomer = masters.customers.find((c) => String(c.id) === String(customerId));
  const isInterstate = selectedCustomer && masters.settings && selectedCustomer.state_code !== masters.settings.state_code;

  const lineItems = masters.finished_goods
    .map((p) => {
      const rawQty = Number(quantities[p.id] || 0);
      if (rawQty <= 0) return null;
      const mode = unitMode[p.id] || 'packet';
      const qtyPackets = mode === 'carton' ? rawQty * (p.packets_per_carton || 20) : rawQty;
      const taxable = qtyPackets * p.selling_price_paisa;
      const gst = Math.round((taxable * p.gst_rate_bps) / 10000);
      return {
        item: p,
        qtyPackets,
        taxable,
        gst,
        total: taxable + gst,
      };
    })
    .filter(Boolean);

  const orderSummary = lineItems.reduce(
    (acc, l) => ({
      taxable: acc.taxable + l.taxable,
      gst: acc.gst + l.gst,
      total: acc.total + l.total,
    }),
    { taxable: 0, gst: 0, total: 0 }
  );

  function setQty(itemId, val) {
    const clean = Math.max(0, Math.round(Number(val) || 0));
    setQuantities((prev) => ({ ...prev, [itemId]: clean }));
  }

  async function submitOrder(e) {
    e.preventDefault();
    if (!customerId || lineItems.length === 0) {
      setBanner({ type: 'warn', text: 'Select a customer and add at least 1 product quantity.' });
      return;
    }

    const payload = {
      customer_id: Number(customerId),
      customer_name: selectedCustomer?.name,
      items: lineItems.map((l) => ({ item_id: l.item.id, qty_packets: l.qtyPackets })),
      order_date: new Date().toISOString().slice(0, 10),
      client_offline_id: generateOfflineId(user.username),
      notes,
      estimated_total_paisa: orderSummary.total,
    };

    if (simulateOffline) {
      const nextQueue = [payload, ...offlineQueue];
      setOfflineQueue(nextQueue);
      saveOfflineQueue(user.username, nextQueue);
      setQuantities({});
      setNotes('');
      setBanner({
        type: 'warn',
        text: `Saved offline on device (${nextQueue.length} pending sync). Tap "Sync Now" when network returns.`,
      });
      return;
    }

    setBusy(true);
    try {
      const created = await apiFetch('/api/orders', { method: 'POST', body: payload });
      setQuantities({});
      setNotes('');
      setBanner({
        type: 'success',
        text: `Order ${created.order_no} sent straight to Factory Admin!`,
      });
      await loadData();
      setTab('orders');
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function syncOfflineOrders() {
    if (offlineQueue.length === 0) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/orders/sync-batch', {
        method: 'POST',
        body: { orders: offlineQueue },
      });
      setOfflineQueue([]);
      saveOfflineQueue(user.username, []);
      setSimulateOffline(false);
      setBanner({
        type: 'success',
        text: `Synced ${res.synced_count} offline order(s) to factory!`,
      });
      await loadData();
      setTab('orders');
    } catch (err) {
      setBanner({ type: 'danger', text: `Sync failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function logVisitCheckIn() {
    if (!customerId) return;
    const recordVisit = async (lat = null, lng = null) => {
      try {
        await apiFetch('/api/visits', {
          method: 'POST',
          body: { customer_id: Number(customerId), outcome: visitOutcome, latitude: lat, longitude: lng, notes },
        });
        setBanner({ type: 'success', text: `Check-in logged for ${selectedCustomer?.name}` });
        await loadData();
      } catch (err) {
        setBanner({ type: 'danger', text: err.message });
      }
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => recordVisit(Number(pos.coords.latitude.toFixed(5)), Number(pos.coords.longitude.toFixed(5))),
        () => recordVisit(10.7905, 78.7047), // Fallback Tiruchirappalli coords if permission denied
        { timeout: 2500 }
      );
    } else {
      recordVisit(10.7905, 78.7047);
    }
  }

  // Customer-wise sales summary for this salesman
  const customerSalesMap = new Map();
  for (const ord of orders) {
    const prev = customerSalesMap.get(ord.customer_id) || {
      name: ord.customer_name,
      state: ord.customer_state,
      orders: 0,
      totalPaisa: 0,
    };
    prev.orders += 1;
    prev.totalPaisa += ord.invoice_total_paisa || ord.stock_check?.total_paisa || 0;
    customerSalesMap.set(ord.customer_id, prev);
  }

  const content = (
    <div className={mobilePreview ? 'mobile-frame' : 'card'} style={!mobilePreview ? { maxWidth: 680, margin: '0 auto', padding: 0, overflow: 'hidden' } : undefined}>
      <div className="mobile-header">
        <div className="row-between">
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Field Order App</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>{user.full_name}</div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSimulateOffline((v) => !v)}
            style={{
              background: simulateOffline ? '#fef3c7' : 'rgba(255,255,255,0.18)',
              color: simulateOffline ? '#92400e' : '#ffffff',
              borderColor: 'transparent',
            }}
          >
            <Icon name="wifi-off" size={14} />
            {simulateOffline ? 'Offline Mode ON' : 'Online'}
          </button>
        </div>

        {offlineQueue.length > 0 && (
          <div
            style={{
              marginTop: 10,
              background: '#fffbeb',
              color: '#92400e',
              borderRadius: 8,
              padding: '8px 10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            <span>{offlineQueue.length} offline order(s) waiting</span>
            <button type="button" className="btn btn-sm btn-accent" onClick={syncOfflineOrders} disabled={busy}>
              <Icon name="refresh" size={13} /> Sync Now
            </button>
          </div>
        )}
      </div>

      <div className="mobile-body">
        {banner && (
          <div className={`alert alert-${banner.type}`}>
            <span>{banner.text}</span>
            <button type="button" className="btn btn-sm" onClick={() => setBanner(null)}>✕</button>
          </div>
        )}

        {tab === 'new' && (
          <form onSubmit={submitOrder}>
            <div className="card" style={{ marginBottom: 12 }}>
              <label className="form-label">1. Select Retailer / Distributor</label>
              <select
                className="select"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                style={{ marginTop: 5 }}
              >
                {masters.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.state_name}
                  </option>
                ))}
              </select>
              {selectedCustomer && (
                <div className="flex-row" style={{ marginTop: 8 }}>
                  <span className="badge badge-neutral">{selectedCustomer.customer_type.toUpperCase()}</span>
                  <span className={`badge ${isInterstate ? 'badge-warn' : 'badge-info'}`}>
                    {isInterstate ? 'Inter-State · IGST 5%' : 'Tamil Nadu · CGST+SGST 5%'}
                  </span>
                </div>
              )}
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <span className="form-label" style={{ margin: 0 }}>2. Add Snacks & Quantities</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-subtle)' }}>Tap + or type</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {masters.finished_goods.map((p) => {
                  const qty = quantities[p.id] || 0;
                  const mode = unitMode[p.id] || 'packet';
                  return (
                    <div
                      key={p.id}
                      style={{
                        border: qty > 0 ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                        background: qty > 0 ? 'var(--primary-soft)' : '#ffffff',
                        borderRadius: 10,
                        padding: '10px 12px',
                      }}
                    >
                      <div className="row-between">
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {formatRs(p.selling_price_paisa)} / pkt · Stock: <strong>{p.balance_display}</strong> pkts
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setUnitMode((prev) => ({
                              ...prev,
                              [p.id]: mode === 'packet' ? 'carton' : 'packet',
                            }))
                          }
                        >
                          {mode === 'packet' ? 'Packets' : `Cartons (${p.packets_per_carton})`}
                        </button>
                      </div>

                      <div className="row-between" style={{ marginTop: 8 }}>
                        <div className="flex-row">
                          {[50, 100, 150].map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setUnitMode((prev) => ({ ...prev, [p.id]: 'packet' }));
                                setQty(p.id, preset);
                              }}
                            >
                              {preset}
                            </button>
                          ))}
                        </div>

                        <div className="stepper">
                          <button type="button" onClick={() => setQty(p.id, qty - 10)}>−</button>
                          <input
                            type="number"
                            min="0"
                            value={qty || ''}
                            placeholder="0"
                            onChange={(e) => setQty(p.id, e.target.value)}
                          />
                          <button type="button" onClick={() => setQty(p.id, qty + 10)}>+</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <label className="form-label">Order Note (optional)</label>
              <input
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Delivery preference or scheme note"
                style={{ marginTop: 4, marginBottom: 10 }}
              />

              <div className="row-between" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                <span>Taxable Value</span>
                <span className="num">{formatRs(orderSummary.taxable)}</span>
              </div>
              <div className="row-between" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                <span>Estimated GST (5%)</span>
                <span className="num">{formatRs(orderSummary.gst)}</span>
              </div>
              <div className="row-between" style={{ fontSize: 16, fontWeight: 800, marginTop: 6 }}>
                <span>Total Estimate</span>
                <span className="num" style={{ color: 'var(--primary)' }}>{formatRs(orderSummary.total)}</span>
              </div>

              <button
                type="submit"
                className={`btn btn-lg ${simulateOffline ? 'btn-accent' : 'btn-primary'}`}
                disabled={busy || lineItems.length === 0}
                style={{ width: '100%', marginTop: 12 }}
              >
                <Icon name="cart" />
                {simulateOffline ? 'Save Order Offline' : 'Submit Order to Factory'}
              </button>
            </div>
          </form>
        )}

        {tab === 'orders' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orders.length === 0 && <div className="card">No orders placed yet.</div>}
            {orders.map((o) => {
              const badgeClass =
                o.status === 'DISPATCHED'
                  ? 'badge-success'
                  : o.status === 'INVOICED'
                    ? 'badge-info'
                    : o.status === 'REJECTED'
                      ? 'badge-danger'
                      : 'badge-warn';
              return (
                <div key={o.id} className="card">
                  <div className="row-between">
                    <div>
                      <div style={{ fontWeight: 800 }}>{o.order_no}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{o.customer_name}</div>
                    </div>
                    <span className={`badge ${badgeClass}`}>{o.status}</span>
                  </div>
                  <div className="divider" style={{ margin: '10px 0' }} />
                  {o.items.map((it) => (
                    <div key={it.id} className="row-between" style={{ fontSize: 13 }}>
                      <span>{it.item_name} × <strong>{it.qty_packets}</strong> pkts</span>
                      <span className="num">{formatRs(it.line_taxable_paisa)}</span>
                    </div>
                  ))}
                  <div className="row-between" style={{ marginTop: 8, fontSize: 12.5 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{o.order_date}</span>
                    {o.invoice_id && (
                      <a
                        className="btn btn-sm"
                        href={buildDownloadUrl(`/api/invoices/${o.invoice_id}/pdf`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon name="file" size={13} /> {o.invoice_no} PDF
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'sales' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <div className="card-title">Customer-wise Sales</div>
              {[...customerSalesMap.values()].map((cs, idx) => (
                <div key={idx} className="row-between" style={{ padding: '8px 0', borderBottom: '1px solid #f0ebe2' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{cs.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cs.orders} order(s) · {cs.state}</div>
                  </div>
                  <strong className="num">{formatRs(cs.totalPaisa)}</strong>
                </div>
              ))}
              {customerSalesMap.size === 0 && <div style={{ color: 'var(--text-muted)' }}>No orders yet.</div>}
            </div>

            <div className="card">
              <div className="card-title">Route Visit / GPS Check-In</div>
              <div className="form-group" style={{ marginTop: 8 }}>
                <select className="select" value={visitOutcome} onChange={(e) => setVisitOutcome(e.target.value)}>
                  <option>Order Taken</option>
                  <option>Follow-up / Payment Collected</option>
                  <option>Shop Closed</option>
                </select>
              </div>
              <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={logVisitCheckIn}>
                <Icon name="pin" /> Check In at Selected Customer
              </button>
              {visits.slice(0, 4).map((v) => (
                <div key={v.id} style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  • {v.customer_name} — <strong>{v.outcome}</strong> ({v.latitude}, {v.longitude})
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mobile-nav">
        <button type="button" className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>
          <Icon name="cart" size={18} />
          New Order
        </button>
        <button type="button" className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
          <Icon name="file" size={18} />
          My Orders ({orders.length})
        </button>
        <button type="button" className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>
          <Icon name="pin" size={18} />
          Sales & Visits
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19 }}>Field Salesman Mobile Console</h2>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            Place orders in under 30 seconds · Works offline and syncs automatically
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setMobilePreview((v) => !v)}>
          {mobilePreview ? 'Expand Full Width' : 'Show Mobile Frame'}
        </button>
      </div>
      {content}
    </div>
  );
}
