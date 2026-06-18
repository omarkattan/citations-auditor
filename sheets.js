// lib/sheets.js
// Logs each scan to a Google Sheet and reads them back for the admin view.
// Reuses GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT, the same pattern as
// the agentic readiness tester. If those are not set, logging is skipped
// silently so the app still runs.

const { google } = require('googleapis');

const HEADER = [
  'Timestamp', 'URL', 'Source', 'Pages scanned', 'Claims found', 'High severity', 'Duration (s)'
];

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

async function logScan(record) {
  const client = getClient();
  if (!client) return;
  const { sheets, sheetId } = client;

  const row = [
    new Date().toISOString(),
    record.url || '',
    record.source || '',
    record.pagesScanned || 0,
    record.claimsFound || 0,
    record.highSeverity || 0,
    record.durationSec || 0
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
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
  if (!client) return { configured: false, rows: [] };
  const { sheets, sheetId } = client;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Scans!A:G'
    });
    const values = res.data.values || [];
    const rows = values.length && values[0][0] === 'Timestamp' ? values.slice(1) : values;
    return { configured: true, rows: rows.reverse() };
  } catch (err) {
    return { configured: true, rows: [], error: err.message };
  }
}

module.exports = { logScan, getScans, HEADER };
