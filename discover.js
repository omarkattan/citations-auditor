// discover.js
// Discovers the list of page URLs to audit, from one of two sources:
//   crawl  - follow internal links starting at the entered URL, optionally
//            limited to a folder path prefix (e.g. /blog)
//   single - audit only the single URL entered

const cheerio = require('cheerio');
const { fetchHtml } = require('./fetchpage');

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

async function fetchText(url) {
  const r = await fetchHtml(url);
  return r.ok ? r.html : null;
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

    const html = await fetchText(current);
    if (!html) continue;

    // Only keep pages inside the requested folder, but still crawl outward
    // from the homepage so we can reach them.
    const path = new URL(current).pathname;
    if (!prefix || path.startsWith(prefix)) {
      found.push(current);
    }

    if (found.length >= maxPages) break;

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
      queue.push(abs);
    });
  }

  return found.slice(0, maxPages);
}


// ---- Source: single URL -----------------------------------------------------

function singleUrl(startUrl) {
  const url = normalizeUrl(startUrl);
  if (!url) throw new Error('That does not look like a valid URL.');
  return [url];
}

// ---- Router -----------------------------------------------------------------

async function discover(source, startUrl, options = {}) {
  switch (source) {
    case 'crawl':
    case 'folder':
      return crawlSite(startUrl, options); // pathPrefix applied inside when set
    case 'single':
      return singleUrl(startUrl);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}

module.exports = { discover, normalizeUrl };
