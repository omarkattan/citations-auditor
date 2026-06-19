// sheets.js
// Stores scan logs and serves them to the admin view.
//
// Two backends, chosen automatically:
//   - Google Sheets, if GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT are set
//     (durable, survives redeploys).
//   - A local JSON file otherwise (zero setup, but on a free host it resets
//     on every redeploy and cold-start restart).

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEADER = [
  'Timestamp', 'URL', 'Source', 'Pages scanned', 'Claims found', 'High severity', 'Duration (s)'
];

// ---- Google Sheets backend --------------------------------------------------

function getClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!raw || !sheetId) return null;

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return { sheets: google.sheets({ version: 'v4', auth }), sheetId };
}

function storageMode() {
  return getClient() ? 'sheet' : 'file';
}

// ---- Local file backend -----------------------------------------------------

function storePath() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'claims-log.json');
  } catch {
    return path.join(os.tmpdir(), 'claims-log.json');
  }
}
const STORE = storePath();

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { scans: [], pages: [] };
  }
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE, JSON.stringify(data));
  } catch (err) {
    console.error('Local log write failed:', err.message);
  }
}

// ---- Public API -------------------------------------------------------------

async function logScan(record) {
  const ts = new Date().toISOString();
  const row = [
    ts,
    record.url || '',
    record.source || '',
    record.pagesScanned || 0,
    record.claimsFound || 0,
    record.highSeverity || 0,
    record.durationSec || 0
  ];

  const client = getClient();
  if (!client) {
    const store = readStore();
    store.scans.push(row);
    writeStore(store);
    return;
  }
  try {
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: 'Scans!A:G',
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error('Sheet log failed:', err.message);
  }
}

async function getScans() {
  const client = getClient();
  if (!client) {
    const store = readStore();
    return { configured: true, mode: 'file', rows: (store.scans || []).slice().reverse() };
  }
  try {
    const res = await client.sheets.spreadsheets.values.get({
      spreadsheetId: client.sheetId,
      range: 'Scans!A:G'
    });
    const values = res.data.values || [];
    const rows = values.length && values[0][0] === 'Timestamp' ? values.slice(1) : values;
    return { configured: true, mode: 'sheet', rows: rows.reverse() };
  } catch (err) {
    return { configured: true, mode: 'sheet', rows: [], error: err.message };
  }
}

// Per-page log: one row per individual URL audited.
// Row shape: [Timestamp, Page URL, Source, Claims, High severity, From].
async function logPages(rows) {
  if (!rows || !rows.length) return;
  const ts = new Date().toISOString();
  const values = rows.map((r) => [ts, r.pageUrl || '', r.source || '', r.claims || 0, r.high || 0, r.root || '']);

  const client = getClient();
  if (!client) {
    const store = readStore();
    store.pages.push(...values);
    writeStore(store);
    return;
  }
  try {
    await client.sheets.spreadsheets.values.append({
      spreadsheetId: client.sheetId,
      range: 'Pages!A:F',
      valueInputOption: 'RAW',
      requestBody: { values }
    });
  } catch (err) {
    console.error('Pages log failed:', err.message);
  }
}

async function getPages() {
  const client = getClient();
  if (!client) {
    const store = readStore();
    return { configured: true, mode: 'file', rows: (store.pages || []).slice().reverse() };
  }
  try {
    const res = await client.sheets.spreadsheets.values.get({
      spreadsheetId: client.sheetId,
      range: 'Pages!A:F'
    });
    const values = res.data.values || [];
    const rows = values.length && values[0][0] === 'Timestamp' ? values.slice(1) : values;
    return { configured: true, mode: 'sheet', rows: rows.reverse() };
  } catch (err) {
    return { configured: true, mode: 'sheet', rows: [], error: err.message };
  }
}

// Make sure the Scans and Pages tabs exist when using Sheets. No-op for files.
async function ensureTabs() {
  const client = getClient();
  if (!client) return;
  try {
    const meta = await client.sheets.spreadsheets.get({ spreadsheetId: client.sheetId });
    const titles = (meta.data.sheets || []).map((s) => s.properties.title);
    const missing = ['Scans', 'Pages'].filter((t) => !titles.includes(t));
    if (missing.length) {
      await client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: client.sheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }
      });
    }
  } catch (err) {
    console.error('ensureTabs failed:', err.message);
  }
}

module.exports = { logScan, getScans, logPages, getPages, ensureTabs, storageMode, HEADER };
