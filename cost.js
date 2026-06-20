// cost.js
// Estimates the variable cost of a scan from measured usage. Token counts and
// web-search counts come straight from the Anthropic API, so the Claude figure
// is accurate. Browserless is billed per MB of residential traffic, which the
// REST response does not return, so its cost is a per-render estimate you can
// tune with BROWSERLESS_COST_PER_RENDER.

const RATES = {
  // Claude Sonnet 4.6 list prices, USD per million tokens.
  inputPerMTok: parseFloat(process.env.CLAUDE_INPUT_PER_MTOK || '3'),
  outputPerMTok: parseFloat(process.env.CLAUDE_OUTPUT_PER_MTOK || '15'),
  // Web search, USD per request.
  perSearch: parseFloat(process.env.WEB_SEARCH_PER_CALL || '0.01'),
  // Rough USD per Browserless residential unblock. Tune to your real usage.
  perBrowserless: parseFloat(process.env.BROWSERLESS_COST_PER_RENDER || '0.03')
};

function computeCost({ inputTokens = 0, outputTokens = 0, webSearches = 0, browserlessRenders = 0 } = {}) {
  const claude = (inputTokens / 1e6) * RATES.inputPerMTok + (outputTokens / 1e6) * RATES.outputPerMTok;
  const search = webSearches * RATES.perSearch;
  const browserless = browserlessRenders * RATES.perBrowserless;
  return {
    claude: round(claude),
    search: round(search),
    browserless: round(browserless),
    total: round(claude + search + browserless)
  };
}

function round(n) { return Math.round(n * 1e6) / 1e6; }

module.exports = { RATES, computeCost };
