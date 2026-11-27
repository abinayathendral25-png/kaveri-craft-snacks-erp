import { useEffect, useState } from 'react';
import { apiFetch, getStoredToken, setStoredToken } from './api';
import { LoginScreen } from './components/LoginScreen';
import { SalesmanView } from './components/SalesmanView';
import { AdminView } from './components/AdminView';
import { ProductionView } from './components/ProductionView';
import { AuditorView } from './components/AuditorView';
import { OwnerView } from './components/OwnerView';
import { Icon } from './components/Icons';

const BENCHMARK_STEPS = [
  '1. Admin / Supervisor: Record purchase of 60 kg Flour at ₹45/kg.',
  '2. Supervisor: Start Murukku 200 g run — issue 40 kg Flour, 10.5 L Oil (+5%), 1.2 kg Spice mix.',
  '3. Supervisor: Complete run with 188 good packets (-6%), 6 damaged pouches, 9 cartons used.',
  '4. Salesman A: Place mobile order for Retailer A (TN): 150 packets.',
  '5. Admin: Approve order, raise GST invoice (₹7,500 + ₹187.50 CGST + ₹187.50 SGST = ₹7,875), dispatch.',
  '6. Salesman B: Place order for Distributor B (KA): 120 packets → Admin sees 32-packet shortage & IGST preview.',
  '7. Admin: Record ₹4,000 payment from Retailer A → Outstanding becomes ₹3,875.',
  '8. Supervisor: Add ₹1,200 labour + ₹600 gas/power → View ₹30.90/pkt FIFO cost & margin.',
  '9. Auditor: Open Monthly Reports & export Sales, GST, Stock Ledger, Production & Ageing to CSV/PDF.',
];

export function App() {
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function refreshSession() {
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const me = await apiFetch('/api/auth/me');
      setUser(me.user);
      setSettings(me.settings);
    } catch {
      setStoredToken('');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const token = getStoredToken();
    if (!token) {
      Promise.resolve().then(() => {
        if (active) setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    apiFetch('/api/auth/me')
      .then((me) => {
        if (!active) return;
        setUser(me.user);
        setSettings(me.settings);
      })
      .catch(() => {
        if (!active) return;
        setStoredToken('');
        setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function handleLogin({ token, user: loggedUser }) {
    setStoredToken(token);
    setUser(loggedUser);
    refreshSession();
  }

  function handleLogout() {
    setStoredToken('');
    setUser(null);
  }

  async function handleResetBenchmark() {
    if (!window.confirm('Reset database to clean Section 5 Benchmark Master Data?')) return;
    setResetting(true);
    try {
      await apiFetch('/api/demo/reset-seed', { method: 'POST' });
      window.location.reload();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="login-page">
        <div className="card">Loading Order-to-Audit System...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  const roleLabels = {
    salesman: 'Field Salesman',
    admin: 'Factory Admin',
    production: 'Production Supervisor',
    auditor: 'Accountant / Auditor',
    owner: 'Factory Owner',
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">KC</div>
          <div>
            <div className="brand-title">{settings?.company_name || 'Kaveri Craft Snacks'}</div>
            <div className="brand-sub">
              Order-to-Audit System · {settings?.state_name || 'Tamil Nadu'} ({settings?.gstin || '33AABCK4512F1Z8'})
            </div>
          </div>
        </div>

        <div className="topbar-actions">
          <span className="badge badge-info">
            {user.full_name} · {roleLabels[user.role]}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setShowGuide((v) => !v)}>
            {showGuide ? 'Hide Benchmark Steps' : 'Benchmark Checklist'}
          </button>
          <button type="button" className="btn btn-sm" onClick={handleResetBenchmark} disabled={resetting}>
            <Icon name="refresh" size={14} /> Reset Seed Data
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={handleLogout}>
            <Icon name="logout" size={14} /> Switch Role
          </button>
        </div>
      </header>

      <main className="main-container">
        {showGuide && (
          <div className="card-soft" style={{ marginBottom: 18 }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <strong style={{ color: 'var(--primary)' }}>Section 5 Mandatory Benchmark Walkthrough</strong>
              <button type="button" className="btn btn-sm" onClick={() => setShowGuide(false)}>Close</button>
            </div>
            <div className="grid-3" style={{ gap: 8 }}>
              {BENCHMARK_STEPS.map((s, i) => (
                <div key={i} style={{ fontSize: 12.5, background: '#ffffff', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                  {s}
                </div>
              ))}
            </div>
          </div>
        )}

        {user.role === 'salesman' && <SalesmanView user={user} />}
        {user.role === 'admin' && <AdminView />}
        {user.role === 'production' && <ProductionView />}
        {user.role === 'auditor' && <AuditorView readOnlyLabel />}
        {user.role === 'owner' && <OwnerView />}
      </main>
    </div>
  );
}

export default App;
