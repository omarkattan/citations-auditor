// server.js
const express = require('express');
const path = require('path');
const { discover } = require('./discover');
const { auditPage, auditText, diagnose } = require('./audit');
const { logScan, getScans, logPages, getPages, ensureTabs, storageMode } = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'sandstorm2026';
const MAX_PAGES_CAP = 25;

// Serve the single-page UI from the repo root.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use(express.json({ limit: '2mb' }));

// Keep-alive endpoint for cron-job.org (free-tier cold starts).
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Audit text the user pasted in (used when a site blocks automated fetches).
app.post('/api/audit-text', async (req, res) => {
  const { text, url, findSources } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });

  const started = Date.now();
  const label = (url || '').trim() || 'Pasted text';
  try {
    const result = await auditText(text, { url: label, findSources: findSources !== false });
    const claims = result.claims || [];
    await logScan({
      url: label,
      source: 'paste',
      pagesScanned: 1,
      claimsFound: claims.length,
      highSeverity: claims.filter((c) => (c.severity || '').toLowerCase() === 'high').length,
      durationSec: Math.round((Date.now() - started) / 1000)
    });
    await logPages([{
      pageUrl: label,
      source: 'paste',
      claims: claims.length,
      high: claims.filter((c) => (c.severity || '').toLowerCase() === 'high').length,
      root: label
    }]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ url: label, error: `Audit failed: ${err.message}`, claims: [] });
  }
});

// Diagnostic probe: makes one minimal API call and returns the raw error
// detail so we can see what is actually failing. Guarded by the admin key.
app.get('/api/diag', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const result = await diagnose();
  result.node = process.version;
  res.json(result);
});

// ---- Streaming scan (Server-Sent Events) -----------------------------------

app.get('/api/scan/stream', async (req, res) => {
  const url = (req.query.url || '').trim();
  const source = (req.query.source || 'crawl').trim();
  const pathPrefix = (req.query.path || '').trim();
  const findSources = req.query.findSources !== 'false';
  let maxPages = parseInt(req.query.maxPages, 10) || 15;
  maxPages = Math.max(1, Math.min(maxPages, MAX_PAGES_CAP));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!/^https?:\/\//i.test(url)) {
    send('error', { message: 'Enter a full URL, including https://' });
    return res.end();
  }

  const started = Date.now();
  try {
    send('status', { message: source === 'single' ? 'Loading the page...' : 'Discovering pages...' });
    const pages = await discover(source, url, { maxPages, pathPrefix });

    if (!pages.length) {
      send('error', { message: 'No pages found for that source.' });
      return res.end();
    }
    send('pages', { count: pages.length, urls: pages });

    let totalClaims = 0;
    let highSeverity = 0;
    const pageRows = [];

    for (let i = 0; i < pages.length; i++) {
      if (closed) break;
      const pageUrl = pages[i];
      send('status', { message: `Auditing ${i + 1} of ${pages.length}`, index: i + 1, total: pages.length });

      const result = await auditPage(pageUrl, { findSources });
      const claims = result.claims || [];
      const high = claims.filter((c) => (c.severity || '').toLowerCase() === 'high').length;
      totalClaims += claims.length;
      highSeverity += high;
      pageRows.push({ pageUrl: result.url, source, claims: claims.length, high, root: url });

      send('page', result);
    }

    const durationSec = Math.round((Date.now() - started) / 1000);
    await logScan({
      url,
      source,
      pagesScanned: pages.length,
      claimsFound: totalClaims,
      highSeverity,
      durationSec
    });
    await logPages(pageRows);

    send('done', { pagesScanned: pages.length, totalClaims, highSeverity, durationSec });
  } catch (err) {
    send('error', { message: err.message || 'Scan failed.' });
  } finally {
    res.end();
  }
});

// ---- Admin view -------------------------------------------------------------

