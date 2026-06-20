// lib/audit.js
// Fetches a page, extracts readable text, and asks Claude to flag
// unsubstantiated claims against Google E-E-A-T, recommending evidence
// and (via web search) a real candidate citation for each.

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('node:https');
const { fetchHtml, fetchViaBrowserless, browserlessConfigured } = require('./fetchpage');

const MODEL = process.env.CLAIMS_MODEL || 'claude-sonnet-4-6';
const MAX_TEXT_CHARS = 8000;

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

const FACTCHECK_PROMPT = `You are an E-E-A-T claim auditor AND fact-checker for a digital marketing agency. You read the text of a single web page and do TWO jobs.

1) SUBSTANTIATION. Flag claims that are unsupported on the page, judged against Google's E-E-A-T guidelines:
- Unsourced statistics or numbers
- Unproven superlatives ("the best", "#1", "leading", "fastest")
- Authority or award claims with no proof
- Health, finance, legal, or safety (YMYL) assertions stated as fact
- Absolute guarantees ("guaranteed", "always", "never", "100% safe")

2) ACCURACY AND RECENCY. For concrete, checkable factual claims (statistics, dates, prices, tax or regulatory figures, version numbers, "first/only/largest/oldest" claims, named facts), use web search to verify them against current reliable sources and compare:
- If the claim conflicts with what current reliable sources say, set finding_type to "inaccurate".
- If the claim was likely true once but is now superseded by newer data, prices, versions, or dates, set finding_type to "outdated".
- If it merely lacks backing on the page, set finding_type to "unsubstantiated".

CONFIDENCE AND HONESTY (important):
- Only assert "inaccurate" or "outdated" when you actually found a credible contradicting or updated source. Set confidence "high" or "medium", put what current sources say in current_fact, and put that source in suggested_source.
- If something looks questionable but you cannot confirm it is wrong (no definitive source, or sources disagree), do NOT claim it is wrong. Flag it with confidence "low", set finding_type to your best guess, and write the issue as a "worth verifying" note explaining what to check. Leave current_fact as "".
- Never invent a source, URL, statistic, or "current fact". When unverified, use low confidence.

Do NOT flag subjective opinion framed as opinion, claims already supported on the page with a visible source, or ordinary descriptive copy.

Return ONLY a JSON array, no prose, no markdown fences. Each item must be exactly:
{
  "claim": "the claim text, trimmed",
  "context": "a short surrounding snippet for locating it",
  "finding_type": "unsubstantiated | inaccurate | outdated",
  "claim_type": "statistic | superlative | authority | testimonial | ymyl | absolute | fact | other",
  "eeat": "Experience | Expertise | Authoritativeness | Trustworthiness",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "issue": "one sentence on why it is unsubstantiated, conflicts with current sources, or is outdated (or a 'worth verifying' note when confidence is low)",
  "current_fact": "what current reliable sources actually say, for inaccurate or outdated findings; otherwise an empty string",
  "recommendation": "the correction, or the evidence that would substantiate it",
  "suggested_source": { "title": "source title", "url": "https://..." } or null
}

Return at most 12 of the most important findings. If the page has none, return [].`;

function buildSystemPrompt(factCheck) { return factCheck ? FACTCHECK_PROMPT : SYSTEM_PROMPT; }

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

