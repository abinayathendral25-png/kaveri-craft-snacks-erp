import { useEffect, useState } from 'react';
import { apiFetch, buildDownloadUrl, formatRs } from '../api';
import { Icon } from './Icons';

export function AdminView() {
  const [tab, setTab] = useState('orders');
  const [masters, setMasters] = useState({ customers: [], suppliers: [], items: [], finished_goods: [], boms: [] });
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [payments, setPayments] = useState([]);
  const [editQty, setEditQty] = useState({});
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  // Purchase form
  const [purSupplierId, setPurSupplierId] = useState('');
  const [purItemId, setPurItemId] = useState('');
  const [purQty, setPurQty] = useState('60');
  const [purRate, setPurRate] = useState('45');
  const [purBill, setPurBill] = useState('MILL-2026-101');

  // Payment form
  const [payInvoiceId, setPayInvoiceId] = useState('');
  const [payAmount, setPayAmount] = useState('4000');
  const [payMode, setPayMode] = useState('NEFT');
  const [payRef, setPayRef] = useState('UTR889210');

  // New Product / Pack Size form (ready for interview "add 500g pack size" demo!)
  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newPackG, setNewPackG] = useState('500');
  const [newPrice, setNewPrice] = useState('120');
  const [copyBomItemId, setCopyBomItemId] = useState('');

  async function loadAll() {
    try {
      const [m, o, inv, pur, pay] = await Promise.all([
        apiFetch('/api/masters'),
        apiFetch('/api/orders'),
        apiFetch('/api/invoices'),
        apiFetch('/api/purchases'),
        apiFetch('/api/payments'),
      ]);
      setMasters(m);
      setOrders(o);
      setInvoices(inv);
      setPurchases(pur);
      setPayments(pay);

      setPurSupplierId((prev) => prev || (m.suppliers[0] ? String(m.suppliers[0].id) : ''));
      setPurItemId((prev) => {
        if (prev) return prev;
        const flour = m.items.find((i) => i.sku === 'RM-FLOUR') || m.items[0];
        return flour ? String(flour.id) : '';
      });
      setCopyBomItemId((prev) => prev || (m.finished_goods[0] ? String(m.finished_goods[0].id) : ''));
      setPayInvoiceId((prev) => {
        if (prev) return prev;
        const openInv = inv.find((i) => i.status === 'POSTED' && i.outstanding_paisa > 0);
        return openInv ? String(openInv.id) : '';
      });
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch('/api/masters'),
      apiFetch('/api/orders'),
      apiFetch('/api/invoices'),
      apiFetch('/api/purchases'),
      apiFetch('/api/payments'),
    ])
      .then(([m, o, inv, pur, pay]) => {
        if (!active) return;
        setMasters(m);
        setOrders(o);
        setInvoices(inv);
        setPurchases(pur);
        setPayments(pay);
        if (m.suppliers[0]) setPurSupplierId(String(m.suppliers[0].id));
        const flour = m.items.find((i) => i.sku === 'RM-FLOUR') || m.items[0];
        if (flour) setPurItemId(String(flour.id));
        if (m.finished_goods[0]) setCopyBomItemId(String(m.finished_goods[0].id));
        const openInv = inv.find((i) => i.status === 'POSTED' && i.outstanding_paisa > 0);
        if (openInv) setPayInvoiceId(String(openInv.id));
      })
      .catch((err) => {
        if (active) setBanner({ type: 'danger', text: err.message });
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleApprove(order) {
    setBusy(true);
    setBanner(null);
    try {
      const editedItems = order.items.map((it) => ({
        item_id: it.item_id,
        qty_packets: Number(editQty[`${order.id}_${it.item_id}`] ?? it.qty_packets),
      }));
      const inv = await apiFetch(`/api/orders/${order.id}/approve`, {
        method: 'POST',
        body: { edited_items: editedItems },
      });
      setBanner({
        type: 'success',
        text: `Approved ${order.order_no} and raised GST Tax Invoice ${inv.invoice_no} (${formatRs(inv.total_paisa)})`,
      });
      await loadAll();
      setTab('invoices');
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(order) {
    const reason = window.prompt(`Reason to reject ${order.order_no}:`, 'Stock unavailable');
    if (!reason) return;
    setBusy(true);
    try {
      await apiFetch(`/api/orders/${order.id}/reject`, { method: 'POST', body: { reason } });
      setBanner({ type: 'warn', text: `Order ${order.order_no} rejected.` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDispatch(inv, partial = false) {
    setBusy(true);
    try {
      let body = {};
      if (partial) {
        const first = inv.items[0];
        const pending = first.qty_packets - first.dispatched_packets;
        const val = window.prompt(`Packets to dispatch now for ${first.item_name} (Pending: ${pending}):`, String(pending));
        if (!val) {
          setBusy(false);
          return;
        }
        body = { items: [{ item_id: first.item_id, qty_packets: Number(val) }] };
      }
      const updated = await apiFetch(`/api/invoices/${inv.id}/dispatch`, { method: 'POST', body });
      setBanner({
        type: 'success',
        text: `Dispatch recorded for ${updated.invoice_no}. Status: ${updated.dispatch_status}. Finished goods stock updated.`,
      });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreditNote(inv) {
    const reason = window.prompt(`Cancel ${inv.invoice_no} via Credit Note. Enter reason:`, 'Order cancelled / billing correction');
    if (!reason) return;
    const restock = inv.dispatch_status !== 'PENDING' && window.confirm('Restock dispatched packets back into inventory?');
    setBusy(true);
    try {
      await apiFetch(`/api/invoices/${inv.id}/credit-note`, {
        method: 'POST',
        body: { reason, restock_goods: restock },
      });
      setBanner({ type: 'warn', text: `Invoice ${inv.invoice_no} cancelled via Credit Note (preserved in audit trail).` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function submitPurchase(e) {
    e.preventDefault();
    const item = masters.items.find((i) => String(i.id) === String(purItemId));
    if (!item) return;
    setBusy(true);
    try {
      const p = await apiFetch('/api/purchases', {
        method: 'POST',
        body: {
          supplier_id: Number(purSupplierId),
          supplier_bill_no: purBill,
          items: [{ item_id: item.id, qty: purQty, unit: item.display_unit, rate_rupees: purRate }],
        },
      });
      setBanner({ type: 'success', text: `Purchase ${p.purchase_no} recorded (${formatRs(p.total_paisa)}). Stock ledger updated!` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function submitPayment(e) {
    e.preventDefault();
    const inv = invoices.find((i) => String(i.id) === String(payInvoiceId));
    if (!inv) return;
    setBusy(true);
    try {
      const pay = await apiFetch('/api/payments', {
        method: 'POST',
        body: {
          customer_id: inv.customer_id,
          invoice_id: inv.id,
          amount_rupees: payAmount,
          payment_mode: payMode,
          reference_no: payRef,
        },
      });
      setBanner({ type: 'success', text: `Payment receipt ${pay.receipt_no} recorded for ${inv.customer_name}.` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function submitNewProduct(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await apiFetch('/api/masters/products', {
        method: 'POST',
        body: {
          sku: newSku,
          name: newName,
          pack_size_g: Number(newPackG),
          selling_price_rupees: newPrice,
          copy_bom_from_item_id: copyBomItemId ? Number(copyBomItemId) : null,
          scale_factor: Number(newPackG) / 200,
        },
      });
      setNewSku('');
      setNewName('');
      setBanner({ type: 'success', text: `Added ${created.name} with scaled BOM!` });
      await loadAll();
    } catch (err) {
      setBanner({ type: 'danger', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const pendingOrdersCount = orders.filter((o) => o.status === 'SUBMITTED').length;

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Factory Admin & GST Billing Desk</h2>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Verify orders against live stock, issue GST tax invoices, dispatch goods, and record purchases & collections
          </div>
        </div>
      </div>

      {banner && (
        <div className={`alert alert-${banner.type}`}>
          <span>{banner.text}</span>
          <button type="button" className="btn btn-sm" onClick={() => setBanner(null)}>✕</button>
        </div>
      )}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>
          <Icon name="cart" /> Orders Queue ({pendingOrdersCount} Pending)
        </button>
        <button className={`tab-btn ${tab === 'invoices' ? 'active' : ''}`} onClick={() => setTab('invoices')}>
          <Icon name="file" /> GST Invoices & Dispatch ({invoices.length})
        </button>
        <button className={`tab-btn ${tab === 'purchases' ? 'active' : ''}`} onClick={() => setTab('purchases')}>
          <Icon name="box" /> Purchases & Stock
        </button>
        <button className={`tab-btn ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>
          <Icon name="wallet" /> Payments & Receivables
        </button>
        <button className={`tab-btn ${tab === 'masters' ? 'active' : ''}`} onClick={() => setTab('masters')}>
          <Icon name="factory" /> Products & BOMs
        </button>
      </div>

      {tab === 'orders' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {orders.length === 0 && <div className="card">No field orders received yet.</div>}
          {orders.map((ord) => {
            const sc = ord.stock_check;
            return (
              <div key={ord.id} className="card">
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <div>
                    <div className="flex-row">
                      <strong style={{ fontSize: 16 }}>{ord.order_no}</strong>
                      <span className={`badge ${ord.status === 'SUBMITTED' ? 'badge-warn' : ord.status === 'REJECTED' ? 'badge-danger' : 'badge-success'}`}>
                        {ord.status}
                      </span>
                      <span className={`badge ${sc.is_interstate ? 'badge-warn' : 'badge-info'}`}>
                        {sc.tax_type} · {ord.customer_state}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>
                      Customer: <strong>{ord.customer_name}</strong> · Salesman: {ord.salesman_name} · Date: {ord.order_date}
                    </div>
                  </div>

                  <div>
                    {sc.all_sufficient ? (
                      <span className="badge badge-success">
                        <Icon name="check" size={13} /> Stock Covers Order
                      </span>
                    ) : (
                      <span className="badge badge-danger">
                        <Icon name="alert" size={13} /> Insufficient Stock
                      </span>
                    )}
                  </div>
                </div>

                <div className="table-wrap" style={{ marginBottom: 12 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th className="text-right">Ordered Qty</th>
                        <th className="text-right">Available FG Stock</th>
                        <th className="text-right">Shortage</th>
                        <th className="text-right">Rate</th>
                        <th className="text-right">Taxable</th>
                        <th className="text-right">GST (5%)</th>
                        <th className="text-right">Line Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ord.items.map((it) => {
                        const key = `${ord.id}_${it.item_id}`;
                        const currentVal = editQty[key] ?? it.qty_packets;
                        return (
                          <tr key={it.id}>
                            <td><strong>{it.item_name}</strong></td>
                            <td className="text-right num">
                              {ord.status === 'SUBMITTED' ? (
                                <input
                                  type="number"
                                  min="1"
                                  className="input"
                                  style={{ width: 84, textAlign: 'right', padding: '4px 8px' }}
                                  value={currentVal}
                                  onChange={(e) => setEditQty((p) => ({ ...p, [key]: e.target.value }))}
                                />
                              ) : (
                                `${it.qty_packets} pkts`
                              )}
                            </td>
                            <td className="text-right num">{it.available_packets} pkts</td>
                            <td className="text-right num">
                              {it.shortage_packets > 0 ? (
                                <span className="badge badge-danger">Short {it.shortage_packets} pkts</span>
                              ) : (
                                <span className="badge badge-success">OK</span>
                              )}
                            </td>
                            <td className="text-right num">{formatRs(it.unit_price_paisa)}</td>
                            <td className="text-right num">{formatRs(it.taxablePaisa)}</td>
                            <td className="text-right num">
                              {sc.is_interstate
                                ? `IGST ${formatRs(it.igstPaisa)}`
                                : `C+S ${formatRs(it.cgstPaisa + it.sgstPaisa)}`}
                            </td>
                            <td className="text-right num"><strong>{formatRs(it.totalPaisa)}</strong></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {!sc.all_sufficient && ord.status === 'SUBMITTED' && (
                  <div className="alert alert-danger" style={{ marginBottom: 10 }}>
                    <div>
                      <strong>Stock Shortage Detected:</strong> Finished goods stock cannot cover this order.
                      {sc.is_interstate && (
                        <span> Note: Because {ord.customer_name} is in {ord.customer_state}, <strong>IGST (5% = {formatRs(sc.igst_paisa)})</strong> applies when invoiced.</span>
                      )}
                      <span> Adjust quantity to available stock or log a Production Run first.</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const patch = {};
                        ord.items.forEach((it) => {
                          patch[`${ord.id}_${it.item_id}`] = Math.min(it.qty_packets, it.available_packets);
                        });
                        setEditQty((p) => ({ ...p, ...patch }));
                      }}
                    >
                      Fill Available ({ord.items[0]?.available_packets})
                    </button>
                  </div>
                )}

                {ord.status === 'SUBMITTED' && (
                  <div className="row-between">
                    <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                      Invoice Preview: Taxable <strong>{formatRs(sc.taxable_paisa)}</strong> +{' '}
                      {sc.is_interstate
                        ? `IGST ${formatRs(sc.igst_paisa)}`
                        : `CGST ${formatRs(sc.cgst_paisa)} + SGST ${formatRs(sc.sgst_paisa)}`}{' '}
                      = <strong>{formatRs(sc.total_paisa)}</strong>
                    </div>
                    <div className="flex-row">
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => handleReject(ord)} disabled={busy}>
                        Reject
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => handleApprove(ord)} disabled={busy}>
                        <Icon name="check" /> Approve & Raise GST Invoice
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'invoices' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {invoices.length === 0 && <div className="card">No GST invoices generated yet.</div>}
          {invoices.map((inv) => {
            const waText = encodeURIComponent(
              `Invoice ${inv.invoice_no} from Kaveri Craft Snacks\nCustomer: ${inv.customer_name}\nTotal: ${formatRs(inv.total_paisa)} (${inv.is_interstate ? 'IGST' : 'CGST+SGST'})\nOutstanding: ${formatRs(inv.outstanding_paisa)}`
            );
            return (
              <div key={inv.id} className="card">
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <div>
                    <div className="flex-row">
                      <strong style={{ fontSize: 16 }}>{inv.invoice_no}</strong>
                      <span className={`badge ${inv.status === 'CANCELLED' ? 'badge-danger' : 'badge-success'}`}>{inv.status}</span>
                      <span className={`badge ${inv.dispatch_status === 'DISPATCHED' ? 'badge-success' : inv.dispatch_status === 'PARTIAL' ? 'badge-warn' : 'badge-info'}`}>
                        Dispatch: {inv.dispatch_status}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>
                      {inv.customer_name} · Place of Supply: {inv.place_of_supply_state} ({inv.place_of_supply_code}) · Date: {inv.invoice_date}
                    </div>
                  </div>

                  <div className="flex-row">
                    <a
                      className="btn btn-sm"
                      href={buildDownloadUrl(`/api/invoices/${inv.id}/pdf`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="download" size={14} /> PDF Invoice
                    </a>
                    <a
                      className="btn btn-sm"
                      href={`https://wa.me/?text=${waText}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      WhatsApp Share
                    </a>
                    {inv.status === 'POSTED' && inv.dispatch_status !== 'DISPATCHED' && (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => handleDispatch(inv, true)} disabled={busy}>
                          Partial Dispatch
                        </button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => handleDispatch(inv, false)} disabled={busy}>
                          <Icon name="truck" size={14} /> Record Full Dispatch
                        </button>
                      </>
                    )}
                    {inv.status === 'POSTED' && (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => handleCreditNote(inv)} disabled={busy}>
                        Cancel (Credit Note)
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid-4" style={{ background: 'var(--surface-soft)', padding: 12, borderRadius: 8 }}>
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Taxable Value</div>
                    <strong className="num">{formatRs(inv.taxable_paisa)}</strong>
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{inv.is_interstate ? 'IGST (5%)' : 'CGST (2.5%) + SGST (2.5%)'}</div>
                    <strong className="num">
                      {inv.is_interstate
                        ? formatRs(inv.igst_paisa)
                        : `${formatRs(inv.cgst_paisa)} + ${formatRs(inv.sgst_paisa)}`}
                    </strong>
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Invoice Total</div>
                    <strong className="num" style={{ color: 'var(--primary)' }}>{formatRs(inv.total_paisa)}</strong>
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Paid / Outstanding</div>
                    <strong className="num">{formatRs(inv.paid_paisa)} / {formatRs(inv.outstanding_paisa)}</strong>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'purchases' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Record Raw / Packaging Purchase</div>
            <div className="card-subtitle">Creates a new FIFO cost lot and updates stock ledger immediately.</div>
            <form onSubmit={submitPurchase}>
              <div className="form-group">
                <label className="form-label">Supplier</label>
                <select className="select" value={purSupplierId} onChange={(e) => setPurSupplierId(e.target.value)}>
                  {masters.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Material / Packaging Item</label>
                <select className="select" value={purItemId} onChange={(e) => setPurItemId(e.target.value)}>
                  {masters.items
                    .filter((i) => i.item_type !== 'finished_good')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.display_unit}) · Bal: {i.balance_display}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Quantity</label>
                  <input className="input" type="number" step="0.01" value={purQty} onChange={(e) => setPurQty(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Rate per Unit (₹)</label>
                  <input className="input" type="number" step="0.01" value={purRate} onChange={(e) => setPurRate(e.target.value)} required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Supplier Bill Ref</label>
                <input className="input" value={purBill} onChange={(e) => setPurBill(e.target.value)} />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
                Record Purchase & Update Ledger
              </button>
            </form>
          </div>

          <div className="card">
            <div className="card-title">Live Inventory Balances (Ledger Derived)</div>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right">FIFO Value</th>
                  </tr>
                </thead>
                <tbody>
                  {masters.items.map((it) => (
                    <tr key={it.id}>
                      <td>
                        <strong>{it.name}</strong>
                        {it.is_low_stock && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Low</span>}
                      </td>
                      <td>{it.item_type.replace('_', ' ')}</td>
                      <td className="text-right num"><strong>{it.balance_display}</strong> {it.display_unit}</td>
                      <td className="text-right num">{formatRs(it.fifo_value_paisa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {purchases.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Recent Purchases</div>
                {purchases.slice(0, 4).map((p) => (
                  <div key={p.id} className="row-between" style={{ fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid #f0ebe2' }}>
                    <span>{p.purchase_no} · {p.items.map((x) => `${x.item_name} (${x.qty_display} ${x.input_unit})`).join(', ')}</span>
                    <strong className="num">{formatRs(p.total_paisa)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Record Customer Payment</div>
            <div className="card-subtitle">Reduces customer invoice outstanding immediately.</div>
            <form onSubmit={submitPayment}>
              <div className="form-group">
                <label className="form-label">Select Open Invoice</label>
                <select className="select" value={payInvoiceId} onChange={(e) => setPayInvoiceId(e.target.value)}>
                  <option value="">-- Select posted invoice --</option>
                  {invoices
                    .filter((i) => i.status === 'POSTED')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.invoice_no} · {i.customer_name} (Due: {formatRs(i.outstanding_paisa)})
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Amount Received (₹)</label>
                  <input className="input" type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Mode</label>
                  <select className="select" value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                    <option value="NEFT">NEFT / RTGS</option>
                    <option value="UPI">UPI</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Reference / UTR No</label>
                <input className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy || !payInvoiceId} style={{ width: '100%' }}>
                Record Payment Receipt
              </button>
            </form>
          </div>

          <div className="card">
            <div className="card-title">Receipts History</div>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Customer</th>
                    <th>Invoice</th>
                    <th>Mode</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.length === 0 && (
                    <tr><td colSpan="5" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No payments recorded yet</td></tr>
                  )}
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.receipt_no}</strong></td>
                      <td>{p.customer_name}</td>
                      <td>{p.invoice_no || '-'}</td>
                      <td>{p.payment_mode}</td>
                      <td className="text-right num"><strong>{formatRs(p.amount_paisa)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'masters' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">Add New Pack Size / Product</div>
            <div className="card-subtitle">Share & scale an existing recipe BOM automatically (e.g. add 500 g pack size).</div>
            <form onSubmit={submitNewProduct}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">SKU Code</label>
                  <input className="input" value={newSku} onChange={(e) => setNewSku(e.target.value)} placeholder="FG-MUR-500" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Product Name</label>
                  <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Murukku 500 g" required />
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Pack Weight (g)</label>
                  <input className="input" type="number" value={newPackG} onChange={(e) => setNewPackG(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Selling Price (₹)</label>
                  <input className="input" type="number" step="0.01" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Share BOM Recipe From</label>
                <select className="select" value={copyBomItemId} onChange={(e) => setCopyBomItemId(e.target.value)}>
                  {masters.finished_goods.map((fg) => (
                    <option key={fg.id} value={fg.id}>{fg.name}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>Create Product & Scaled BOM</button>
            </form>
          </div>

          <div className="card">
            <div className="card-title">Bill of Materials (BOM) Masters</div>
            {masters.boms.map((b) => (
              <div key={b.id} className="card-soft" style={{ marginTop: 10 }}>
                <div className="row-between">
                  <strong>{b.finished_item_name}</strong>
                  <span className="badge badge-info">1 Batch = {b.batch_size_packets} pkts</span>
                </div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)' }}>
                  {b.lines.map((l) => (
                    <li key={l.id}>{l.component_name}: <strong>{l.qty_per_batch_display} {l.display_unit}</strong></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
