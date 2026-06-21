// server.js
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { discover } = require('./discover');
const { auditPage, auditText, diagnose, extractText } = require('./audit');
const { fetchHtml, fetchDiagnostic } = require('./fetchpage');
const { logScan, getScans, logPages, getPages, ensureTabs, storageMode } = require('./sheets');
const db = require('./db');
const payments = require('./payments');
const { computeCost, RATES } = require('./cost');

const app = express();
const PORT = process.env.PORT || 3000;
// No insecure default: if ADMIN_KEY is unset, admin endpoints are disabled.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_PAGES_CAP = 25;
const FREE_PAGES = parseInt(process.env.FREE_PAGES || '3', 10);
// A fact-checked page costs more to run (more web searches and tokens), so it
// spends more credits. Keeps margin healthy on the premium operation.
const FACTCHECK_COST = parseInt(process.env.FACTCHECK_CREDIT_COST || '3', 10);
// Standard (non-fact-check) page cost. With web search on, a standard audit
// is no longer a near-free call, so this is tunable without a redeploy.
const STANDARD_COST = parseInt(process.env.STANDARD_CREDIT_COST || '1', 10);

if (!ADMIN_KEY) {
  console.warn('[admin] ADMIN_KEY is not set - all admin endpoints are disabled until you set it.');
}

