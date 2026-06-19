// server.js
const express = require('express');
const path = require('path');
const { discover } = require('./discover');
const { auditPage, auditText, diagnose } = require('./audit');
const { logScan, getScans } = require('./sheets');

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

    for (let i = 0; i < pages.length; i++) {
      if (closed) break;
      const pageUrl = pages[i];
      send('status', { message: `Auditing ${i + 1} of ${pages.length}`, index: i + 1, total: pages.length });

      const result = await auditPage(pageUrl, { findSources });
      const claims = result.claims || [];
      totalClaims += claims.length;
      highSeverity += claims.filter((c) => (c.severity || '').toLowerCase() === 'high').length;

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

    send('done', { pagesScanned: pages.length, totalClaims, highSeverity, durationSec });
  } catch (err) {
    send('error', { message: err.message || 'Scan failed.' });
  } finally {
    res.end();
  }
});

// ---- Admin view -------------------------------------------------------------

app.get('/admin/scans', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }
  const { configured, rows, error } = await getScans();

  const body = !configured
    ? '<p>Logging is not configured. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT.</p>'
    : error
    ? `<p>Could not read the sheet: ${error}</p>`
    : `<table>
        <thead><tr>
          <th>Time</th><th>URL</th><th>Source</th><th>Pages</th><th>Claims</th><th>High</th><th>Secs</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>${[0, 1, 2, 3, 4, 5, 6]
              .map((i) => `<td>${(r[i] || '').toString().replace(/</g, '&lt;')}</td>`)
              .join('')}</tr>`
          )
          .join('')}</tbody>
      </table>`;

  res.send(`<!doctype html><html><head><meta charset="utf-8">
    <title>Scans - Claims Auditor</title>
    <style>
      body { background:#0d0f0e; color:#e6e6e6; font-family:'JetBrains Mono',ui-monospace,monospace; padding:32px; }
      h1 { color:#2ecc71; font-size:18px; letter-spacing:.04em; }
      table { width:100%; border-collapse:collapse; margin-top:16px; font-size:13px; }
      th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #1e2421; }
      th { color:#2ecc71; text-transform:uppercase; font-size:11px; letter-spacing:.08em; }
      td:nth-child(2) { color:#9fe6bd; max-width:360px; overflow:hidden; text-overflow:ellipsis; }
    </style></head>
    <body><h1>Scan log</h1>${body}</body></html>`);
});

app.listen(PORT, () => console.log(`Claims Auditor listening on ${PORT}`));
