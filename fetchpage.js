// fetchpage.js
// Fetches page HTML, first directly (with browser-like headers) and, if a site
// blocks the request, through Browserless (real headless Chrome that runs JS and
// defeats most bot detection). Browserless is only used as a fallback, so normal
// pages cost nothing extra.
//
// Env vars (all optional; Browserless is off unless BROWSERLESS_TOKEN is set):
//   BROWSERLESS_TOKEN          - enables the fallback
//   BROWSERLESS_URL            - base URL (default https://production-sfo.browserless.io)
//   BROWSERLESS_MODE           - 'unblock' (default, best for blocked sites) or 'content'
//   BROWSERLESS_PROXY          - e.g. 'residential' (for the unblock mode)
//   BROWSERLESS_PROXY_COUNTRY  - e.g. 'us'

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

const BLOCK_STATUSES = [401, 403, 429, 503];

// Identity used only when fetching an allowlisted client domain, so the client
// can recognize and skip-challenge our crawler.
const BRANDED_UA = 'SandstormClaimsAuditor/1.0 (+https://claims-auditor.sandstormdigital.com/bot)';
const AUTH_HEADER = process.env.CRAWLER_AUTH_HEADER || 'X-Sandstorm-Auth';

// CRAWLER_AUTH is a JSON map of client domain -> secret token. The secret is
// only ever sent to that domain (matched by host or subdomain), never to other
// sites, so it cannot leak to third parties we crawl.
function clientAuthFor(url) {
  const raw = process.env.CRAWLER_AUTH;
  if (!raw) return null;
  let map;
  try { map = JSON.parse(raw); } catch { return null; }
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
  for (const key of Object.keys(map)) {
    const k = key.replace(/^www\./, '').toLowerCase();
    if (host === k || host.endsWith('.' + k)) return { header: AUTH_HEADER, secret: map[key] };
  }
  return null;
}

// Headers for a direct fetch. Client domains get the branded UA plus the secret
// auth header; everything else gets the browser-like headers.
function directHeaders(url) {
  const auth = clientAuthFor(url);
  if (!auth) return BROWSER_HEADERS;
  return { ...BROWSER_HEADERS, 'User-Agent': BRANDED_UA, [auth.header]: auth.secret };
}

// Markers of a page that was served but not really rendered: bot-detection
// interstitials and "enable JavaScript" shells.
const CHALLENGE_RE = /just a moment|checking your browser|enable javascript|please verify you are human|verifying you are human|cf-chl|cf_chl|challenge-platform|challenges\.cloudflare|datadome|captcha-delivery|px-captcha|access denied|attention required/i;

function browserlessConfigured() {
  return Boolean(process.env.BROWSERLESS_TOKEN);
}

function browserlessAlways() {
  return process.env.BROWSERLESS_ALWAYS === 'true';
}

function looksChallenged(html) {
  if (!html) return false;
  // Marker-based only. A small page is not automatically a challenge; thin
  // article text is handled separately by the audit/crawl retries.
  return CHALLENGE_RE.test(html);
}

