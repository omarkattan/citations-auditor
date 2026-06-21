// lib/audit.js
// Fetches a page, extracts readable text, and asks Claude to flag
// unsubstantiated claims against Google E-E-A-T, recommending evidence
// and (via web search) a real candidate citation for each.

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('node:https');
const { fetchHtml } = require('./fetchpage');

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

const SEVERITY_RUBRIC = `

SEVERITY - assign every finding consistently using these rules, and do NOT default everything to "low":
- high: a YMYL claim stated as fact without an on-page authority (health, medical, safety, financial, tax, legal); any claim a fact-check shows is inaccurate or contradicted by current reliable sources; an absolute guarantee ("100% safe", "guaranteed results", "never fails"); a specific unsourced statistic or quantified result used to back a purchase, money, or health decision; a false, expired, or unverifiable authority, certification, or award claim.
- medium: an unsourced statistic, number, or percentage on a non-YMYL topic; an unproven superlative or category claim ("the best", "#1", "leading", "first-of-its-kind", "the only"); a fact that is outdated (true once, now superseded); a causal or predictive claim stated as fact.
- low: vague puffery or descriptive marketing language with only a thin factual veneer, and minor unsupported specifics with little real-world stakes.

When a claim could fit two bands, choose the higher one. A page that makes YMYL, guarantee, statistical, or clearly inaccurate claims MUST surface those as high or medium per the rules above; returning only low-severity findings on such a page is an error.`;

const SYSTEM_PROMPT = `You are an E-E-A-T claim auditor for a digital marketing agency. You read the text of a single web page and flag statements that assert something factual without backing it up on the page, judged against Google's E-E-A-T guidelines (Experience, Expertise, Authoritativeness, Trustworthiness).

Be thorough. Surface every material claim that is not backed on the page, not only the most obvious one. Typical targets:
- Unsourced statistics, numbers, or percentages ("90% of customers save money", "people are living longer than ever before")
- Unproven superlatives ("the best", "#1", "leading", "fastest")
- Authority or award claims with no proof ("award-winning", "industry-trusted", "certified")
- Health, finance, legal, or safety (YMYL) assertions stated as fact without an authority
- Absolute guarantees ("guaranteed results", "always", "never", "100% safe")
- Causal or predictive claims stated as fact ("X protects your wealth", "this leads to Y")

Judgment rules (important):
- A citation or footnote substantiates ONLY the specific claim it is directly attached to. Do NOT assume the rest of the page is sourced just because some claims carry footnotes. Judge each claim on its own.
- A bare footnote marker with no identifiable source (for example "[1]" with no named source) is weak support. For high-stakes (YMYL) claims, you may still flag it as needing a clear, named citation.
- Web search is ONLY for suggesting a third-party source for the fix. Finding a source online does NOT mean the claim is substantiated on the page. If the claim lacks an on-page citation, flag it regardless, and put any source you find in suggested_source.
- When you are genuinely unsure whether a factual assertion is backed on the page, flag it rather than skip it.

Do NOT flag:
- Clearly subjective opinion framed as opinion ("we believe", "in our view")
- Ordinary descriptive copy that makes no factual assertion
- A claim immediately followed by its own specific, named source or data

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

Return up to 12 of the most important claims, ordered by severity. If the page truly makes no unsubstantiated factual claims, return [].${SEVERITY_RUBRIC}`;

const FACTCHECK_PROMPT = `You are an E-E-A-T claim auditor AND fact-checker for a digital marketing agency. You read the text of a single web page and do TWO jobs.

1) SUBSTANTIATION. Flag claims that are unsupported on the page, judged against Google's E-E-A-T guidelines:
- Unsourced statistics or numbers
- Unproven superlatives ("the best", "#1", "leading", "fastest")
- Authority or award claims with no proof
- Health, finance, legal, or safety (YMYL) assertions stated as fact
- Absolute guarantees ("guaranteed", "always", "never", "100% safe")
Be thorough and judge each claim on its own. A citation or footnote substantiates only the claim it is directly attached to; do not assume the rest of the page is sourced because some claims carry footnotes. Web search is for suggesting a source, not for deciding a claim is fine: if it lacks an on-page citation, flag it.

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

Process: first carry out job 1 (substantiation) on the page, which needs no searching. Then for job 2 run the web searches you need to verify the concrete facts. Your final output must be ONLY the JSON array described above, nothing else. A normal marketing or blog page almost always has at least a few unsupported or checkable claims, so returning an empty array should be rare; only do so if the page genuinely makes no factual claims at all.

Return at most 12 of the most important findings. If the page genuinely has none, return [].${SEVERITY_RUBRIC}`;

