const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

function injectRequest(app, path, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const rawBody = body ? JSON.stringify(body) : '';
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
    req.method = method;
    req.url = path;
    req.originalUrl = path;
    req.headers = {};
    if (token) req.headers.authorization = `Bearer ${token}`;

    if (body) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(rawBody));
    }

    const resHeaders = {};
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.locals = {};
    res.setHeader = (k, v) => {
      resHeaders[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => resHeaders[k.toLowerCase()];
    res.removeHeader = (k) => delete resHeaders[k.toLowerCase()];
    res.writeHead = (code, hdrs) => {
      res.statusCode = code;
      if (hdrs) Object.entries(hdrs).forEach(([k, v]) => res.setHeader(k, v));
    };
    res.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const buf = Buffer.concat(chunks);
      const text = buf.toString('utf8');
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as string
      }
      resolve({ status: res.statusCode, data: parsed, buffer: buf, headers: resHeaders });
    };

    app.handle(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

test('RBAC enforcement, salesman isolation, offline sync, and export endpoints', async () => {
  const db = createDatabase(':memory:');
  const app = createApp(db);

  const login = async (username) => {
    const r = await injectRequest(app, '/api/auth/login', {
      method: 'POST',
      body: { username, password: 'demo123' },
    });
    assert.equal(r.status, 200);
    return r.data.token;
  };

  const salesmanAToken = await login('salesman_a');
  const salesmanBToken = await login('salesman_b');
  const adminToken = await login('admin');
  const auditorToken = await login('auditor');
  const ownerToken = await login('owner');

  const mastersA = await injectRequest(app, '/api/masters', { token: salesmanAToken });
  assert.equal(mastersA.status, 200);
  assert.equal(mastersA.data.boms, undefined);

  const retA = mastersA.data.customers.find((c) => c.code === 'CUST-RET-A');
  const murukku = mastersA.data.finished_goods.find((p) => p.sku === 'FG-MUR-200');

  const syncRes = await injectRequest(app, '/api/orders/sync-batch', {
    method: 'POST',
    token: salesmanAToken,
    body: {
      orders: [
        {
          customer_id: retA.id,
          items: [{ item_id: murukku.id, qty_packets: 10 }],
          client_offline_id: 'offline-sync-1',
        },
      ],
    },
  });
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.data.synced_count, 1);

  const ordersB = await injectRequest(app, '/api/orders', { token: salesmanBToken });
  assert.equal(ordersB.data.length, 0);

  const forbiddenApprove = await injectRequest(app, `/api/orders/${syncRes.data.orders[0].id}/approve`, {
    method: 'POST',
    token: salesmanAToken,
  });
  assert.equal(forbiddenApprove.status, 403);

  const auditorWrite = await injectRequest(app, '/api/payments', {
    method: 'POST',
    token: auditorToken,
    body: { customer_id: retA.id, amount_rupees: 100 },
  });
  assert.equal(auditorWrite.status, 403);

  const invRes = await injectRequest(app, `/api/orders/${syncRes.data.orders[0].id}/approve`, {
    method: 'POST',
    token: adminToken,
  });
  assert.equal(invRes.status, 201);

  const csvRes = await injectRequest(app, '/api/reports/export/sales/csv', { token: auditorToken });
  assert.equal(csvRes.status, 200);
  assert.ok(String(csvRes.data).includes('INV/2026-27/0001'));

  const pdfRes = await injectRequest(app, '/api/reports/export/monthly/pdf', { token: auditorToken });
  assert.equal(pdfRes.status, 200);
  assert.ok(pdfRes.buffer.toString('latin1').startsWith('%PDF-1.4'));

  const xmlRes = await injectRequest(app, '/api/reports/export/tally/xml', { token: auditorToken });
  assert.equal(xmlRes.status, 200);
  assert.ok(String(xmlRes.data).includes('<VOUCHER'));

  const ownerRes = await injectRequest(app, '/api/dashboard/owner', { token: ownerToken });
  assert.equal(ownerRes.status, 200);
  assert.equal(ownerRes.data.kpis.total_sales_paisa, 52500);
});