async function fetchDirect(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: directHeaders(url), signal: controller.signal, redirect: 'follow' });
    const status = res.status;
    if (!res.ok) {
      return { ok: false, status, html: null, via: 'direct', blocked: BLOCK_STATUSES.includes(status), error: `HTTP ${status}` };
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) {
      return { ok: false, status, html: null, via: 'direct', notHtml: true, error: 'Not an HTML page' };
    }
    return { ok: true, status, html: await res.text(), via: 'direct', error: null };
  } catch (err) {
    return { ok: false, status: null, html: null, via: 'direct', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function browserlessConfig() {
  return {
    base: (process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io').replace(/\/$/, ''),
    mode: (process.env.BROWSERLESS_MODE || 'unblock').toLowerCase(),
    proxy: process.env.BROWSERLESS_PROXY || null,
    proxyCountry: process.env.BROWSERLESS_PROXY_COUNTRY || null,
    proxySticky: process.env.BROWSERLESS_PROXY_STICKY !== 'false',
    // Browserless caps the /unblock timeout at 60,000ms on this plan. Clamp so
    // we never send a value it rejects with a 400.
    serverTimeoutMs: Math.min(parseInt(process.env.BROWSERLESS_UNBLOCK_TIMEOUT_MS || '60000', 10), 60000),
    alwaysOn: browserlessAlways()
  };
}

// Raw Browserless call with no challenge filtering. Returns the actual response
// so callers (and the diagnostic) can see exactly what came back. stickyOverride
// lets the retry loop rotate to a fresh residential IP between attempts.
async function browserlessRaw(url, timeoutMs, stickyOverride) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return { status: null, html: null, error: 'BROWSERLESS_TOKEN not set' };

  const cfg = browserlessConfig();
  const sticky = stickyOverride === undefined ? cfg.proxySticky : stickyOverride;
  // Client abort must outlast the server-side timeout, or we cut off a
  // challenge that was about to clear.
  const t = timeoutMs || parseInt(process.env.BROWSERLESS_TIMEOUT_MS || String(cfg.serverTimeoutMs + 15000), 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    if (cfg.mode === 'content') {
      const res = await fetch(`${cfg.base}/content?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle2' } }),
        signal: controller.signal
      });
      if (!res.ok) return { status: res.status, html: null, error: `browserless /content ${res.status}` };
      return { status: 200, html: await res.text(), error: null };
    }

    const qs = new URLSearchParams({ token });
    if (cfg.proxy) {
      qs.set('proxy', cfg.proxy);
      if (cfg.proxyCountry) qs.set('proxyCountry', cfg.proxyCountry);
      if (sticky) qs.set('proxySticky', 'true');
    }
    qs.set('timeout', String(cfg.serverTimeoutMs));

    const res = await fetch(`${cfg.base}/unblock?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, content: true, bestAttempt: true, cookies: false, screenshot: false }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: res.status, html: null, error: `browserless /unblock ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    return { status: 200, html: data.content || data.html || '', error: null };
  } catch (err) {
    return { status: null, html: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Browserless unblock with automatic retries. Cloudflare solving is
// probabilistic per residential IP, so on a challenge or transient failure we
// retry with a fresh IP (sticky off) before giving up. This is what turns
// intermittent success into reliable success on hard sites.
async function fetchViaBrowserless(url, timeoutMs) {
  if (!browserlessConfigured()) return { ok: false, status: null, html: null, via: 'browserless', error: 'BROWSERLESS_TOKEN not set' };
  const maxTries = 1 + Math.max(0, parseInt(process.env.BROWSERLESS_RETRIES || '2', 10));
  let last = { ok: false, status: null, html: null, via: 'browserless', error: 'browserless not attempted' };

  for (let i = 0; i < maxTries; i++) {
    // First attempt uses the configured stickiness; retries rotate the IP.
    const sticky = i === 0 ? undefined : false;
    const r = await browserlessRaw(url, timeoutMs, sticky);

    if (r.error) {
      last = { ok: false, status: r.status, html: null, via: 'browserless', error: r.error };
      // Plan/auth/units problems will not improve on retry.
      if (r.status === 401 || r.status === 402 || r.status === 403) break;
      await sleep(700);
      continue;
    }

    const fin = finalizeBrowserless(r.html);
    if (fin.ok) return fin;

    // Got a challenge page; wait briefly and try a fresh residential IP.
    last = fin;
    await sleep(800);
  }
  return last;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Detect an UNSOLVED bot interstitial. Two things make this tricky: Cloudflare
// leaves a "challenge-platform" script (and some boilerplate text) in the HTML
// even after the challenge is solved, and that boilerplate can sit in the head
// of a fully rendered page. So: trust the page title, and only treat body
// markers as a block when the page is small. A real interstitial is tiny
// (~10-30KB); a large rendered page that merely carries leftover challenge text
// is genuine content.
function isBlockInterstitial(html) {
  if (!html) return true;
  const head = html.slice(0, 8000);
  const tm = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = tm ? tm[1].toLowerCase() : '';
  if (/just a moment|attention required|access denied|security check|verifying you are human|please wait|are you a robot|checking your browser/.test(title)) return true;
  if (html.length < 15000 &&
      /verifying you are human|enable javascript and cookies to continue|needs to review the security of your connection|performing a security check before|ddos protection by|px-captcha|captcha-delivery|datadome/i.test(head)) {
    return true;
  }
  return false;
}

// Treat a returned bot-detection page as a failure, not as real content, so the
// auditor reports "still blocked" instead of analyzing the interstitial.
function finalizeBrowserless(html) {
  if (!html) return { ok: false, status: 200, html: null, via: 'browserless', error: 'browserless returned no content' };
  if (isBlockInterstitial(html)) {
    return { ok: false, status: 200, html: null, via: 'browserless', error: 'browserless got a challenge page (still blocked)' };
  }
  return { ok: true, status: 200, html, via: 'browserless', error: null };
}

// Direct first; fall back to Browserless when the site blocks us, the
// connection fails, or the page looks like an unrendered challenge/shell.
// BROWSERLESS_ALWAYS=true forces every fetch through Browserless.
async function fetchHtml(url, opts = {}) {
  if (browserlessAlways() && browserlessConfigured()) {
    const bl = await fetchViaBrowserless(url);
    if (bl.ok) return bl;
    // fall through to a direct attempt if Browserless failed
  }

  const direct = await fetchDirect(url, opts.timeoutMs);

  if (direct.ok) {
    if (browserlessConfigured() && !browserlessAlways() && looksChallenged(direct.html)) {
      const bl = await fetchViaBrowserless(url);
      if (bl.ok) return bl;
    }
    return direct;
  }
  if (direct.notHtml) return direct;

  const shouldFallback = direct.blocked || direct.status === null;
  if (shouldFallback && browserlessConfigured()) {
    const bl = await fetchViaBrowserless(url);
    if (bl.ok) return bl;
    return { ...direct, browserlessError: bl.error };
  }
  return direct;
}

// Diagnostic: reports how a URL is fetched (direct vs Browserless), statuses,
// sizes, and whether the page looks challenged. For troubleshooting blocks.
async function fetchDiagnostic(url) {
  const direct = await fetchDirect(url);
  const out = {
    url,
    browserlessConfigured: browserlessConfigured(),
    browserlessAlways: browserlessAlways(),
    clientAuthApplied: Boolean(clientAuthFor(url)),
    config: browserlessConfig(),
    direct: {
      ok: direct.ok,
      status: direct.status,
      blocked: Boolean(direct.blocked),
      notHtml: Boolean(direct.notHtml),
      htmlLen: direct.html ? direct.html.length : 0,
      challenged: looksChallenged(direct.html)
    }
  };
  if (browserlessConfigured()) {
    const raw = await browserlessRaw(url);
    out.browserless = {
      status: raw.status,
      error: raw.error || null,
      htmlLen: raw.html ? raw.html.length : 0,
      challenged: isBlockInterstitial(raw.html || ''),
      sample: (raw.html || '').replace(/\s+/g, ' ').slice(0, 200)
    };
  }
  return out;
}

module.exports = { fetchHtml, fetchViaBrowserless, fetchDiagnostic, browserlessConfigured, browserlessAlways, looksChallenged, BROWSER_HEADERS };