function buildSystemPrompt(factCheck) { return factCheck ? FACTCHECK_PROMPT : SYSTEM_PROMPT; }

const ACCURACY_PROMPT = `You are a fact-checker for a digital marketing agency. You read the text of a single web page and check its concrete, checkable factual claims for ACCURACY and RECENCY using web search. Concrete claims include statistics, percentages, dates, prices, tax or regulatory figures, version numbers, "first/only/largest/oldest" claims, and named facts about companies, products, laws, or events.

For each such claim worth checking, search current reliable sources and compare:
- If the claim conflicts with what current reliable sources say, set finding_type "inaccurate".
- If the claim was likely true once but is now superseded by newer data, prices, versions, or dates, set finding_type "outdated".

Honesty rules:
- Only assert "inaccurate" or "outdated" when you actually found a credible contradicting or updated source. Set confidence "high" or "medium", put what current sources say in current_fact, and put that source in suggested_source.
- If a claim looks questionable but you cannot confirm it is wrong, do NOT claim it is wrong. Set finding_type to your best guess, confidence "low", write the issue as a "worth verifying" note, and leave current_fact as "".
- Never invent a source, URL, statistic, or current fact.
- Do NOT flag claims that are merely unsourced but plausibly accurate; a separate pass handles substantiation. Focus only on accuracy and recency.

Run the web searches you need, then output ONLY a JSON array, no prose, no markdown fences. Each item must be exactly:
{
  "claim": "the claim text, trimmed",
  "context": "a short surrounding snippet for locating it",
  "finding_type": "inaccurate | outdated",
  "claim_type": "statistic | fact | superlative | authority | other",
  "eeat": "Experience | Expertise | Authoritativeness | Trustworthiness",
  "severity": "high | medium | low",
  "confidence": "high | medium | low",
  "issue": "one sentence on what is inaccurate or outdated (or a 'worth verifying' note when confidence is low)",
  "current_fact": "what current reliable sources actually say; empty string if unverified",
  "recommendation": "the correction",
  "suggested_source": { "title": "source title", "url": "https://..." } or null
}

Return up to 10 findings. If no concrete factual claim needs correcting, return [].${SEVERITY_RUBRIC}`;

// Pull the main article text out of a page. Modern blogs and SPAs wrap the body
// in many nested containers and surround it with "recent posts", "related", and
// other link-heavy widgets, so naively taking <main>/<article>/<body> often
// grabs a sidebar instead of the article - this is exactly what produced the
// 367-character "recent posts" reads on payit.ae. Instead we strip the obvious
// chrome, then score every plausible container by its NON-LINK text length and
// keep the densest one. Prose article bodies win; navigation and recent-post
// lists, which are almost entirely link text, score near zero.
function extractText(html, opts = {}) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();

  // (1) JSON-LD articleBody, captured BEFORE scripts are stripped. Most CMSes
  // (WordPress, etc.) embed the full clean article here, which is a reliable
  // source when the visible DOM is awkwardly structured.
  let jsonLdText = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of nodes) {
        const body = node && (node.articleBody || node.text);
        if (typeof body === 'string' && body.length > jsonLdText.length) jsonLdText = body;
      }
    } catch { /* ignore malformed JSON-LD */ }
  });
  jsonLdText = jsonLdText.replace(/\s+/g, ' ').trim();

  // (2) Visible body text with ONLY scripts/styles removed - captured before any
  // chrome pruning so it can serve as a guaranteed floor. This is what prevents
  // a 0-length result on a page that clearly has text.
  $('script, style, noscript, svg, template').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  // (3) Smart scored extraction: prune chrome, drop link-heavy widgets, then keep
  // the densest low-link container. This is what cleanly isolates the article on
  // normal pages (and ignores "recent posts" style sidebars).
  $('nav, footer, header, aside, form, iframe, button, label, select').remove();
  const JUNK = /(^|[\s_-])(nav|menu|sidebar|side-bar|widget|related|recent|latest|popular|trending|from-the-blog|more-from|up-next|share|sharing|social|comment|breadcrumb|pagination|paging|subscribe|newsletter|signup|promo|advert|banner|cookie|consent|gdpr|modal|popup|overlay|toc|table-of-contents|author-(?:box|bio)|read-more|more-posts|recommended|skip-link)([\s_-]|$)/i;
  $('[class],[id]').each((_, el) => {
    const sig = (($(el).attr('class') || '') + ' ' + ($(el).attr('id') || ''));
    if (JUNK.test(sig)) $(el).remove();
  });

  let best = null;
  let bestScore = 0;
  $('article, main, [role="main"], section, div').each((_, el) => {
    const node = $(el);
    const total = node.text().replace(/\s+/g, ' ').trim().length;
    if (total < 200) return;
    let linkLen = 0;
    node.find('a').each((_, a) => { linkLen += ($(a).text() || '').length; });
    const score = total - linkLen;
    if (score > bestScore) { bestScore = score; best = node; }
  });
  const scored = best ? best.text().replace(/\s+/g, ' ').trim() : '';

  // Prefer the clean scored article; fall back to JSON-LD, then to the raw body
  // floor. We only ever return empty if the page genuinely has no static text
  // (e.g. a JavaScript-rendered shell), which the caller reports honestly.
  let text = scored;
  if (text.length < 200 && jsonLdText.length > text.length) text = jsonLdText;
  if (text.length < 200 && bodyText.length > text.length) text = bodyText;

  const result = { title, text: text.slice(0, MAX_TEXT_CHARS) };
  if (opts.debug) {
    result.sources = { scoredLen: scored.length, jsonLdLen: jsonLdText.length, bodyLen: bodyText.length, chosen: text === scored ? 'scored' : text === jsonLdText ? 'jsonld' : text === bodyText ? 'body' : 'none' };
  }
  return result;
}