// Constant-time admin check. Fails closed when no key is configured. Comparing
// SHA-256 digests keeps it constant-time and avoids leaking key length.
function adminOk(req) {
  if (!ADMIN_KEY) return false;
  const provided = String((req.query && req.query.key) || '');
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// Compute and persist the estimated cost of a scan (no-op without a database).
async function logCost(url, source, pages, usage) {
  try {
    if (!db.enabled()) return;
    const c = computeCost(usage);
    await db.logScanCost({
      url,
      source,
      pages,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      web_searches: usage.webSearches,
      browserless_renders: usage.browserlessRenders,
      est_cost: c.total
    });
  } catch (e) {
    console.error('logCost failed:', e.message);
  }
}

// Render runs behind a proxy; needed so req.ip is the real client IP.
app.set('trust proxy', true);

// Stripe webhook needs the raw body for signature verification, so it must be
// registered before the JSON body parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = payments.verifyWebhook(req.body, req.headers['stripe-signature']);
    if (event.type === 'checkout.session.completed') {
      await payments.fulfillSession(event.data.object.id);
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const obj = event.data.object || {};
      const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : (obj.payment_intent && obj.payment_intent.id) || null;
      if (pi) {
        const voided = await payments.voidByPaymentIntent(pi);
        if (voided.length) console.log(`[webhook] ${event.type}: voided code(s)`, voided.map((v) => v.code).join(', '));
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook error: ${err.message}`);
  }
});

// Serve the single-page UI from the repo root.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/success', (_req, res) => res.sendFile(path.join(__dirname, 'success.html')));
app.get('/bot', (_req, res) => res.sendFile(path.join(__dirname, 'bot.html')));

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
  res.set('Cache-Control', 'no-store');
  res.json({ paymentsEnabled: payments.enabled(), packages: Object.values(payments.PACKAGES), factCheckCost: FACTCHECK_COST, freePages: FREE_PAGES });
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

// Admin: mint a credit code without payment (testing, comps, refunds).
// e.g. /api/admin/grant?key=ADMIN_KEY&credits=1000
app.get('/api/admin/grant', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!db.enabled()) return res.status(400).json({ error: 'Database not configured.' });
  const credits = Math.max(1, Math.min(parseInt(req.query.credits || '500', 10), 100000));
  const result = await db.createCode(credits, 'admin-grant');
  res.json(result);
});

// Audit text the user pasted in (used when a site blocks automated fetches).
app.post('/api/audit-text', async (req, res) => {
  const { text, url, findSources, factCheck } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });
  const pageCost = factCheck === true ? FACTCHECK_COST : STANDARD_COST;

  const account = await resolveAccount(req);
  if (account.paywall) {
    if (account.invalid) return res.status(402).json({ error: 'That access code is not valid.' });
    if (account.balance < pageCost) {
      const need = pageCost > 1 ? `A fact-checked page needs ${pageCost} credits. ` : '';
      return res.status(402).json({ error: need + (account.type === 'free' ? 'Free trial used up. Buy credits to continue.' : 'Not enough credits on that code.') });
    }
  }

  const started = Date.now();
  const label = (url || '').trim() || 'Pasted text';
  try {
    const result = await auditText(text, { url: label, findSources: findSources !== false, factCheck: factCheck === true });
    const claims = result.claims || [];
    if (account.paywall && !result.error) await chargeAccount(account, pageCost);
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
    await logCost(label, factCheck === true ? 'paste-factcheck' : 'paste', 1, {
      inputTokens: (result.usage && result.usage.input_tokens) || 0,
      outputTokens: (result.usage && result.usage.output_tokens) || 0,
      webSearches: (result.usage && result.usage.web_searches) || 0,
      browserlessRenders: 0
    });
    if (account.paywall) result.balance = Math.max(0, account.balance - (result.error ? 0 : pageCost));
    res.json(result);
  } catch (err) {
    res.status(500).json({ url: label, error: `Audit failed: ${err.message}`, claims: [] });
  }
});

// Diagnostic probe: makes one minimal API call and returns the raw error
// detail so we can see what is actually failing. Guarded by the admin key.
app.get('/api/diag', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const result = await diagnose();
  result.node = process.version;
  res.json(result);
});

// Fetch diagnostic: shows how a given URL is retrieved (direct vs Browserless)
// and how much real text comes out. Guarded by the admin key.
app.get('/api/fetch-test', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
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

// Admin: run a real audit on one URL and return the raw result, so you can see
// exactly what the model flagged in each mode. ?factCheck=true to fact-check.
app.get('/api/audit-test', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const url = (req.query.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Provide ?url=https://...' });
  const factCheck = req.query.factCheck === 'true';
  try {
    const started = Date.now();
    const result = await auditPage(url, { findSources: req.query.findSources !== 'false', factCheck, debug: true });
    res.json({
      url,
      factCheck,
      error: result.error || null,
      browserless: result.browserless || 0,
      claimsCount: (result.claims || []).length,
      usage: result.usage || null,
      durationSec: Math.round((Date.now() - started) / 1000),
      debug: result.debug || null,
      claims: result.claims || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan/stream', async (req, res) => {
  const url = (req.query.url || '').trim();
  const source = (req.query.source || 'crawl').trim();
  const pathPrefix = (req.query.path || '').trim();
  const findSources = req.query.findSources !== 'false';
  const factCheck = req.query.factCheck === 'true';
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
  const pageCost = factCheck ? FACTCHECK_COST : STANDARD_COST;
  try {
    // Resolve the paying account and gate on balance.
    const account = await resolveAccount(req);
    if (account.paywall) {
      if (account.invalid) {
        send('error', { message: 'That access code is not valid.' });
        return res.end();
      }
      if (account.balance < pageCost) {
        const need = pageCost > 1 ? `A fact-checked page needs ${pageCost} credits. ` : '';
        send('error', {
          message: need + (account.type === 'free' ? 'Free trial used up. Buy credits to continue.' : 'Not enough credits left on that code.'),
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

    // Never audit more pages than the account can pay for (cost varies by mode).
    let capped = false;
    if (account.paywall) {
      const affordable = Math.floor(account.balance / pageCost);
      if (pages.length > affordable) {
        pages = pages.slice(0, affordable);
        capped = true;
      }
    }

    send('pages', { count: pages.length, urls: pages, capped });

    let totalClaims = 0;
    let highSeverity = 0;
    let charged = 0;
    const pageRows = [];
    const usage = { inputTokens: 0, outputTokens: 0, webSearches: 0, browserlessRenders: 0 };

    for (let i = 0; i < pages.length; i++) {
      if (closed) break;
      const pageUrl = pages[i];
      send('status', { message: `Auditing ${i + 1} of ${pages.length}`, index: i + 1, total: pages.length });

      const result = await auditPage(pageUrl, { findSources, factCheck });
      const claims = result.claims || [];
      const high = claims.filter((c) => (c.severity || '').toLowerCase() === 'high').length;
      totalClaims += claims.length;
      highSeverity += high;
      if (!result.error) charged += pageCost; // only charge pages that actually ran
      if (result.usage) {
        usage.inputTokens += result.usage.input_tokens || 0;
        usage.outputTokens += result.usage.output_tokens || 0;
        usage.webSearches += result.usage.web_searches || 0;
      }
      usage.browserlessRenders += result.browserless || 0;
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
    await logCost(url, factCheck ? source + '-factcheck' : source, pages.length, usage);

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
  if (!adminOk(req)) {
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
    ${adminNav(req, 'scans')}
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
  if (!adminOk(req)) return res.status(401).send('Unauthorized');
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

// Admin nav shared across admin pages.
function adminNav(req, active) {
  const k = encodeURIComponent(req.query.key || '');
  const link = (href, label, id) =>
    id === active ? `<b>${label}</b>` : `<a href="${href}?key=${k}">${label}</a>`;
  return `<p class="note">${link('/admin/scans', 'URLs &amp; Scans', 'scans')} &middot; ${link('/admin/credits', 'Users &amp; Credits', 'credits')} &middot; ${link('/admin/costs', 'Costs', 'costs')}</p>`;
}

// Users and their credit balances.
app.get('/admin/credits', async (req, res) => {
  if (!adminOk(req)) return res.status(401).send('Unauthorized');
  if (!db.enabled()) {
    return res.send(adminShell(adminNav(req, 'credits') + '<p>Credits are not configured. Set DATABASE_URL to enable paid credits.</p>'));
  }

  const rows = await db.listCredits();

  const codeCount = rows.length;
  const sold = rows.filter((r) => r.source === 'stripe').reduce((a, r) => a + r.total, 0);
  const granted = rows.filter((r) => r.source === 'grant').reduce((a, r) => a + r.total, 0);
  const used = rows.reduce((a, r) => a + r.used, 0);
  const outstanding = rows.reduce((a, r) => a + r.balance, 0);
  const voidedCount = rows.filter((r) => r.voided).length;

  const fmtDate = (d) => {
    try { return new Date(d).toISOString().slice(0, 16).replace('T', ' '); } catch { return escHtml(String(d)); }
  };

  const body = rows.length
    ? rows.map((r) => {
        const status = r.voided
          ? '<span class="bad">voided</span>'
          : r.balance > 0 ? '<span class="ok">active</span>' : '<span class="dim">empty</span>';
        return `<tr>
          <td>${fmtDate(r.created_at)}</td>
          <td class="mono">${escHtml(r.code)}</td>
          <td>${escHtml(r.email) || '<span class="dim">-</span>'}</td>
          <td>${escHtml(r.source)}</td>
          <td>${r.total}</td>
          <td>${r.used}</td>
          <td><b>${r.balance}</b></td>
          <td>${status}</td>
        </tr>`;
      }).join('')
    : '';

  const table = body
    ? `<table>
        <thead><tr><th>Created</th><th>Code</th><th>Email</th><th>Source</th><th>Total</th><th>Used</th><th>Remaining</th><th>Status</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`
    : '<p>No credit codes yet.</p>';

  const summary = `
    <div class="cards">
      <div class="card"><div class="n">${codeCount}</div><div class="l">Codes</div></div>
      <div class="card"><div class="n">${sold}</div><div class="l">Credits sold</div></div>
      <div class="card"><div class="n">${granted}</div><div class="l">Credits granted</div></div>
      <div class="card"><div class="n">${used}</div><div class="l">Used</div></div>
      <div class="card"><div class="n">${outstanding}</div><div class="l">Outstanding</div></div>
      <div class="card"><div class="n">${voidedCount}</div><div class="l">Voided</div></div>
    </div>`;

  const content = `${adminNav(req, 'credits')}
    <h1>Users &amp; Credits</h1>
    ${summary}
    ${table}`;
  res.send(adminShell(content));
});

// Spend (estimated) and how it compares to revenue.
app.get('/admin/costs', async (req, res) => {
  if (!adminOk(req)) return res.status(401).send('Unauthorized');
  if (!db.enabled()) {
    return res.send(adminShell(adminNav(req, 'costs') + '<p>Cost tracking needs DATABASE_URL set.</p>'));
  }

  const { totals, recent } = await db.getCostSummary(50);
  const t = totals || {};
  const num = (v) => Number(v || 0);
  const money = (v) => '$' + num(v).toFixed(2);

  // Estimated revenue: match each non-voided Stripe code's credits to a package price.
  const priceByCredits = {};
  Object.values(payments.PACKAGES).forEach((p) => { priceByCredits[p.credits] = p.amount; });
  const credits = await db.listCredits();
  const revenueCents = credits
    .filter((c) => c.source === 'stripe' && !c.voided)
    .reduce((a, c) => a + (priceByCredits[c.total] || 0), 0);
  const revenue = revenueCents / 100;
  const totalCost = num(t.total_cost);
  const margin = revenue - totalCost;
  const marginPct = revenue > 0 ? Math.round((margin / revenue) * 100) : null;

  const fmtDate = (d) => { try { return new Date(d).toISOString().slice(0, 16).replace('T', ' '); } catch { return escHtml(String(d)); } };

  const cards = `
    <div class="cards">
      <div class="card"><div class="n">${money(totalCost)}</div><div class="l">Est. cost (all)</div></div>
      <div class="card"><div class="n">${money(t.last7_cost)}</div><div class="l">Cost (7 days)</div></div>
      <div class="card"><div class="n">${money(t.last1_cost)}</div><div class="l">Cost (24h)</div></div>
      <div class="card"><div class="n">${money(revenue)}</div><div class="l">Est. revenue</div></div>
      <div class="card"><div class="n">${money(margin)}</div><div class="l">Est. margin${marginPct == null ? '' : ' (' + marginPct + '%)'}</div></div>
    </div>
    <div class="cards">
      <div class="card"><div class="n">${num(t.scans)}</div><div class="l">Scans</div></div>
      <div class="card"><div class="n">${num(t.pages)}</div><div class="l">Pages</div></div>
      <div class="card"><div class="n">${num(t.input_tokens).toLocaleString()}</div><div class="l">Input tokens</div></div>
      <div class="card"><div class="n">${num(t.output_tokens).toLocaleString()}</div><div class="l">Output tokens</div></div>
      <div class="card"><div class="n">${num(t.web_searches)}</div><div class="l">Web searches</div></div>
      <div class="card"><div class="n">${num(t.browserless_renders)}</div><div class="l">Browserless</div></div>
    </div>`;

  const rows = (recent || []).map((r) => `<tr>
      <td>${fmtDate(r.created_at)}</td>
      <td class="u">${escHtml(r.url)}</td>
      <td>${escHtml(r.source)}</td>
      <td>${r.pages}</td>
      <td>${num(r.input_tokens).toLocaleString()}</td>
      <td>${num(r.output_tokens).toLocaleString()}</td>
      <td>${r.web_searches}</td>
      <td>${r.browserless_renders}</td>
      <td><b>${money(r.est_cost)}</b></td>
    </tr>`).join('');

  const table = rows
    ? `<table>
        <thead><tr><th>Time</th><th>URL</th><th>Source</th><th>Pages</th><th>In tok</th><th>Out tok</th><th>Search</th><th>Browserless</th><th>Est. cost</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<p>No scans recorded yet.</p>';

  const note = `Rates: $${RATES.inputPerMTok}/$${RATES.outputPerMTok} per Mtok in/out, $${RATES.perSearch}/search, $${RATES.perBrowserless}/Browserless render. Revenue and Browserless cost are estimates. Tune rates with env vars.`;

  const content = `${adminNav(req, 'costs')}
    <h1>Costs</h1>
    ${cards}
    <p class="note">${escHtml(note)}</p>
    <h1 style="margin-top:32px">Recent scans</h1>
    ${table}`;
  res.send(adminShell(content));
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
      td.mono { font-family:'JetBrains Mono',ui-monospace,monospace; color:#9fe6bd; }
      .note { color:#8a948e; font-size:11px; margin:10px 0 0; }
      .note b { color:#2ecc71; }
      a { color:#9fe6bd; text-decoration:none; }
      a:hover { color:#2ecc71; }
      .cards { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0 6px; }
      .card { background:#12161300; border:1px solid #1e2421; border-radius:8px; padding:12px 16px; min-width:110px; }
      .card .n { color:#2ecc71; font-size:22px; font-weight:700; }
      .card .l { color:#8a948e; font-size:10px; text-transform:uppercase; letter-spacing:.08em; margin-top:2px; }
      .ok { color:#2ecc71; }
      .dim { color:#6f7a74; }
      .bad { color:#ff6b6b; }
    </style></head><body>${body}</body></html>`;
}

app.listen(PORT, () => {
  console.log(`Claims Auditor listening on ${PORT}`);
  ensureTabs();
  db.init().catch((e) => console.error('db.init failed:', e.message));
});