function escHtml(v) {
  return (v == null ? '' : v.toString()).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

app.get('/admin/scans', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }

  const [scans, pagesLog] = await Promise.all([getScans(), getPages()]);

  if (!scans.configured) {
    return res.send(adminShell('<p>Logging is not configured. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT.</p>'));
  }

  const urlRows = (pagesLog.rows || [])
    .map((r) => {
      const link = r[1] ? `<a href="${escHtml(r[1])}" target="_blank" rel="noopener">${escHtml(r[1])}</a>` : '';
      return `<tr>
        <td>${escHtml(r[0])}</td>
        <td class="u">${link}</td>
        <td>${escHtml(r[2])}</td>
        <td>${escHtml(r[3])}</td>
        <td>${escHtml(r[4])}</td>
        <td>${escHtml(r[5])}</td>
      </tr>`;
    })
    .join('');

  const urlsTable = pagesLog.error
    ? `<p>Could not read the Pages tab: ${escHtml(pagesLog.error)}</p>`
    : urlRows
    ? `<table>
        <thead><tr><th>Time</th><th>Tested URL</th><th>Source</th><th>Claims</th><th>High</th><th>From</th></tr></thead>
        <tbody>${urlRows}</tbody>
      </table>`
    : '<p>No URLs tested yet.</p>';

  const scanRows = (scans.rows || [])
    .map((r) => `<tr>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<td>${escHtml(r[i])}</td>`).join('')}</tr>`)
    .join('');
  const scansTable = scans.error
    ? `<p>Could not read the Scans tab: ${escHtml(scans.error)}</p>`
    : `<table>
        <thead><tr><th>Time</th><th>URL</th><th>Source</th><th>Pages</th><th>Claims</th><th>High</th><th>Secs</th></tr></thead>
        <tbody>${scanRows}</tbody>
      </table>`;

  const total = (pagesLog.rows || []).length;
  const mode = storageMode();
  const storageNote = mode === 'sheet'
    ? 'Storage: Google Sheet (durable).'
    : 'Storage: local file. Resets on redeploy and cold-start. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT for durable history.';
  const body = `
    <div class="bar">
      <h1>Tested URLs (${total})</h1>
      <a class="dl" href="/admin/urls.csv?key=${encodeURIComponent(req.query.key)}">Download CSV</a>
    </div>
    <p class="note">${escHtml(storageNote)}</p>
    ${urlsTable}
    <h1 style="margin-top:40px">Scans</h1>
    ${scansTable}`;

  res.send(adminShell(body));
});

// CSV of every tested URL, for the admin.
app.get('/admin/urls.csv', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  const { rows } = await getPages();
  const header = ['Timestamp', 'Tested URL', 'Source', 'Claims', 'High severity', 'From'];
  const csv = [header]
    .concat(rows || [])
    .map((r) => r.map((c) => `"${(c == null ? '' : c.toString()).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tested-urls.csv"');
  res.send(csv);
});

function adminShell(body) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>Admin - Claims Auditor</title>
    <style>
      body { background:#0d0f0e; color:#e6e6e6; font-family:'JetBrains Mono',ui-monospace,monospace; padding:32px; }
      h1 { color:#2ecc71; font-size:16px; letter-spacing:.04em; margin:0; }
      .bar { display:flex; align-items:center; justify-content:space-between; gap:16px; }
      .dl { color:#06150c; background:#2ecc71; padding:8px 14px; border-radius:6px; text-decoration:none; font-size:12px; font-weight:700; }
      table { width:100%; border-collapse:collapse; margin-top:16px; font-size:12px; }
      th, td { text-align:left; padding:7px 10px; border-bottom:1px solid #1e2421; vertical-align:top; }
      th { color:#2ecc71; text-transform:uppercase; font-size:10px; letter-spacing:.08em; }
      td.u { max-width:520px; word-break:break-all; }
      .note { color:#8a948e; font-size:11px; margin:10px 0 0; }
      a { color:#9fe6bd; text-decoration:none; }
      a:hover { color:#2ecc71; }
    </style></head><body>${body}</body></html>`;
}

app.listen(PORT, () => {
  console.log(`Claims Auditor listening on ${PORT}`);
  ensureTabs();
});