function parseClaims(raw) {
  if (!raw) return [];
  let cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  else if (start !== -1) cleaned = cleaned.slice(start); // array likely truncated (no closing ])
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Recover from a truncated or slightly malformed array by extracting every
    // complete top-level {...} object (string- and escape-aware).
    return recoverObjects(cleaned);
  }
}

function recoverObjects(s) {
  const objs = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { objs.push(JSON.parse(s.slice(objStart, i + 1))); } catch {}
        objStart = -1;
      }
    }
  }
  return objs;
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
  let sys = system || SYSTEM_PROMPT;
  // When web search is off, the model has no tool to find a real citation. Make
  // it explicit that it must leave suggested_source null rather than guess, so a
  // no-search pass can never fabricate a source. Detection is unaffected: the
  // prompt judges substantiation from the page text, not from search.
  if (!useWebSearch) {
    sys += '\n\nIMPORTANT: Web search is unavailable for this audit. Set "suggested_source" to null for every item. Never invent, guess, or fabricate a source title or URL. Flag claims exactly as instructed above; only the suggested_source field is affected.';
  }
  const request = {
    model: MODEL,
    max_tokens: parseInt(process.env.CLAIMS_MAX_TOKENS || '8000', 10),
    system: sys,
    messages: [{ role: 'user', content: userContent }]
  };
  if (useWebSearch) {
    request.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: parseInt(process.env.WEB_SEARCH_MAX_USES || '5', 10) }];
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

async function auditPage(url, { apiKey, findSources = true, factCheck = false, debug = false } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    if (fetched.notHtml) return { url, error: 'Not an HTML page, skipped.', claims: [] };
    if (fetched.blocked) {
      const code = (fetched.status && fetched.status >= 400) ? ` (HTTP ${fetched.status})` : '';
      return { url, error: `Blocked by the site${code}. Use Paste text to audit this page.`, claims: [] };
    }
    return { url, error: fetched.error || 'Page could not be reached.', claims: [] };
  }

  const { title, text } = extractText(fetched.html);
  // Browserless removed: pages are fetched once, directly. Kept at 0 so the
  // cost-tracking plumbing (scan_costs.browserless_renders) stays valid.
  const browserless = 0;

  if (!text || text.length < 120) {
    const big = fetched.html && fetched.html.length > 5000;
    const msg = big
      ? 'The page loaded but its article text could not be read automatically (it may be rendered by JavaScript). Use Paste text to audit this page.'
      : 'Too little readable text to audit.';
    return { url, title, error: msg, claims: [], browserless };
  }

  // If the visible text we extracted is itself a bot-challenge interstitial, the
  // page was not really rendered. Report it as blocked instead of auditing the
  // challenge and falsely reporting "no issues". (Real article text never shows
  // these phrases as visible copy; challenge scripts are stripped on extraction.)
  if (/\b(verify(?:ing)? you are human|enable javascript and cookies|just a moment|checking your browser|needs to review the security of your connection|attention required|please verify you are (?:a )?human|complete the security check|press (?:and|&) hold)\b/i.test(text.slice(0, 1500))) {
    return { url, title, error: 'Blocked by the site (bot challenge). Use Paste text to audit this page.', claims: [], browserless };
  }

  const result = await runClaims(url, title, text, findSources, key, factCheck, debug);
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

