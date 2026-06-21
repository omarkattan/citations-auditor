// fetchpage.js
// Fetches page HTML directly with browser-like headers. Browserless has been
// removed: every page is fetched with a single direct request. Sites that
// block automated requests (Cloudflare and similar) are reported honestly as
// blocked so the UI can offer the "Paste text" path, and allowlisted client
// domains are fetched with a branded User-Agent plus a domain-scoped secret
// header so their WAF can wave the crawler through.
//
// Env vars:
//   CRAWLER_AUTH         - JSON map of client domain -> secret token. The secret
//                          is only ever sent to that domain (host or subdomain).
//   CRAWLER_AUTH_HEADER  - header name for the secret (default X-Sandstorm-Auth).

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
// interstitials and "enable JavaScript" shells. Used to report a block
// honestly instead of auditing the challenge text.
const CHALLENGE_RE = /just a moment|checking your browser|enable javascript and cookies|please verify you are human|verifying you are human|cf-chl|cf_chl|challenge-platform|challenges\.cloudflare|datadome|captcha-delivery|px-captcha|access denied|attention required/i;

function looksChallenged(html) {
  if (!html) return false;
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

// Main entry. Single direct fetch. If the page itself is a bot-challenge
// interstitial (served with a 200 but not really rendered), report it as
// blocked so the caller can offer "Paste text" rather than auditing the
// challenge and falsely reporting "no issues".
async function fetchHtml(url, opts = {}) {
  const direct = await fetchDirect(url, opts.timeoutMs);
  if (direct.ok && looksChallenged(direct.html)) {
    return { ok: false, status: direct.status, html: null, via: 'direct', blocked: true, error: 'Bot challenge page' };
  }
  return direct;
}

// Browserless has been removed. These stubs preserve the import surface so
// callers (audit.js, discover.js) keep working without edits; the guarded
// branches that referenced Browserless simply never fire now.
function browserlessConfigured() { return false; }
async function fetchViaBrowserless() {
  return { ok: false, status: null, html: null, via: 'browserless', error: 'Browserless removed' };
}

// Diagnostic: reports how a URL is fetched and how much text the extractor is
// likely to see at the HTML level. For troubleshooting blocks.
async function fetchDiagnostic(url) {
  const direct = await fetchDirect(url);
  return {
    url,
    browserlessConfigured: false,
    clientAuthApplied: Boolean(clientAuthFor(url)),
    direct: {
      ok: direct.ok,
      status: direct.status,
      blocked: Boolean(direct.blocked),
      notHtml: Boolean(direct.notHtml),
      htmlLen: direct.html ? direct.html.length : 0,
      challenged: looksChallenged(direct.html)
    }
  };
}

module.exports = { fetchHtml, fetchViaBrowserless, fetchDiagnostic, browserlessConfigured, looksChallenged, BROWSER_HEADERS };