async function callClaude(client, userContent, useWebSearch, system, attempt = 0) {
  const request = {
    model: MODEL,
    max_tokens: 2500,
    system: system || SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }]
  };
  if (useWebSearch) {
    request.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  // Stream the response and assemble the final message. If the connection drops
  // (Render free tier occasionally severs keep-alive sockets), retry a couple
  // of times before giving up.
  try {
    const stream = client.messages.stream(request);
    const finalMessage = await stream.finalMessage();
    const u = finalMessage.usage || {};
    const usage = {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      web_searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0
    };
    return { text: collectText(finalMessage.content), usage };
  } catch (err) {
    if (isTransient(err) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return callClaude(client, userContent, useWebSearch, system, attempt + 1);
    }
    throw err;
  }
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
function addUsage(acc, u) {
  acc.input_tokens += (u && u.input_tokens) || 0;
  acc.output_tokens += (u && u.output_tokens) || 0;
  acc.web_searches += (u && u.web_searches) || 0;
  return acc;
}

async function auditPage(url, { apiKey, findSources = true, factCheck = false } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    if (fetched.notHtml) return { url, error: 'Not an HTML page, skipped.', claims: [] };
    if (fetched.blocked) {
      const note = browserlessConfigured()
        ? ', even through Browserless. Try Paste text.'
        : '. Connect Browserless or use Paste text.';
      return { url, error: `Blocked by the site (HTTP ${fetched.status})${note}`, claims: [] };
    }
    return { url, error: fetched.error || 'Page could not be reached.', claims: [] };
  }

  let { title, text } = extractText(fetched.html);
  let browserless = fetched.via === 'browserless' ? 1 : 0;

  // If a direct fetch returned little article text, the page is probably
  // JavaScript-rendered or a shell. If Browserless is available, render it
  // properly and retry. (A real article runs to thousands of characters.)
  if ((!text || text.length < 600) && fetched.via === 'direct' && browserlessConfigured()) {
    const rendered = await fetchViaBrowserless(url);
    browserless += 1;
    if (rendered.ok) {
      const ex = extractText(rendered.html);
      if (ex.text && ex.text.length > (text || '').length) {
        title = ex.title || title;
        text = ex.text;
      }
    }
  }

  if (!text || text.length < 120) {
    return { url, title, error: 'Too little readable text to audit.', claims: [], browserless };
  }

  const result = await runClaims(url, title, text, findSources, key, factCheck);
  result.browserless = browserless;
  return result;
}

// Audit text the user pasted in (used when a site blocks automated fetches).
// Accepts either plain page copy or raw HTML.
async function auditText(rawText, { url = 'Pasted text', title = '', apiKey, findSources = true, factCheck = false } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  let text = (rawText || '').trim();
  if (/<[a-z!][\s\S]*>/i.test(text)) {
    const extracted = extractText(text);
    text = extracted.text;
    if (!title && extracted.title) title = extracted.title;
  } else {
    text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  }

  if (!text || text.length < 120) {
    return { url, title, error: 'Too little text to audit. Paste the page copy and try again.', claims: [] };
  }

  return runClaims(url, title, text, findSources, key, factCheck);
}

// Shared core: send the page text to Claude and return parsed claims. When
// factCheck is on, the prompt also verifies accuracy and recency via web search.
// Falls back to substantiation-only (no search) if the search call fails.
async function runClaims(url, title, text, findSources, apiKey, factCheck = false) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const client = makeClient(key, { maxRetries: 3, timeout: 120000 });
  const userContent = `Page URL: ${url}\nPage title: ${title}\n\nPage text:\n"""\n${text}\n"""`;
  const usage = { ...ZERO_USAGE };
  // Fact-checking requires web search to verify against current sources.
  const useSearch = findSources || factCheck;
  const system = buildSystemPrompt(factCheck);

  try {
    const r = await callClaude(client, userContent, useSearch, system);
    addUsage(usage, r.usage);
    return { url, title, claims: parseClaims(r.text), usage };
  } catch (err) {
    // If web search is unavailable, fall back to substantiation-only (no
    // search, base prompt) so the audit still completes.
    if (useSearch) {
      try {
        const r = await callClaude(client, userContent, false, SYSTEM_PROMPT);
        addUsage(usage, r.usage);
        return { url, title, claims: parseClaims(r.text), usage };
      } catch (err2) {
        return { url, title, error: `Audit failed: ${describeError(err2)}`, claims: [], usage };
      }
    }
    return { url, title, error: `Audit failed: ${describeError(err)}`, claims: [], usage };
  }
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
    browserless: browserlessConfigured(),
    rawHttps: raw,
    sdk
  };
}

module.exports = { auditPage, auditText, extractText, parseClaims, diagnose };