// Run one audit pass (one prompt). Retries a substantial empty result a few
// times, since model output varies run to run. Returns { claims, raw }.
async function runPass(client, userContent, useSearch, system, usage, textLen) {
  const r = await callClaude(client, userContent, useSearch, system);
  addUsage(usage, r.usage);
  let claims = parseClaims(r.text);
  let raw = r.text;
  const maxRetries = parseInt(process.env.AUDIT_RETRY_EMPTY || '2', 10);
  let attempts = 0;
  while (claims.length === 0 && textLen > 1200 && attempts < maxRetries) {
    attempts += 1;
    const rr = await callClaude(client, userContent, useSearch, system);
    addUsage(usage, rr.usage);
    claims = parseClaims(rr.text);
    raw = rr.text;
  }
  return { claims, raw };
}

// Merge accuracy findings (inaccurate/outdated) with substantiation findings,
// de-duplicating by claim text and preferring the accuracy finding.
function mergeClaims(substantiation, accuracy) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  const accKeys = new Set((accuracy || []).map((c) => norm(c.claim)));
  const subOnly = (substantiation || [])
    .filter((c) => !accKeys.has(norm(c.claim)))
    .map((c) => ({ ...c, finding_type: c.finding_type || 'unsubstantiated' }));
  return [...(accuracy || []), ...subOnly].slice(0, 14);
}

// Shared core. Standard mode runs the substantiation pass. Fact-check mode runs
// the reliable substantiation pass AND a focused accuracy/recency pass, then
// merges, so fact-check always returns at least what standard would, plus any
// inaccurate or outdated findings on top.
async function runClaims(url, title, text, findSources, apiKey, factCheck = false, debug = false) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set.');

  const client = makeClient(key, { maxRetries: 3, timeout: 120000 });
  const userContent = `Page URL: ${url}\nPage title: ${title}\n\nPage text:\n"""\n${text}\n"""`;
  const usage = { ...ZERO_USAGE };
  const dbg = debug ? { textLen: text.length } : null;

  try {
    if (!factCheck) {
      const p = await runPass(client, userContent, findSources, SYSTEM_PROMPT, usage, text.length);
      if (dbg) dbg.substantiationRaw = (p.raw || '').slice(0, 1200);
      return { url, title, claims: p.claims, usage, debug: dbg };
    }

    // Fact-check: substantiation pass (reliable) + accuracy pass, merged.
    const sub = await runPass(client, userContent, findSources, SYSTEM_PROMPT, usage, text.length);
    let accuracy = [];
    let accuracyRaw = '';
    try {
      const r = await callClaude(client, userContent, true, ACCURACY_PROMPT);
      addUsage(usage, r.usage);
      accuracy = parseClaims(r.text);
      accuracyRaw = r.text || '';
    } catch (e) {
      accuracyRaw = 'ACCURACY PASS ERROR: ' + (e.message || e);
    }
    if (dbg) {
      dbg.substantiationRaw = (sub.raw || '').slice(0, 1200);
      dbg.accuracyRaw = accuracyRaw.slice(0, 1200);
      dbg.subCount = sub.claims.length;
      dbg.accCount = accuracy.length;
    }
    return { url, title, claims: mergeClaims(sub.claims, accuracy), usage, debug: dbg };
  } catch (err) {
    // Last resort: substantiation only, no search.
    try {
      const p = await runPass(client, userContent, false, SYSTEM_PROMPT, usage, text.length);
      if (dbg) { dbg.substantiationRaw = (p.raw || '').slice(0, 1200); dbg.fallback = true; }
      return { url, title, claims: p.claims, usage, debug: dbg };
    } catch (err2) {
      return { url, title, error: `Audit failed: ${describeError(err2)}`, claims: [], usage, debug: dbg };
    }
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
    browserless: false,
    rawHttps: raw,
    sdk
  };
}

module.exports = { auditPage, auditText, extractText, parseClaims, diagnose };
