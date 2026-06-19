// server.js
const express = require('express');
const path = require('path');
const { discover } = require('./discover');
const { auditPage, auditText, diagnose, extractText } = require('./audit');
const { fetchHtml, fetchDiagnostic } = require('./fetchpage');
const { logScan, getScans, logPages, getPages, ensureTabs, storageMode } = require('./sheets');
const db = require('./db');
const payments = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'sandstorm2026';
const MAX_PAGES_CAP = 25;
const FREE_PAGES = parseInt(process.env.FREE_PAGES || '3', 10);

// Render runs behind a proxy; needed so req.ip is the real client IP.
app.set('trust proxy', true);

// Stripe webhook needs the raw body for signature verification, so it must be
// registered before the JSON body parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = payments.verifyWebhook(req.body, req.headers['stripe-signature']);
    if (event.type === 'checkout.session.completed') {
      await payments.fulfillSession(event.data.object.id);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook error: ${err.message}`);
  }
});

// Serve the single-page UI from the repo root.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/success', (_req, res) => res.sendFile(path.join(__dirname, 'success.html')));

app.use(express.json({ limit: '2mb' }));

// Keep-alive endpoint for cron-job.org (free-tier cold starts).
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Credits / payments -----------------------------------------------------

// Resolve who is paying for a scan and how many pages they can run.
// Returns { paywall, type, code, ip, balance } or { paywall:false }.
async function resolveAccount(req) {
  if (!db.enabled()) return { paywall: false, balance: Infinity };
  const code = (req.query.code || (req.body && req.body.code) || '').trim();
  if (code) {
    const b = await db.getCodeBalance(code);
    if (!b) return { paywall: true, invalid: true, balance: 0 };
    return { paywall: true, type: 'code', code, balance: b.balance };
  }
  const free = await db.getFreeRemaining(req.ip, FREE_PAGES);
  return { paywall: true, type: 'free', ip: req.ip, balance: free };
}

async function chargeAccount(account, n) {
  if (!account || !account.paywall || n <= 0) return;
  if (account.type === 'code') await db.consumeCode(account.code, n);
  else if (account.type === 'free') await db.consumeFree(account.ip, n);
}

// Current balance for the UI: a code's balance, or the IP's free remaining.
app.get('/api/credits', async (req, res) => {
  if (!db.enabled()) return res.json({ paywall: false });
  const code = (req.query.code || '').trim();
  if (code) {
    const b = await db.getCodeBalance(code);
    return res.json({ paywall: true, valid: Boolean(b), type: 'code', balance: b ? b.balance : 0 });
  }
  const free = await db.getFreeRemaining(req.ip, FREE_PAGES);
  res.json({ paywall: true, type: 'free', balance: free, freeLimit: FREE_PAGES });
});

app.get('/api/packages', (_req, res) => {
  res.json({ paymentsEnabled: payments.enabled(), packages: Object.values(payments.PACKAGES) });
});

app.post('/api/checkout', async (req, res) => {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    const url = await payments.createCheckout((req.body || {}).package, origin);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/checkout/result', async (req, res) => {
  try {
    const result = await payments.fulfillSession(req.query.session_id);
    if (!result) return res.status(402).json({ error: 'Payment not completed yet.' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Audit text the user pasted in (used when a site blocks automated fetches).
app.post('/api/audit-text', async (req, res) => {
  const { text, url, findSources } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });

  const account = await resolveAccount(req);
  if (account.paywall) {
    if (account.invalid) return res.status(402).json({ error: 'That access code is not valid.' });
    if (account.balance <= 0) {
      return res.status(402).json({ error: account.type === 'free' ? 'Free trial used up. Buy credits to continue.' : 'No credits left on that code.' });
    }
  }

  const started = Date.now();
  const label = (url || '').trim() || 'Pasted text';
  try {
    const result = await auditText(text, { url: label, findSources: findSources !== false });
    const claims = result.claims || [];
    if (account.paywall && !result.error) await chargeAccount(account, 1);
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
    if (account.paywall) result.balance = Math.max(0, account.balance - (result.error ? 0 : 1));
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

// Fetch diagnostic: shows how a given URL is retrieved (direct vs Browserless)
// and how much real text comes out. Guarded by the admin key.
app.get('/api/fetch-test', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const url = (req.query.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Provide ?url=https://...' });

  const diag = await fetchDiagnostic(url);
  const fetched = await fetchHtml(url);
  if (fetched.ok) {
    const ex = extractText(fetched.html);
    diag.pipeline = {
      via: fetched.via,
      htmlLen: fetched.html.length,
      title: ex.title,
      textLen: ex.text.length,
      sample: ex.text.slice(0, 300)
    };
  } else {
    diag.pipeline = { via: 'none', error: fetched.error || 'fetch failed', status: fetched.status };
  }
  res.json(diag);
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
    // Resolve the paying account and gate on balance.
    const account = await resolveAccount(req);
    if (account.paywall) {
      if (account.invalid) {
        send('error', { message: 'That access code is not valid.' });
        return res.end();
      }
      if (account.balance <= 0) {
        send('error', {
          message: account.type === 'free' ? 'Free trial used up. Buy credits to continue.' : 'No credits left on that code.',
          needCredits: true
        });
        return res.end();
      }
    }

    send('status', { message: source === 'single' ? 'Loading the page...' : 'Discovering pages...' });
    let pages = await discover(source, url, { maxPages, pathPrefix });

    if (!pages.length) {
      send('error', { message: 'No pages found for that source.' });
      return res.end();
    }

    // Never audit more pages than the account can pay for.
    let capped = false;
    if (account.paywall && pages.length > account.balance) {
      pages = pages.slice(0, account.balance);
      capped = true;
    }

    send('pages', { count: pages.length, urls: pages, capped });

    let totalClaims = 0;
    let highSeverity = 0;
    let charged = 0;
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
      if (!result.error) charged += 1; // only charge pages that actually ran
      pageRows.push({ pageUrl: result.url, source, claims: claims.length, high, root: url });

      send('page', result);
    }

    if (account.paywall && charged > 0) await chargeAccount(account, charged);

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

    const done = { pagesScanned: pages.length, totalClaims, highSeverity, durationSec, capped };
    if (account.paywall) done.balance = Math.max(0, account.balance - charged);
    send('done', done);
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
  db.init().catch((e) => console.error('db.init failed:', e.message));
});
