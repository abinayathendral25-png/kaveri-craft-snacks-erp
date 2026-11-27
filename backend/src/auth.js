const crypto = require('node:crypto');

const TOKEN_SECRET = process.env.AUTH_SECRET || 'order-to-audit-nitt-dev-secret-2026';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || '').split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function signToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    full_name: user.full_name,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token);
  }
  return null;
}

function requireAuth(dbGetter) {
  return (req, res, next) => {
    const token = extractToken(req);
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const db = dbGetter();
    const user = db
      .prepare('SELECT id, username, full_name, role, phone, active FROM users WHERE id = ?')
      .get(payload.id);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'User account not found or inactive' });
    }
    req.user = user;
    next();
  };
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied for role "${req.user.role}". Required: ${allowedRoles.join(', ')}`,
      });
    }
    next();
  };
}

function logAudit(db, { entityType, entityId = null, entityRef = null, action, user, before = null, after = null, notes = null }) {
  db.prepare(
    `INSERT INTO audit_logs (entity_type, entity_id, entity_ref, action, user_id, username, user_role, before_json, after_json, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entityType,
    entityId,
    entityRef,
    action,
    user ? user.id : null,
    user ? user.username : 'system',
    user ? user.role : 'system',
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    notes
  );
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
  logAudit,
};
