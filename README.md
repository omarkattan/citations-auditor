# Claims Auditor

Crawl a site, flag claims that assert something without backing it up, map each
to the Google E-E-A-T pillar it weakens, and return the fix plus a real citation
to use. A Sandstorm Digital production.

## How it works

1. Discover pages from one of five sources (see below).
2. For each page, extract the readable text.
3. Send it to Claude with web search on. Claude flags unsubstantiated claims,
   tags each with its E-E-A-T pillar and severity, recommends the evidence
   needed, and finds a credible third-party source where one exists.
4. Results stream back to the browser page by page (no long hang on Render).
5. Each scan is logged to a Google Sheet.

## Discovery sources

- Crawl from homepage - follows internal links. No extra setup.
- Specific folder - crawls but only audits pages under a path (e.g. /blog).
- XML sitemap - reads /sitemap.xml and sitemap index files. No extra setup.
- Search Console - pulls top pages by clicks. Needs the service account added
  to the property in GSC (Settings > Users and permissions).
- Ahrefs - pulls top pages by traffic. Needs AHREFS_API_KEY.

## Environment variables (Render)

Required:
- ANTHROPIC_API_KEY - the engine. Without it, scans fail.

Optional (logging + admin, same pattern as the agentic tester):
- GOOGLE_SHEET_ID - the target sheet. Give it a tab named "Scans".
- GOOGLE_SERVICE_ACCOUNT - the full service account JSON, as one value.
- ADMIN_KEY - defaults to sandstorm2026.

Optional (extra sources):
- AHREFS_API_KEY - enables the Ahrefs source.
- GSC_SITE_URL - overrides the property URL for Search Console (defaults to the
  origin of the URL being scanned, with a trailing slash).

Optional (tuning):
- CLAIMS_MODEL - defaults to claude-sonnet-4-6.

## Deploy

1. Create a new GitHub repo under omarkattan/ and upload these files
   (drag the whole folder into GitHub web - it keeps the structure).
2. On Render, create a Web Service from the repo.
   - Build command: npm install
   - Start command: npm start
3. Add the environment variables above.
4. Point cron-job.org at https://YOUR-APP.onrender.com/healthz every 14 minutes
   to dodge free-tier cold starts.

## Admin

Scan log lives at /admin/scans?key=sandstorm2026 (or your ADMIN_KEY).

## Notes

- Page count is capped at 25 per scan to protect the free tier.
- Sequential auditing keeps memory and API cost predictable. A 15-page scan with
  web search on can take a couple of minutes; the live log shows progress.
- If web search is not enabled on the API account, the engine falls back to
  recommendation-only so scans still complete.
