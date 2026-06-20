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
      voided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Migrations for tables created before these columns existed.
  await p.query('ALTER TABLE credits ADD COLUMN IF NOT EXISTS payment_intent TEXT');
  await p.query('ALTER TABLE credits ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ');
  await p.query(`
    CREATE TABLE IF NOT EXISTS free_usage (
      ip TEXT PRIMARY KEY,
      used INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS scan_costs (
      id BIGSERIAL PRIMARY KEY,
      url TEXT,
      source TEXT,
      pages INTEGER NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      web_searches INTEGER NOT NULL DEFAULT 0,
      browserless_renders INTEGER NOT NULL DEFAULT 0,
      est_cost NUMERIC(12,6) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  // AND voided_at IS NULL makes repeated refund/dispute events idempotent.
  const r = await p.query(
    'UPDATE credits SET used = total, voided_at = now() WHERE payment_intent = $1 AND voided_at IS NULL RETURNING code, total',
    [paymentIntent]
  );
  return r.rows.map((row) => ({ code: row.code, voided: row.total }));
}

// List every credit code with computed balance, for the admin view.
async function listCredits() {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    'SELECT code, email, total, used, stripe_session_id, payment_intent, voided_at, created_at FROM credits ORDER BY created_at DESC'
  );
  return r.rows.map((row) => ({
    code: row.code,
    email: row.email || '',
    total: row.total,
    used: row.used,
    balance: Math.max(0, row.total - row.used),
    source: row.stripe_session_id ? 'stripe' : 'grant',
    voided: !!row.voided_at,
    created_at: row.created_at
  }));
}

// Record the measured usage and estimated cost of one scan.
async function logScanCost(row) {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO scan_costs (url, source, pages, input_tokens, output_tokens, web_searches, browserless_renders, est_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.url || null,
      row.source || null,
      row.pages || 0,
      row.input_tokens || 0,
      row.output_tokens || 0,
      row.web_searches || 0,
      row.browserless_renders || 0,
      row.est_cost || 0
    ]
  );
}

// Aggregate totals plus the most recent scans, for the admin cost view.
async function getCostSummary(limit = 50) {
  const p = getPool();
  if (!p) return { totals: null, recent: [] };
  const t = await p.query(`
    SELECT
      count(*)::int AS scans,
      coalesce(sum(pages), 0)::int AS pages,
      coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
      coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
      coalesce(sum(web_searches), 0)::int AS web_searches,
      coalesce(sum(browserless_renders), 0)::int AS browserless_renders,
      coalesce(sum(est_cost), 0)::numeric AS total_cost,
      coalesce(sum(est_cost) FILTER (WHERE created_at > now() - interval '7 days'), 0)::numeric AS last7_cost,
      coalesce(sum(est_cost) FILTER (WHERE created_at > now() - interval '1 day'), 0)::numeric AS last1_cost
    FROM scan_costs`);
  const r = await p.query(
    `SELECT created_at, url, source, pages, input_tokens, output_tokens, web_searches, browserless_renders, est_cost
     FROM scan_costs ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return { totals: t.rows[0], recent: r.rows };
}

module.exports = {
  enabled, init, genCode,
  getCodeBalance, consumeCode,
  getFreeRemaining, consumeFree,
  createCode, createCodeForSession, voidByPaymentIntent, listCredits,
  logScanCost, getCostSummary
};
