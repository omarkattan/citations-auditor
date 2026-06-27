// discover.js
// Discovers the list of page URLs to audit, from one of two sources:
//   crawl  - follow internal links starting at the entered URL, optionally
//            limited to a folder path prefix (e.g. /blog)
//   single - audit only the single URL entered

const cheerio = require('cheerio');
const { fetchHtml, fetchViaBrowserless, browserlessConfigured } = require('./fetchpage');

const SKIP_EXTENSIONS = [
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico',
  '.css', '.js', '.json', '.xml', '.zip', '.mp4', '.mp3', '.woff',
  '.woff2', '.ttf', '.eot', '.avif'
];

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    // Drop trailing slash for consistency, except the root path.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function looksLikePage(url) {
  const lower = url.toLowerCase();
  return !SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function fetchPage(url) {
  return fetchHtml(url);
}

// Pull same-origin, page-like links out of an HTML string.
function extractLinks(html, current, origin, seen) {
  const links = [];
  const $ = cheerio.load(html);
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let abs;
    try {
      abs = normalizeUrl(new URL(href, current).toString());
    } catch {
      return;
    }
    if (!abs || seen.has(abs)) return;
    if (!abs.startsWith(origin)) return; // same origin only
    if (!looksLikePage(abs)) return;
    links.push(abs);
  });
  return links;
}

// ---- Source: crawl / folder -------------------------------------------------

async function crawlSite(startUrl, { maxPages = 15, pathPrefix = '' } = {}) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error('That does not look like a valid URL.');

  const origin = new URL(start).origin;
  const prefix = (pathPrefix || '').trim();
  const seen = new Set();
  const queue = [start];
  const found = [];

  while (queue.length && found.length < maxPages) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    const r = await fetchPage(current);
    if (!r.ok || !r.html) continue;

    // Only keep pages inside the requested folder, but still crawl outward
    // from the homepage so we can reach them.
    const path = new URL(current).pathname;
    if (!prefix || path.startsWith(prefix)) {
      found.push(current);
    }

    if (found.length >= maxPages) break;

    let links = extractLinks(r.html, current, origin, seen);

    // If a directly-fetched page yields no links, it is probably a JS shell.
    // Render it through Browserless and parse the real links.
    if (!links.length && r.via === 'direct' && browserlessConfigured()) {
      const rendered = await fetchViaBrowserless(current);
      if (rendered.ok) links = extractLinks(rendered.html, current, origin, seen);
    }

    links.forEach((abs) => queue.push(abs));
  }

  return found.slice(0, maxPages);
}


// ---- Source: single URL -----------------------------------------------------

function singleUrl(startUrl) {
  const url = normalizeUrl(startUrl);
  if (!url) throw new Error('That does not look like a valid URL.');
  return [url];
}

// ---- Source: pasted list of specific URLs -----------------------------------

function urlList(rawList, maxPages) {
  const parts = String(rawList || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const u = normalizeUrl(p);
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= maxPages) break;
  }
  return out;
}

// ---- Router -----------------------------------------------------------------

async function discover(source, startUrl, options = {}) {
  switch (source) {
    case 'crawl':
    case 'folder':
      return crawlSite(startUrl, options); // pathPrefix applied inside when set
    case 'single':
      return singleUrl(startUrl);
    case 'list':
      return urlList(startUrl, options.maxPages || 20);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}

module.exports = { discover, normalizeUrl };
