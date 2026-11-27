const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.resolve(__dirname, '../../database');
const DEFAULT_DB_PATH = path.join(DB_DIR, 'order_to_audit.db');
const SCHEMA_PATH = path.join(DB_DIR, 'schema.sql');

let dbInstance = null;

function createDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

function setDb(db) {
  dbInstance = db;
}

/**
 * Execute fn inside an IMMEDIATE SQLite transaction.
 */
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch (_) {
      // ignore rollback failure if already rolled back
    }
    throw err;
  }
}

module.exports = {
  createDatabase,
  getDb,
  setDb,
  withTransaction,
  DEFAULT_DB_PATH,
};
