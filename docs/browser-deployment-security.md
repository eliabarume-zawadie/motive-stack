# Browser and deployment security (M4.4c, Package 2)

Status: implemented and tested offline (through the server's own test interface). No part of it was exercised against a real browser, a real proxy, or a real identity provider. The decisions that remain open are listed at the end.

## 1. The actual trust boundaries (from the code, not assumed)

- **Listener.** `src/server/main.ts` binds `127.0.0.1` only, over plain HTTP. There is no TLS in this process. Anything that makes it reachable from elsewhere (a reverse proxy, a tunnel) is a deployment decision outside the code.
- **Authentication.** `Authorization: Bearer` only, set by the page's JavaScript. **No cookie is ever set or read**, so classic cross-site request forgery does not apply today. What does apply: (a) a web page that can reach the loopback address (DNS rebinding) can call the public routes (`POST /api/workspaces`, `GET /api/config`, `GET /api/health`) and the static files; (b) cross-origin scripts can send requests that carry no token and are refused by authentication, but could be abused against public routes.
- **Browser.** The bundled UI (`public/`) has **no person sign-in**; its only credential is the per-workspace token (see section 5). It renders with `textContent` only, puts nothing in a URL, and loads one module script and one stylesheet from its own origin.
- **Proxy trust.** Fastify's `trustProxy` is off. Nothing reads `X-Forwarded-*` or `Forwarded`. This is deliberate: those headers are client-controlled unless a proxy overwrites them, and no policy here depends on them.
- **CORS.** None. No `Access-Control-*` header is ever sent, so browsers refuse cross-origin reads and preflights.

## 2. Security headers (every response)

Added in one `onSend` hook (`src/server/security.ts`), so they cover static files, API answers, 404s and every refusal or error, including the 403s from the checks below and 429s. A route that sets one of these itself keeps its value.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` | The UI needs exactly: its own module script and stylesheet, its own self-hosted fonts (`public/fonts/`), and fetches to its own origin. Everything else is denied. No `unsafe-inline`, no `unsafe-eval`, no wildcards, no other origins. `frame-ancestors 'none'` is the single framing policy (no separate `X-Frame-Options`). Tests read `public/` and fail if the UI ever needs an inline script/style, an event-handler attribute, or a third-party URL. |
| `X-Content-Type-Options` | `nosniff` | Stops content-type guessing of API JSON or uploaded text. |
| `Referrer-Policy` | `no-referrer` | Nothing in the UI needs the referrer, and addresses should not leak. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the UI's browsing context from windows opened by other sites. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites cannot embed this origin's responses. |
| `Strict-Transport-Security` | `max-age=<HSTS_MAX_AGE_SEC>` | **Only** when the operator has asserted TLS (see below). Never emitted for loopback, never because a forwarded header said so. |

**HSTS rule.** This process cannot see TLS, and browsers ignore HSTS sent over plain HTTP, so emitting it blindly would only be noise (and a trap if misconfigured). It is sent only when all hold: `HSTS_MAX_AGE_SEC` is above 0, `PUBLIC_ORIGINS` contains an `https://` origin (startup fails otherwise), and the request's own `Host` is that origin's host. Start with a small value; a long `max-age` cannot be taken back from browsers that have seen it. `includeSubDomains` and `preload` are deliberately not offered.

## 3. Host and Origin validation

Both run **before authentication**, in this order, and both answer with fixed JSON that never repeats anything from the request:

```
403 {"error":{"code":"host_not_allowed","message":"This host is not allowed"}}
403 {"error":{"code":"origin_not_allowed","message":"This origin is not allowed"}}
```

**Host (every request, including static files).** The `Host` header must be a plain `host[:port]` (no userinfo, path, spaces, trailing dot or port above 65535) naming either
- a loopback name, on any port: `localhost`, `127.0.0.1`, `[::1]` (this is what stops DNS rebinding, because a rebound request carries the attacker's name), or
- the host of a configured public origin (`PUBLIC_ORIGINS`), with its port (the scheme's default port may be written or omitted).
Anything else, including look-alikes (`localhost.evil.example`), `0.0.0.0`, other `127.x` addresses and bare internal IPs, is refused.

**Origin (POST, PUT, PATCH, DELETE only, including the public `POST /api/workspaces`).**
- No `Origin` header: allowed (curl, server-to-server clients, tests). Authentication still decides. A request whose `Sec-Fetch-Site` is present and is anything but `same-origin` or `none` is refused even with no `Origin`.
- `Origin` present: it must be canonical (it must round-trip exactly, so `null`, trailing slashes, paths, userinfo and upper case all fail) and either (a) exactly one of the configured public origins, or (b) a loopback origin that is `http`, on the **same loopback name and port as the request's Host**. A different local program (another port) or another name for the same machine is a different origin.
- A public origin is accepted with any *allowed* Host. This is intentional: a proxy that rewrites `Host` to the upstream address (the usual default) still works, while an unlisted Host is refused regardless of the Origin.
- Reads (GET/HEAD/OPTIONS) are not Origin-checked: they change nothing and there is no CORS, so a cross-origin page cannot read the answer.

**Origin is never authentication.** The checks only add refusals; a request that passes them still needs a valid credential and permission. Tests confirm a valid token does not rescue a bad Host or Origin, and a good Origin does not rescue a missing token.

### TLS termination and proxies
- Terminate TLS in a proxy in front of this process and have it forward to `127.0.0.1:<port>`. Set `PUBLIC_ORIGINS` to the exact public origin(s). Without it, only loopback hosts are accepted.
- The proxy must **overwrite or strip** client-supplied `X-Forwarded-*` / `Forwarded` headers; this server ignores them either way, so it does not matter for these checks, but other tooling may rely on them.
- **Health checks and monitoring** must send an allowed `Host` (a loopback name or a public origin's host). A probe that uses an internal IP as its Host will get 403. This is a deliberate fail-closed default; whether to add an allow-listed probe host is a deployment decision (see section 7).
- HTTP must not be offered publicly: the proxy should redirect or refuse it. `PUBLIC_ORIGINS` accepts `https` for any name; plain `http` only for loopback.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_ORIGINS` | empty (loopback only) | Comma-separated exact origins, e.g. `https://app.example.com`. No wildcards, paths, queries, credentials or trailing slashes; non-loopback entries must be `https`; at most 20. |
| `HSTS_MAX_AGE_SEC` | `0` (never sent) | 0 to 63072000. Requires an `https` entry in `PUBLIC_ORIGINS`. |
| `API_RL_MAX` | `1200` | Requests per person per window across the whole API (10 to 100000). |
| `API_RL_WINDOW_SEC` | `60` | The window (1 to 3600). |

Invalid values stop startup and the message names the variable, never the value. Startup prints which boundary is active (counts only).

## 5. Browser token storage: assessed, deliberately NOT changed

**How it works today.**
1. `POST /api/workspaces` (public in workspace-token mode) returns the workspace's token **once**. The UI appends `{id, name, token}` to a list and writes the list to `localStorage` (`ms_sessions`, `ms_current`).
2. Every API call reads the token from that list and sends it as `Authorization: Bearer`. Nothing puts it in a URL, a log, or the page.
3. A reload reads the list back, so the user stays signed in. There is no logout and no sign-in form; the token cannot be shown again.
4. In OIDC mode there is no UI at all: `app.js` states that person sign-in is not implemented, and no identity provider is chosen.

**Why memory-only tokens are blocked now.** The token is displayed to no one: the UI stores it and never shows it, and the server cannot show it again. If it were kept only in memory, **a page reload would permanently lock the user out of their workspace** (the only recovery is editing the database). Making memory-only usable needs a new interaction (show the token once with a copy step, and a "paste your token to open a workspace" form) or a real sign-in flow. Both are product decisions and new UI, and the second needs the identity provider. I did not invent either, and did not weaken anything.

**Options for your decision.**
| Option | User-visible consequence | Risk reduced | Needs |
|---|---|---|---|
| A. Keep `localStorage` (today) + the new CSP | None | The CSP removes the usual way a token is stolen from `localStorage` (injected script); no inline code can run | Nothing |
| B. `sessionStorage` | Survives reload, lost when the tab closes: same lock-out problem for a token that was never copied | Slightly less exposure over time | The same copy/paste UX as C to be safe |
| C. Memory-only + "show once, then paste to open" | Token must be copied and pasted after every reload or new tab | Nothing persists in the browser | New UI and a product decision |
| D. OIDC sign-in with PKCE and memory-only access tokens | Sign in again after a reload (silent re-auth depends on the provider) | Best; no long-lived secret in the browser | Identity provider chosen; refresh/session design; CSRF design if cookies are ever used |

Recommendation: A now (this package), then D once the provider is chosen; C only if workspace tokens must stay in use for long. Cookies were not considered without a separate session and CSRF design.

## 6. General API rate limit

**Implemented.** One counter per verified person across the whole API (`api|<person>`): a signed-in user, or the legacy workspace token (counted per workspace token). It runs **after authentication** (`req.principal`), so:
- an unauthenticated caller, a forged or wrong-audience token, an unlisted identity, a public route or a static file never creates an entry, and cannot spend anyone's quota (tests send hundreds of such requests and show the table does not grow and the victim's quota is intact);
- a person's volume across workspaces and routes counts together; another person is unaffected;
- over the limit: `429 {"error":{"code":"rate_limited","message":"Too many requests; try again later"}}` with `Retry-After` (the same fixed wording as the credential and claim limits, saying nothing about which limit applied).

**Bounded memory.** It is the existing `RateLimiter`: expired entries first, then the oldest entries without an active lockout, and a hard cap of twice the soft cap. Entries are only created for verified identities, so the table is bounded by real users, and a test with many distinct people stays under the cap.

**The default.** 1200 per minute per person. The bundled UI polls four endpoints every 1.5 s per visible tab (about 160 requests a minute), so 1200 allows several tabs while bounding scripted abuse to about 20 requests per second. Lower it only after measuring real use. All people who share one legacy workspace token share one counter.

**Interaction.** The credential-write, claim and denied-audit limits are separate counters and unchanged. A request counts against the general limit first; if that refuses it, no credential or claim counter is spent. A request the general limit admits is then judged by the specific limit as before (tests show both orders).

**Limits of this design, stated plainly.**
- **Per process.** Counters live in memory. With several instances each counts separately (the effective limit is multiplied by the number of instances) and counters reset on restart. **There is no multi-instance protection.** Sharing state (a database table or an external store) is a deployment decision and is not implemented.
- **Nothing before authentication.** Volume from unauthenticated callers (floods, token guessing) is not limited here. Per-IP limiting needs the true client address, which requires a trusted proxy and a decided header contract; until then it belongs to the proxy in front of this process. Doing it in-process with `trustProxy` off would put every user behind the proxy's address into one bucket.
- It does not stop a single authorized person doing damage within their allowance; roles and approval-first execution do that.

## 7. Deployment assumptions and decisions still needed

- A TLS-terminating proxy exists in front of any public use, forwarding to the loopback listener. Not provided here.
- Whether health probes get an allow-listed Host (currently they must use an allowed one).
- Browser session model (section 5): A now, D later, or C.
- Whether to add per-IP limiting at the proxy, and shared-state limiting for multi-instance deployments.
- The HSTS value, once TLS is real (start small).
- Not covered: a real browser, a real proxy, real provider behavior, WebSocket or server-sent events (none exist), and cookie-based sessions (none exist, so no CSRF token mechanism was built).
