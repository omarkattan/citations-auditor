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
  // A real article is large; a challenge/shell is usually tiny.
  if (html.length < 1500) return true;
  return CHALLENGE_RE.test(html);
}

async function fetchDirect(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
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

async function fetchViaBrowserless(url, timeoutMs = 45000) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) return { ok: false, status: null, html: null, via: 'browserless', error: 'BROWSERLESS_TOKEN not set' };

  const base = (process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io').replace(/\/$/, '');
  const mode = (process.env.BROWSERLESS_MODE || 'unblock').toLowerCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (mode === 'content') {
      const res = await fetch(`${base}/content?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle2' } }),
        signal: controller.signal
      });
      if (!res.ok) return { ok: false, status: res.status, html: null, via: 'browserless', error: `browserless /content ${res.status}` };
      return { ok: true, status: 200, html: await res.text(), via: 'browserless', error: null };
    }

    // Default: /unblock, designed to bypass bot detection.
    const qs = new URLSearchParams({ token });
    if (process.env.BROWSERLESS_PROXY) {
      qs.set('proxy', process.env.BROWSERLESS_PROXY);
      if (process.env.BROWSERLESS_PROXY_COUNTRY) qs.set('proxyCountry', process.env.BROWSERLESS_PROXY_COUNTRY);
    }
    const res = await fetch(`${base}/unblock?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, content: true, cookies: false, screenshot: false, browserWSEndpoint: false }),
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, status: res.status, html: null, via: 'browserless', error: `browserless /unblock ${res.status}` };
    const data = await res.json();
    const html = data.content || data.html || '';
    if (!html) return { ok: false, status: 200, html: null, via: 'browserless', error: 'browserless returned no content' };
    return { ok: true, status: 200, html, via: 'browserless', error: null };
  } catch (err) {
    return { ok: false, status: null, html: null, via: 'browserless', error: err.message };
  } finally {
    clearTimeout(timer);
  }
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
    const bl = await fetchViaBrowserless(url);
    out.browserless = {
      ok: bl.ok,
      status: bl.status,
      error: bl.error || null,
      htmlLen: bl.html ? bl.html.length : 0
    };
  }
  return out;
}

module.exports = { fetchHtml, fetchViaBrowserless, fetchDiagnostic, browserlessConfigured, browserlessAlways, looksChallenged, BROWSER_HEADERS };
