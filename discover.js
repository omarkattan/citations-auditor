// lib/discover.js
// Discovers the list of page URLs to audit, from one of several sources:
//   crawl   - follow internal links starting at the homepage
//   folder  - same as crawl but limited to a path prefix (e.g. /blog)
//   sitemap - read the XML sitemap (handles sitemap index files too)
//   ahrefs  - pull top pages from the Ahrefs API (needs AHREFS_API_KEY)
//   gsc     - pull top pages from Google Search Console (needs service account access)

const cheerio = require('cheerio');
const { google } = require('googleapis');

const USER_AGENT =
  'SandstormClaimsAuditor/1.0 (+https://sandstormdigital.com)';

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

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml' },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

// ---- Source: sitemap --------------------------------------------------------

async function fromSitemap(startUrl, { maxPages = 15, pathPrefix = '' } = {}) {
  const origin = new URL(normalizeUrl(startUrl)).origin;
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const prefix = (pathPrefix || '').trim();

  const urls = [];
  const visitedSitemaps = new Set();

  async function readSitemap(sitemapUrl) {
    if (visitedSitemaps.has(sitemapUrl) || urls.length >= maxPages) return;
    visitedSitemaps.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl);
    if (!xml) return;

    const $ = cheerio.load(xml, { xmlMode: true });

    // Sitemap index: collect child sitemaps first.
    const childSitemaps = $('sitemap > loc')
      .map((_, el) => $(el).text().trim())
      .get();
    for (const child of childSitemaps) {
      if (urls.length >= maxPages) break;
      await readSitemap(child);
    }

    // Regular sitemap: collect page URLs.
    $('url > loc').each((_, el) => {
      if (urls.length >= maxPages) return;
      const loc = normalizeUrl($(el).text().trim());
      if (!loc || !looksLikePage(loc)) return;
      const path = new URL(loc).pathname;
      if (prefix && !path.startsWith(prefix)) return;
      urls.push(loc);
    });
  }

  for (const candidate of candidates) {
    if (urls.length >= maxPages) break;
    await readSitemap(candidate);
  }

  if (!urls.length) {
    throw new Error('No sitemap found at /sitemap.xml. Try the crawl source instead.');
  }
  return urls.slice(0, maxPages);
}

// ---- Source: Ahrefs ---------------------------------------------------------

async function fromAhrefs(startUrl, { maxPages = 15 } = {}) {
  const key = process.env.AHREFS_API_KEY;
  if (!key) {
    throw new Error('Ahrefs source needs AHREFS_API_KEY set in the environment.');
  }

  const target = new URL(normalizeUrl(startUrl)).hostname;
  const params = new URLSearchParams({
    target,
    country: 'us',
    limit: String(maxPages),
    order_by: 'sum_traffic:desc',
    select: 'url,sum_traffic',
    mode: 'subdomains',
    output: 'json'
  });

  const res = await fetch(
    `https://api.ahrefs.com/v3/site-explorer/top-pages?${params.toString()}`,
    { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ahrefs API returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const rows = data.pages || data.top_pages || [];
  const urls = rows
    .map((row) => normalizeUrl(row.url))
    .filter((u) => u && looksLikePage(u));

  if (!urls.length) throw new Error('Ahrefs returned no pages for that target.');
  return urls.slice(0, maxPages);
}

// ---- Source: Google Search Console -----------------------------------------

async function fromGsc(startUrl, { maxPages = 15 } = {}) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('GSC source needs GOOGLE_SERVICE_ACCOUNT set in the environment.');
  }

  const siteUrl = process.env.GSC_SITE_URL || new URL(normalizeUrl(startUrl)).origin + '/';
  const credentials = JSON.parse(raw);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly']
  });
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['page'],
      rowLimit: maxPages,
      orderBy: [{ field: 'clicks', descending: true }]
    }
  });

  const rows = (res.data && res.data.rows) || [];
  const urls = rows
    .map((r) => normalizeUrl(r.keys && r.keys[0]))
    .filter((u) => u && looksLikePage(u));

  if (!urls.length) {
    throw new Error('Search Console returned no pages. Check that the service account has access to ' + siteUrl);
  }
  return urls.slice(0, maxPages);
}

// ---- Router -----------------------------------------------------------------

async function discover(source, startUrl, options = {}) {
  switch (source) {
    case 'crawl':
      return crawlSite(startUrl, options);
    case 'folder':
      return crawlSite(startUrl, options); // pathPrefix is applied inside
    case 'sitemap':
      return fromSitemap(startUrl, options);
    case 'ahrefs':
      return fromAhrefs(startUrl, options);
    case 'gsc':
      return fromGsc(startUrl, options);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}

module.exports = { discover, normalizeUrl };
