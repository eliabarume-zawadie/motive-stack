# Business Brain website analysis, live-AI ceiling and the one-request test

## What it does
The owner gives a public website address. The server reads the homepage and up to 7 more same-site pages: it follows the links on every page it reads (menus, "our services" pages and the pages for each service), and tries the usual names (/about, /services, /contact) for pages the homepage does not link to. It also reads the structured data a site declares about itself (name, kind of business, address, service area, services), turns the readable text into **proposed** findings with evidence, and the owner approves, edits or rejects each one. Approved findings are copied into the Business Brain **form**; nothing is saved until the owner presses Save. Findings never edit the Business Brain themselves.

Each finding says how it is supported: `found_on_site` (quotes are checked in code against the page text; a quote that is not on the page is dropped and the finding is demoted), `ai_interpretation` (a conclusion, not a fact) or `needs_confirmation` (not found / unknown). Claims (guarantees, credentials, numbers, superlatives) are flagged. Approved claims go to `unverifiedClaims`, never to approved differentiators; imported fact records are never approved for ads.

## Security controls (src/web/*)
- Only `http`/`https`, standard ports, no credentials, no IP literals (every numeric spelling), no `localhost`/internal suffixes.
- Name resolution is validated **at connection time inside the socket lookup**, for every address returned, and the connection goes to the validated address (no second resolution, so DNS rebinding cannot swap it). Blocked: loopback, private, link-local (incl. 169.254.169.254), CGNAT, multicast, reserved/documentation ranges, and IPv6 forms wrapping an IPv4 address (mapped, NAT64, 6to4, Teredo).
- Redirects are followed by hand: max 3, re-validated each hop, never https to http, never to another site.
- Limits: 600 KB per response (declared and streamed), 8 s per request, 45 s per analysis, 8,000 characters per page, 40,000 total, 8 pages (configurable up to 10). No compression requested or accepted, no cookies, no JavaScript executed, no files downloaded (HTML only).
- robots.txt is respected (RFC 9309 matching); a server error or unreachable robots.txt means nothing is read. `noai` / `none` page directives are honoured. Login walls, CAPTCHAs and bot challenges stop the analysis; nothing tries to get around them.
- Page text is untrusted data: neutralised angle brackets, delimited blocks, a system prompt that forbids following it, strict structured output validated by schema, no tools, wording aimed at AI tools is flagged to the owner. Raw HTML is never sent to a model.
- Same site is not read again within 24 h unless "Analyze again" is used (at least 1 minute apart); 10 analyses per workspace per day.

## Limitations
- Mock mode does not call an AI model: the built-in mock provider supports only the campaign task, so a deterministic extractor lists only text literally on the pages (labelled SIMULATED). Interpretations (target customers, tone, opportunities) need a real model.
- JavaScript-only sites yield no readable text (reported to the owner). Same-site links are followed one level deep from the homepage only.
- Not verified against a live public website or a live AI provider in this batch.

## Live OpenAI on localhost
Mock stays the default. Live needs `AI_PROVIDER_MODE=live`, `ALLOW_LIVE_PROVIDER_CALLS=true`, a server-side `OPENAI_API_KEY` and **`AI_LIVE_BUDGET_MICROS`** (see `.env.example`). Requests ask OpenAI not to store the response (`store:false` unless `OPENAI_STORE` says otherwise; this is not a zero-retention guarantee). Settings > Developer mode shows whether a key is present (yes/no only), the ceiling, spend and a one-request test.

## Live AI: spending, reservations and destination (pre-smoke-test review)
- **Reservation before every paid request.** The check and the reservation are one write transaction on the database, so concurrent requests (or another process on the same database) cannot together exceed the monthly ceiling (\`AI_LIVE_BUDGET_MICROS\`) or the daily cap (\`AI_LIVE_MAX_REQUESTS_PER_DAY\`). A request reserves the worst case of EVERY attempt it may make: 1 first try + \`AI_MAX_RETRIES\` (default 2, capped at 5) + \`AI_REPAIR_ATTEMPTS\` (default 1), i.e. 4 by default, for text and structured calls alike (empty text is repaired too). A test drives the gateway to its maximum and asserts the provider is called exactly that many times.
- **Settling.** A reservation is released when its own request ends (it can only touch its own row). If an attempt was sent but ended in a timeout or cancellation, the provider may have billed it with no usage reported: that attempt's worst case stays as an *unverified hold* for the rest of the month. A reservation left by a crash is never expired by age; it keeps counting until the month changes (it is one request's worst case).
- **Unknown usage is never zero.** Missing token counts are stored as NULL / \`unknown_no_usage\`; a completed live request with no token count pauses further live requests.
- **Destination.** In live mode \`OPENAI_BASE_URL\` / \`ANTHROPIC_BASE_URL\` must be the official host (\`https://api.openai.com\`, \`https://api.anthropic.com\`) or empty. Any other address stops startup unless \`ALLOW_CUSTOM_PROVIDER_BASE_URL=true\` (development only: https, or http on this machine, no credentials in the address); startup and the status text then warn that the key goes there. Errors name the setting, never its value. In mock and local modes the addresses are ignored.
- **Key hygiene.** A blank or placeholder key (\`your-key-here\`) counts as no key. A present key is not proof it works.
- **Replacing earlier website text.** The server records which values a fill actually ADDED to the form (only values it offered itself). A later analysis, of any website, removes exactly those values that the new analysis does not support; the owner's own text (including text identical to nothing the fill added) is untouched. The form is not saved until the owner presses Save.

## Where each saved Business Brain item came from (provenance)

`GET /api/workspaces/:wid/brain/provenance` (permission `brain.read`) labels every saved item as **website** (with the site), **owner** (typed by the person, including everything the no-website questionnaire wrote), **demo** (the fictional demo business) or **default** (the unchanged default tone). The Business Brain section shows this under the form after every save.

- Only the server's fill ledger can make an item "website". The ledger holds values a website analysis offered and the form took (`POST .../website-analyses/:aid/applied`).
- The ledger is **reconciled on every Brain save**: an entry whose value is not in the saved Brain is deleted. Text the owner reworded or removed stops counting as the website's, and a browser cannot leave phantom "website" entries behind.
- **Trust limit:** the server cannot observe what actually reached the form. It trusts the browser's report, but only for values the server itself offered (anything else is ignored), and the reconciliation above means a false report cannot survive a save. The label is a review aid, not a security boundary: ads still only use approved claims.
- Records (`facts`) kept as evidence show whether each is approved for ads. Website-derived statements are never approved automatically.
