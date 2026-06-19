// lib/audit.js
// Fetches a page, extracts readable text, and asks Claude to flag
// unsubstantiated claims against Google E-E-A-T, recommending evidence
// and (via web search) a real candidate citation for each.

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('node:https');

const MODEL = process.env.CLAIMS_MODEL || 'claude-sonnet-4-6';
const USER_AGENT = 'SandstormClaimsAuditor/1.0 (+https://sandstormdigital.com)';
const MAX_TEXT_CHARS = 8000;

// Browser-like headers. Many sites return 403 to non-browser User-Agents, so we
// present as Chrome on a normal page navigation.
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

// Build a dedicated dispatcher that does not reuse pooled sockets. A consistent
// "Premature close" usually comes from undici handing back a connection the far
// side has already closed; fresh connections per request avoid that.
let customFetch = null;
try {
  const { Agent, fetch: undiciFetch } = require('undici');
  const dispatcher = new Agent({
    pipelining: 0,
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: { timeout: 30000 }
  });
  customFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
} catch {
  customFetch = null;
}

function makeClient(key, extra = {}) {
  const opts = { apiKey: key, ...extra };
  if (customFetch) opts.fetch = customFetch;
  return new Anthropic(opts);
}

const SYSTEM_PROMPT = `You are an E-E-A-T claim auditor for a digital marketing agency. You read the text of a single web page and flag statements that assert something factual without backing it up, judged against Google's E-E-A-T guidelines (Experience, Expertise, Authoritativeness, Trustworthiness).

Flag a claim only when it genuinely lacks substantiation. Typical targets:
- Unsourced statistics or numbers ("90% of customers save money")
- Unproven superlatives ("the best", "#1", "leading", "fastest")
- Authority or award claims with no proof ("award-winning", "industry-trusted", "certified")
- Health, finance, legal, or safety (YMYL) assertions stated as fact without an authority
- Absolute guarantees ("guaranteed results", "always", "never", "100% safe")

Do NOT flag:
- Clearly subjective opinion framed as opinion
- Claims that are already supported on the page with a visible source, citation, or data
- Ordinary descriptive copy that makes no factual assertion

For each flagged claim, use web search to look for ONE credible third-party source (peer-reviewed study, government or standards body, reputable publication, official record) that could substantiate it. If you cannot find a genuinely credible source, set suggested_source to null. Never invent a source or URL.

Return ONLY a JSON array, no prose, no markdown fences. Each item must be exactly:
{
  "claim": "the claim text, trimmed",
  "context": "a short surrounding snippet for locating it",
  "claim_type": "statistic | superlative | authority | testimonial | ymyl | absolute | other",
  "eeat": "Experience | Expertise | Authoritativeness | Trustworthiness",
  "severity": "high | medium | low",
  "issue": "one sentence on why it is unsubstantiated",
  "recommendation": "the type of evidence that would substantiate it",
  "suggested_source": { "title": "source title", "url": "https://..." } or null
}

Return at most 12 of the most important claims. If the page has no unsubstantiated claims, return [].`;

function extractText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer, header, aside, form, svg').remove();

  const title = $('title').first().text().trim();
  const root = $('main').length ? $('main') : $('article').length ? $('article') : $('body');

  const text = root
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  return { title, text };
}

function parseClaims(raw) {
  if (!raw) return [];
  let cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function collectText(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function isTransient(err) {
  const m = ((err && err.message) || '').toLowerCase();
  return (
    m.includes('premature close') ||
    m.includes('terminated') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('fetch failed') ||
    m.includes('other side closed')
  );
}

async function callClaude(client, userContent, useWebSearch, attempt = 0) {
  const request = {
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }]
  };
  if (useWebSearch) {
    request.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  }
  // Stream the response and assemble the final message. If the connection drops
  // (Render free tier occasionally severs keep-alive sockets), retry a couple
  // of times before giving up.
  try {
    const stream = client.messages.stream(request);
    const finalMessage = await stream.finalMessage();
    return collectText(finalMessage.content);
  } catch (err) {
    if (isTransient(err) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return callClaude(client, userContent, useWebSearch, attempt + 1);
    }
    throw err;
  }
}

async function auditPage(url, { apiKey, findSources = true } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let html;
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok) {
      const blocked = res.status === 403 || res.status === 401 || res.status === 429;
      const msg = blocked
        ? `Blocked by the site (HTTP ${res.status}), likely bot protection.`
        : `Could not fetch page (HTTP ${res.status})`;
      return { url, error: msg, claims: [] };
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return { url, error: 'Not an HTML page, skipped.', claims: [] };
    html = await res.text();
  } catch {
    return { url, error: 'Page timed out or could not be reached.', claims: [] };
  } finally {
    clearTimeout(timer);
  }

  const { title, text } = extractText(html);
  if (!text || text.length < 120) {
    return { url, title, error: 'Too little readable text to audit.', claims: [] };
  }

  const client = makeClient(key, { maxRetries: 3, timeout: 120000 });
  const userContent = `Page URL: ${url}\nPage title: ${title}\n\nPage text:\n"""\n${text}\n"""`;

  let raw;
  try {
    raw = await callClaude(client, userContent, findSources);
  } catch (err) {
    // If web search is unavailable on this account, fall back to
    // recommendation-only so the scan still completes.
    if (findSources) {
      try {
        raw = await callClaude(client, userContent, false);
      } catch (err2) {
        return { url, title, error: `Audit failed: ${describeError(err2)}`, claims: [] };
      }
    } else {
      return { url, title, error: `Audit failed: ${describeError(err)}`, claims: [] };
    }
  }

  return { url, title, claims: parseClaims(raw) };
}

function describeError(err) {
  const parts = [err.message || 'unknown error'];
  const code = err.code || (err.cause && err.cause.code);
  if (code) parts.push(`code=${code}`);
  if (err.status) parts.push(`status=${err.status}`);
  if (err.cause && err.cause.message && err.cause.message !== err.message) {
    parts.push(`cause=${err.cause.message}`);
  }
  return parts.join(' ');
}

// Raw HTTPS POST using Node's native stack with a fresh, non-keepalive
// connection. If this completes but the SDK does not, the issue is the
// fetch/undici transport. If this also fails, the issue is the network path
// between this host and the API.
function rawHttpsProbe(key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }]
    });
    const req = https.request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
          connection: 'close'
        },
        timeout: 30000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () =>
          resolve({ completed: true, status: res.statusCode, bytes: data.length, sample: data.slice(0, 160) })
        );
        res.on('aborted', () => resolve({ completed: false, error: 'response aborted' }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ completed: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ completed: false, error: e.message, code: e.code }));
    req.write(body);
    req.end();
  });
}

async function sdkProbe(key) {
  const client = makeClient(key, { maxRetries: 0, timeout: 60000 });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }]
    });
    const reply = (res.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { ok: true, reply };
  } catch (err) {
    return {
      ok: false,
      error: {
        name: err.name,
        message: err.message,
        status: err.status || null,
        code: err.code || null
      }
    };
  }
}

async function diagnose() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, stage: 'env', error: 'ANTHROPIC_API_KEY is not set.' };

  const [raw, sdk] = await Promise.all([rawHttpsProbe(key), sdkProbe(key)]);
  return {
    model: MODEL,
    usingCustomDispatcher: Boolean(customFetch),
    rawHttps: raw,
    sdk
  };
}

module.exports = { auditPage, extractText, parseClaims, diagnose };
