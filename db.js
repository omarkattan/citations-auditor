// db.js
// Durable storage for paid credits and free-tier usage, on Postgres.
// The paywall is only active when DATABASE_URL is set; otherwise the whole
// credit system is off and scans run unmetered (the app's prior behavior).

const crypto = require('crypto');

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch {
  Pool = null;
}

let pool = null;

function enabled() {
  return Boolean(process.env.DATABASE_URL) && Boolean(Pool);
}

function getPool() {
  if (!enabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function init() {
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS credits (
      code TEXT PRIMARY KEY,
      email TEXT,
      total INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      stripe_session_id TEXT UNIQUE,
      payment_intent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Migration for tables created before payment_intent existed.
  await p.query('ALTER TABLE credits ADD COLUMN IF NOT EXISTS payment_intent TEXT');
  await p.query(`
    CREATE TABLE IF NOT EXISTS free_usage (
      ip TEXT PRIMARY KEY,
      used INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

function genCode() {
  return 'CLM-' + crypto.randomBytes(10).toString('hex').toUpperCase();
}

async function getCodeBalance(code) {
  const p = getPool();
  if (!p || !code) return null;
  const r = await p.query('SELECT code, total, used FROM credits WHERE code = $1', [code.trim().toUpperCase()]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { code: row.code, total: row.total, used: row.used, balance: Math.max(0, row.total - row.used) };
}

async function consumeCode(code, n) {
  const p = getPool();
  if (!p || n <= 0) return;
  await p.query('UPDATE credits SET used = LEAST(total, used + $2) WHERE code = $1', [code.trim().toUpperCase(), n]);
}

async function getFreeRemaining(ip, freeLimit) {
  const p = getPool();
  if (!p) return 0;
  const r = await p.query('SELECT used FROM free_usage WHERE ip = $1', [ip]);
  const used = r.rows.length ? r.rows[0].used : 0;
  return Math.max(0, freeLimit - used);
}

async function consumeFree(ip, n) {
  const p = getPool();
  if (!p || n <= 0) return;
  await p.query(
    `INSERT INTO free_usage (ip, used, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (ip) DO UPDATE SET used = free_usage.used + $2, updated_at = now()`,
    [ip, n]
  );
}

// Create a standalone credit code (admin grants, comps, refunds) with no
// Stripe session attached.
async function createCode(credits, email) {
  const p = getPool();
  if (!p) return null;
  const code = genCode();
  await p.query(
    'INSERT INTO credits (code, email, total, used, stripe_session_id) VALUES ($1, $2, $3, 0, NULL)',
    [code, email || null, credits]
  );
  return { code, credits, balance: credits };
}

// Idempotent on the Stripe session id: returns the existing code for a session
// if one was already created, otherwise creates it.
async function createCodeForSession(sessionId, email, credits, paymentIntent) {
  const p = getPool();
  if (!p) return null;
  const existing = await p.query('SELECT code, total, used FROM credits WHERE stripe_session_id = $1', [sessionId]);
  if (existing.rows.length) {
    const r = existing.rows[0];
    return { code: r.code, credits: r.total, balance: Math.max(0, r.total - r.used) };
  }
  const code = genCode();
  await p.query(
    'INSERT INTO credits (code, email, total, used, stripe_session_id, payment_intent) VALUES ($1, $2, $3, 0, $4, $5)',
    [code, email || null, credits, sessionId, paymentIntent || null]
  );
  return { code, credits, balance: credits };
}

// Void a code on refund/chargeback by zeroing its remaining balance (used set to
// total). Matched via the Stripe payment_intent stored at creation. Returns the
// affected code(s) so the caller can log.
async function voidByPaymentIntent(paymentIntent) {
  const p = getPool();
  if (!p || !paymentIntent) return [];
  const r = await p.query(
    'UPDATE credits SET used = total WHERE payment_intent = $1 RETURNING code, total',
    [paymentIntent]
  );
  return r.rows.map((row) => ({ code: row.code, voided: row.total }));
}

// List every credit code with computed balance, for the admin view.
async function listCredits() {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    'SELECT code, email, total, used, stripe_session_id, payment_intent, created_at FROM credits ORDER BY created_at DESC'
  );
  return r.rows.map((row) => ({
    code: row.code,
    email: row.email || '',
    total: row.total,
    used: row.used,
    balance: Math.max(0, row.total - row.used),
    source: row.stripe_session_id ? 'stripe' : 'grant',
    created_at: row.created_at
  }));
}

module.exports = {
  enabled, init, genCode,
  getCodeBalance, consumeCode,
  getFreeRemaining, consumeFree,
  createCode, createCodeForSession, voidByPaymentIntent, listCredits
};
