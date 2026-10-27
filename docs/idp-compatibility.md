# Identity-provider compatibility (M4.4c, Package 4)

**Status: offline preparation only.** No identity provider has been selected or contacted (Auth0 is the leading candidate and self-hosted Keycloak the fallback, both subject to the staging checks). Everything below that is tested is tested against **SIMULATED** token and key-set shapes (`test/support/simulatedIdp.ts`) that were invented to exercise differences between providers. A passing test means *this server's verifier handles that shape*. It does not verify any real provider, and **compatibility with a real provider is not verified against any real provider** until the staging plan in section 6 has been run and its evidence recorded.

The executable contract is `test/idpContract.test.ts`. Its tests are titled with the clause ids below (C1 to C18), and a final test fails if this table and the suite drift apart.

## 1. The contract (what a provider must satisfy for this server)

Status words: **ENFORCED** (the server enforces it and a test proves it), **REFERENCE** (a pinned reference for client code that does not exist yet), **LIMITATION** (a known gap, pinned by a test so changing it is deliberate), **STAGING** (cannot be tested offline).

| ID | Requirement | Status | Where | Notes |
|---|---|---|---|---|
| C1 | Browser sign-in uses Authorization Code with PKCE, challenge method **S256** (never `plain`, never implicit). The API itself holds **no** PKCE logic: it is a resource server that verifies bearer tokens | REFERENCE (S256 vector) + STAGING (the flow) | future browser client | The RFC 7636 appendix B vector is pinned in the suite for the client to match. A test asserts the server code contains no code-exchange logic. |
| C2 | The token's `iss` equals `OIDC_ISSUER` **byte for byte** (scheme, case, port, trailing slash) | ENFORCED | `src/auth/oidc.ts` | A provider whose `iss` has a trailing slash needs the slash in `OIDC_ISSUER`, and vice versa. No normalization, on purpose. |
| C3 | `aud` is a string or an **array of strings** and includes `OIDC_AUDIENCE` exactly | ENFORCED (gap closed here) | `oidc.ts` | An array mixing in non-strings used to be filtered silently, which could hide a second audience from the multi-audience rule. It is now refused as malformed. |
| C4 | Client id / `azp`: a token with several audiences must carry `azp` equal to `OIDC_CLIENT_ID` (refused if none configured); with a client id configured, any `azp` present must equal it; `OIDC_REQUIRE_AZP=true` demands it on every token | ENFORCED | `oidc.ts`, `config.ts` | The audience and the client id are different things; a token for another audience is refused even from the right client. See the outcome table in section 3. |
| C5 | `sub` is a non-empty string of at most 255 characters, compared and stored **exactly** (no trimming, case folding or normalization) | ENFORCED | `oidc.ts`, `app/users.ts` | Users are keyed by (issuer, subject). Providers that issue **pairwise** subjects (a different `sub` per client app) need allow-list entries for *this* client's value. |
| C6 | `exp` required; `nbf` and `iat` optional; all numbers (not numeric strings); 60 s clock leeway; the token's own duration (`exp - iat`) must not exceed `OIDC_MAX_TOKEN_LIFETIME_SEC` with **no leeway on that duration**, and its remaining life (`exp - now`) may exceed it only by the clock leeway | ENFORCED | `oidc.ts`, `config.ts` | The ceiling is 900 s, fixed in code. Worst case a token is usable for 900 s plus the 60 s leeway past `exp`. Fractions are accepted; a provider that omits `iat` is fine if the remaining life is within the limit. |
| C7 | Signing algorithms are RS256 (RSA at least 2048 bits) or ES256 (P-256) only, and the algorithm is checked before any key is looked up. A key may omit `use`/`alg` and carry extra standard fields; one with `use` other than `sig`, `key_ops` without `verify`, a private part, a mismatching `alg`, or the wrong key type is refused | ENFORCED (gap closed here) | `oidc.ts` | `key_ops` was previously ignored; a key declared for another operation could verify. |
| C8 | Key rotation: a new `kid` is picked up (bounded by the 60 s cooldown); overlap works; a removed key stops verifying once the cache refreshes (at most the 10-minute cache lifetime later); a reused `kid` with new material takes effect on refresh; **two different entries under one `kid` in one set make that id unusable** | ENFORCED (gap closed here) | `src/auth/jwks.ts` | Conflicting duplicates used to resolve silently to the last entry. A set with no usable key at all is a failed fetch. |
| C9 | An unknown `kid` is a plain refusal (401), cannot trigger fetches faster than the cooldown, and absurd or missing ids are malformed | ENFORCED | `jwks.ts`, `oidc.ts`, `server/auth.ts` | Never a 503 and never a reason in the body. |
| C10 | Outages: cached keys keep verifying only up to `OIDC_JWKS_MAX_AGE_SEC` after the last **successful** fetch; past it sign-in answers **503** `auth_unavailable`; failed fetches never renew the age; recovery is automatic on the next good fetch | ENFORCED | `jwks.ts`, `server/auth.ts` | Tested end to end through the HTTP boundary with an injected clock. |
| C11 | A verified email is **informational metadata only**: kept only when `email_verified === true` (a boolean; the string "true" does not count) and at most 320 characters; never an identity or an allow-list key | ENFORCED | `oidc.ts`, `app/users.ts` | One email under two subjects is two people; a changed email is the same person. |
| C12 | Allow-lists are exact subjects of the configured issuer: no emails, wildcards, case folding or padding; the claim list must be a subset of the allowed list | ENFORCED | `config.ts` | An identity from another issuer never matches. |
| C13 | Role-, scope-, group- or admin-looking claims in a token never grant anything: roles come only from workspace membership in the database | ENFORCED | `server/auth.ts` | A viewer's token claiming `role: owner` still cannot reach owner-only credential routes; a non-member is 404. |
| C14 | Bearer tokens up to 8192 characters work end to end; longer ones are refused at both the header parser and the verifier | ENFORCED | `server/auth.ts`, `oidc.ts` | Large group claims can exceed this; see the checklist. |
| C15 | **Only an explicitly supported JWT access-token format is accepted, and an ID token is never an API credential.** The header `typ` must be `at+jwt` (RFC 9068; `application/at+jwt` and any letter case are equivalent) unless the operator names others in `OIDC_ACCESS_TOKEN_TYPES`; a bearer carrying `nonce`, `at_hash` or `c_hash` is refused; a bearer naming the client id as an audience is refused; opaque tokens cannot be verified (no introspection, by decision) | ENFORCED | `oidc.ts`, `config.ts` | Fail-closed: a provider that does not emit `at+jwt` is refused until its real format is verified (S6) and named. Limits and provider-dependent questions: section 9. |
| C16 | Tokens are **stateless**: the same token works repeatedly until `exp` (no `jti` memory); there is no server-side revocation, session or logout. Removing a membership is immediate; disabling the person at the provider is not | LIMITATION | `oidc.ts`, `server/*` | Mitigated only by short lifetimes (`OIDC_MAX_TOKEN_LIFETIME_SEC`: required, at most 900 s). |
| C17 | Redirect URI matching, CORS on the token endpoint, denied consent, replayed authorization codes, wrong `state` or PKCE verifier, logout at the provider, user disablement | STAGING | the provider and the browser client | Only observable against a real provider; see section 6. |
| C18 | The deployment states its client id and its access-token lifetime explicitly (no defaults); the lifetime is 60 to 900 s; an audience equal to the client id, an ID-token type in `OIDC_ACCESS_TOKEN_TYPES`, or an empty list is contradictory and stops startup without echoing values | ENFORCED | `config.ts` | Only non-secret values (mode, issuer, audience, client id) reach the browser through `/api/config`. |

## 2. The simulated profiles (all INVENTED)

`test/support/simulatedIdp.ts`. None is named after, or reproduces, a real provider.

| Profile | Stands for |
|---|---|
| `minimal` | only the required claims; no `azp`, no email |
| `azp-single` | one audience plus `azp` naming the calling client |
| `multi-audience` | an audience list (API plus another resource) with `azp` |
| `no-iat` | a provider that omits `iat` |
| `with-nbf` | a provider that sends `nbf` |
| `verified-email` | email with a boolean `email_verified` |
| `string-booleans` | `email_verified` sent as the string `"true"` |
| `authorization-looking-claims` | `scope`, `scp`, `groups`, `roles`, `role`, `is_admin`, a namespaced role: none of which may grant anything |

## 3. Outcome table: client id and `azp`

| Token shape | no client id | client id matches | different client id | client id + require azp |
|---|---|---|---|---|
| minimal (no azp) | accepted | accepted | accepted | refused |
| azp-single | accepted (azp not interpreted) | accepted | refused | accepted |
| multi-audience | **refused** | accepted | refused | accepted |

## 4. Is the current OIDC API sufficient for a browser PKCE flow?

**Already sufficient.** The server verifies bearer JWTs; `GET /api/me`, `GET /api/me/workspaces`, `POST /api/workspaces` (a person becomes owner) and `POST /api/workspaces/claim` already take a verified person; roles, closed-pilot allow-lists, Host/Origin checks, security headers and rate limits are in place; the API is same-origin, so **it needs no CORS**.

**Not sufficient yet (nothing below is implemented):**

1. **Provider endpoints in configuration.** There is no authorization endpoint, token endpoint, end-session endpoint, redirect URI, scope list or audience-parameter setting anywhere; `/api/config` publishes only issuer, audience and client id. They would be added to `AuthConfig`/`publicConfig` as non-secret values (a public client has no secret), validated at startup (https, no credentials, the redirect URI under a `PUBLIC_ORIGINS` origin). Static configuration is preferable to runtime discovery: fewer moving parts and no extra fetch.
2. **CSP.** `connect-src 'self'` would block the browser's code exchange. The token endpoint's origin (only that) would be added from configuration. `default-src 'none'` also blocks silent-renew iframes, and `Cross-Origin-Opener-Policy: same-origin` breaks popup flows, so the flow must be **full-page redirects**.
3. **A route for the redirect URI.** The static handler serves files only; `/callback` is a 404 today. Either serve the app shell at a fixed path or use `/` as the redirect URI. The callback response must not be cached.
4. **Transient PKCE state.** The code verifier and `state` must survive a full-page navigation, which memory cannot. That requires `sessionStorage` for these two values only, deleted at the callback. The current token-storage characterization test would change deliberately.
5. **Access token must be a verifiable JWT.** The server cannot verify opaque tokens (C15). If the chosen provider issues only opaque access tokens, the alternatives are (a) send the ID token as the bearer (set `OIDC_AUDIENCE` equal to the client id; this makes ID tokens acceptable as API credentials), or (b) add server-side introspection (a new outbound dependency). Both are design decisions; neither is built.
6. **Renewal.** Without refresh tokens the user is redirected again when the access token expires (or on reload). Rotating refresh tokens kept in memory are possible but are a separate decision (and the provider must support rotation and reuse detection).
7. **Claim size.** The 8192-character cap applies to every token; a user with many groups can exceed it (C14).
8. **Logout.** The server has no session (C16). The client clears its memory and may redirect to the provider's end-session endpoint; token validity after logout is whatever the remaining lifetime is.
9. **Allow-list operations.** `OIDC_ALLOWED_SUBJECTS` needs each person's `sub` **before** their first sign-in; the provider must let you learn it in advance. There is no "pending request" flow.

## 5. Provider-selection checklist

**Must have**
- [ ] Authorization Code flow with PKCE **S256** for public (browser) clients; no secret in the browser.
- [ ] **Exact** redirect URI matching (no wildcards, no open redirects).
- [ ] **JWT access tokens** (or an accepted alternative per section 4) with a configurable **custom audience**; `iss` stable and documented byte for byte.
- [ ] RS256 or ES256 signing; JWKS over https with `kid`; documented rotation with an **overlap** at least as long as the 10-minute cache plus the 60 s cooldown.
- [ ] A stable, opaque `sub` per person, **knowable before first sign-in** (for allow-lists); pairwise subjects understood.
- [ ] Access-token lifetime configurable to about 10 minutes (the server **requires** `OIDC_MAX_TOKEN_LIFETIME_SEC` and enforces at most 900 s).
- [ ] Access tokens carry the RFC 9068 header `typ: at+jwt`, or their exact format is documented and verified so it can be named in `OIDC_ACCESS_TOKEN_TYPES`.
- [ ] CORS on the token endpoint for our exact origin, and **not** for other origins.
- [ ] A staging tenant, separate from production, with the same configuration surface.
- [ ] A documented way to disable a person, and a documented statement of what happens to tokens already issued.
- [ ] MFA available for owners.

**Should have**
- [ ] Refresh-token rotation with reuse detection (if refresh tokens are used).
- [ ] An end-session endpoint; back-channel logout is a future option.
- [ ] `azp` on access tokens; boolean `email_verified`.
- [ ] No "groups overage" behavior that bloats tokens past 8 KB.
- [ ] Audit logs for sign-ins and administrative changes; data-residency and terms acceptable.

**Disqualifying**
- Implicit flow only; HS256-only signing; wildcard-only redirect URIs; no published JWKS; opaque-only access tokens with no JWT option (unless you approve option 5a or 5b above); per-client rotating `sub` with no way to read the value in advance.

## 6. Staging verification plan (to run against the chosen provider's STAGING tenant)

Record for each: date, tenant, who ran it, the **sanitized** evidence (never a full token or secret; redact signatures), and pass or fail. A failure blocks the pilot until resolved or accepted in writing.

| # | Check | Steps | Pass when |
|---|---|---|---|
| S1 | Redirect URI | Register the exact redirect URI. Try a variant (different path, scheme, trailing slash, another host) in the authorization request | The provider rejects every variant; no wildcard accepted; no redirect to an unregistered address |
| S2 | CORS | From our origin, preflight and call the token endpoint; repeat from a second origin | Our origin allowed with the exact origin echoed; the other origin refused |
| S3 | PKCE | Complete a normal sign-in; then try with a wrong `code_verifier`, a `plain` challenge, and no challenge | Normal works; the other three are rejected by the provider |
| S4 | `state` | Tamper with, drop and reuse `state` at the callback | The client refuses every case and does not exchange the code |
| S5 | Replayed code | Use an authorization code a second time at the token endpoint | The provider rejects it (and, if it advertises it, revokes the first grant's tokens) |
| S6 | Token claims | Capture a sanitized access token and ID token; compare to C2 to C6, C11, C14: exact `iss`, `aud` type and value, `azp`, `sub` format, `iat`/`exp`/`nbf` presence, `email_verified` type, size with a realistic user | Every clause holds, or the deviation is recorded and the configuration or this contract is changed deliberately |
| S7 | Audience | Request a token for another API or without our audience | The API refuses it (401); the provider's behavior is recorded |
| S8 | ID versus access token | Present the ID token as a bearer | Behavior recorded against C15; the API audience is distinct from the client id |
| S9 | Opaque tokens | Confirm access tokens are JWTs | If not, stop and decide section 4 item 5 |
| S10 | Key rotation | Trigger a signing-key rotation in staging | A new `kid` verifies within the cooldown; overlap duration recorded; the old key stops verifying after the cache refreshes |
| S11 | JWKS outage | Block egress to the JWKS URL | Cached keys work to `OIDC_JWKS_MAX_AGE_SEC`, then 503; unblocking recovers without a restart |
| S12 | Expired token | Use a token past `exp`; use a very short lifetime | 401 from the API; the client re-authenticates |
| S13 | Clock skew | Offset the server and a token by about 2 minutes either way | Behavior matches C6 (60 s leeway) |
| S14 | Denied access | Deny consent; sign in as an unassigned user; as a disabled user | The provider reports an error to the redirect URI and the client shows a fixed message; a valid but unlisted identity gets 403 from the API |
| S15 | Account disablement | Disable a person, keep an issued token | Record how long the API still accepts it (at most its lifetime); decide if that is acceptable |
| S16 | Logout | Use the end-session endpoint | Provider session ended; the client memory cleared; remaining token validity recorded (C16) |
| S17 | Subject stability | Sign in from two devices and after a password reset | The same `sub` each time; the allow-list entry keeps working |
| S18 | Pairwise subjects | Check whether `sub` differs per client application | If it does, allow-list values are taken from the production client |
| S19 | Token handling | Review browser history, storage, the network log and server logs for token or code leaks | Nothing leaks; the code and state are removed from the address after the callback |
| S20 | Rate limits and errors | Hit the provider's token endpoint repeatedly; read its error bodies | Limits and error shapes recorded; the client never shows provider text verbatim |

## 7. What this package changed in the server

Three small, tested corrections found by the contract suite (C3, C7, C8), all stricter and none affecting a provider that follows the specifications: arrays of audiences must contain only strings; a key whose `key_ops` excludes `verify` is not used; two different keys under one `kid` make that id unusable. Nothing else in the server changed, no dependency was added, and no browser sign-in was built.

## 8. Decisions still needed

The provider (section 5); the opaque-token alternative if the provider requires it (section 4.5); refresh-token use (4.6); the access-token lifetime to configure; whether pairwise subjects are acceptable; how owners learn `sub` values in advance; and who runs the staging plan and signs off the evidence.

## 9. Token-type and lifetime hardening (what changed, and what it cannot prove)

**The issue, confirmed before the change.** The verifier did not examine `typ` and did not relate the audience to the client id, so an ID-token-shaped bearer (header `typ: JWT`, `aud` listing the API and the client id, `azp`, `nonce`, `at_hash`, `email`) was accepted as an identity. Checking "`aud` is not the client id" alone would not have closed it: an ID token can list the API as a second audience.

**What is enforced now (all provider-neutral, all fail closed):**
1. **Format.** The header `typ` must be one of the explicitly accepted access-token types: `at+jwt` by default (RFC 9068), compared case-insensitively with the `application/` prefix equivalent, with no padding or parameters tolerated. Anything else, or no `typ`, is refused **before any key is looked up**.
2. **ID-token-only claims.** A signed token carrying `nonce`, `at_hash` or `c_hash` (defined by OpenID Connect Core for ID tokens) is refused whatever its header says.
3. **Client audience.** A token that names the browser client id as an audience is addressed to the client, not the API, and is refused.
4. **Startup.** `OIDC_CLIENT_ID` and `OIDC_MAX_TOKEN_LIFETIME_SEC` (60 to 900) are required; an audience equal to the client id, or an ID-token type in `OIDC_ACCESS_TOKEN_TYPES`, stops startup.
5. **Lifetime.** 900 s is a ceiling the verifier enforces itself. The token's own duration gets no leeway; only the remaining life against the server's clock does (so a skewed clock cannot reject a valid token, and a long-lived token cannot hide behind the leeway).
6. **Authorization is unchanged.** Roles come only from workspace membership; role-, scope- and group-looking claims grant nothing (C13). A rejected token reaches the user-provisioning code never: the verifier runs first, and tests show a rejected ID token neither creates nor modifies a user.

**What an ID token presented to the API gets:** `401 {"error":{"code":"unauthorized"...}}`, a generic body that says nothing about why, `WWW-Authenticate: Bearer error="invalid_token"`, no user row created or changed.

**What this does NOT prove, and why it stays fail-closed:**
- `typ` is read from an **unverified** header, so it can only ever *refuse* more; the signature still decides what is genuine. It is a discriminator only if the provider really sets `at+jwt` on access tokens and something else on ID tokens. **Whether Auth0 does (and under which API setting) and whether Keycloak does (it has historically used `JWT` for both) is unverified.** If a provider labels both `JWT`, naming `JWT` in `OIDC_ACCESS_TOKEN_TYPES` removes the header as a discriminator (startup prints a warning), leaving only checks 2 and 3.
- Checks 2 and 3 assume the provider does not put `nonce`/`at_hash`/`c_hash` into access tokens, nor the client id into their audience. Some might. That would make a genuine access token fail, **closed**, and would be found by S6; there is deliberately no switch to turn these two checks off.
- A single-application provider setup where the API audience equals the client id is not supported (startup refuses it).
- A compromised or malicious provider is out of scope: it can mint any token.

## 10. Browser sign-in (Authorization Code + PKCE S256): the implementation plan (NOT built)

Nothing below is implemented, and **nothing may be implemented against invented provider behavior**; each value marked *staging* comes from a real tenant (section 12).

**Server side (small):**
- `AuthConfig`/`publicConfig` gain non-secret fields *(staging)*: authorization endpoint, token endpoint, optional end-session endpoint, the exact redirect URI and post-logout URI (https, each under a `PUBLIC_ORIGINS` origin), scopes, and the provider's audience-parameter name. Static configuration, validated at startup, no discovery fetch. There is no client secret (public client) and the server performs **no** code exchange.
- CSP: add the **token endpoint's origin only** to `connect-src`. Navigations to the authorization and end-session endpoints are not governed by `connect-src`. `frame-ancestors`, `script-src` and `form-action` stay as they are; the COOP header rules out popup flows, so the flow uses full-page redirects.
- A route or file mapping for the redirect path (today an unknown path is a 404), served `Cache-Control: no-store` with the existing `Referrer-Policy: no-referrer`.

**Browser side (the work):**
1. *Start:* create a 32-byte random `code_verifier` (base64url, 43 characters), derive `code_challenge = BASE64URL(SHA-256(verifier))` with WebCrypto, send `code_challenge_method=S256` (never `plain`), a 128-bit random `state`, and a random `nonce`. Store verifier, state and nonce in `sessionStorage` for the redirect only (memory cannot survive a full-page navigation), keyed by state, single use, expiring after 10 minutes.
2. *Callback:* read `code`, `state` and any `error` from the query, then immediately strip them from the address (`history.replaceState`). On an `error` show a **fixed** message (never provider text). Compare `state` to the stored one in constant time, **delete the stored entry before any network call**, and refuse on any mismatch, expiry or reuse.
3. *Exchange:* `POST` (form-encoded, `fetch`, same CSP) to the token endpoint with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. Accept only `token_type: Bearer` and an `expires_in` no larger than the configured lifetime; keep the **access token in memory only**.
4. *ID token:* never sent to the API. If read at all it is only to learn the `sub` for a "request access" screen, after checking its `nonce`; it arrived directly from the token endpoint over TLS and is trusted for **display only**.
5. *Use:* the existing `Auth` seam sends `Authorization: Bearer` with the in-memory access token to `/api/me`, `/api/me/workspaces` and the workspace routes; the workspace list comes from the server rather than from stored tokens.
6. *Renewal:* redirect-based re-authentication (decided; **no refresh tokens yet**). Because a redirect discards page memory, unsaved form input needs a plan (preserve drafts in `sessionStorage`, or re-authenticate only on a 401 or at idle). Open UX item.
7. *Logout:* clear memory and the transient storage, then redirect to the provider's end-session endpoint with the registered post-logout URI. The server has no session (C16).
8. *Tests:* offline jsdom tests with a fake token endpoint for state, verifier, single use, expiry, callback stripping, and refusal cases; a **real-browser** pass against staging for everything provider-specific. The existing token-storage characterization test must change deliberately (`sessionStorage` for the transient values only).

## 11. Onboarding: verifying the exact issuer and immutable subject

Email addresses and display names are never used to infer a subject. Nobody is authorized by being first, by their email domain, or by default; ownership is granted only through a claim-list entry.

1. The operator creates or invites the person **at the provider** and reads the immutable user id there (the `sub` form per connection is *staging* evidence, S17 and S18).
2. Record in a pilot roster (outside the repository): person, **issuer** (copied from `OIDC_ISSUER`), **subject**, the client it was read from (pairwise subjects), date, and who read it.
3. A **second person** compares the subject with the provider's record for that user.
4. Add the exact subject to `OIDC_ALLOWED_SUBJECTS` in the deployment configuration and restart. Add it to `OIDC_CLAIM_SUBJECTS` only with a separate, explicit approval.
5. After the person's first sign-in, confirm the created user row's (issuer, subject) equals the roster entry.
6. If the provider cannot reveal the subject in advance: the person's first attempt is refused with nothing written; once the sign-in client exists it shows them their issuer and subject to send through a known channel; the operator verifies it out of band before step 4.
7. Offboarding: remove the entry, remove memberships (immediate), and disable the person at the provider (effective within the token lifetime).

## 12. Proposed separately, NOT implemented: emergency subject deny-list

A configured `OIDC_DENIED_SUBJECTS` (exact subjects, checked right after verification and before any user is provisioned) would cut a person off immediately instead of waiting for their token to expire (up to 900 s plus the leeway). Effects: needs a restart; a denied person's existing sessions fail at the next request; membership data is untouched. It needs a decision and its own tests; it is not part of this change.

## 13. Staging evidence still required before Auth0 compatibility can be claimed

None of this has been observed. Each item is a pass or fail against the real tenant (check numbers refer to section 6).

| Evidence | Why it matters | Check |
|---|---|---|
| The `typ` header of an access token for our API, and of an ID token | Decides whether `at+jwt` (the default) works or the format must be named explicitly | S6 |
| Whether access tokens ever contain `nonce`, `at_hash`, `c_hash` | Those claims make this verifier refuse the token | S6 |
| The full `aud` of an access token (does it list the client id or a userinfo audience?) | A listed client id makes the verifier refuse the token | S6 |
| Are access tokens JWTs for our custom audience at all? | Opaque tokens cannot be verified | S9 |
| `iss` byte for byte (trailing slash) | C2 is exact | S6 |
| `azp` presence and value; behavior with several audiences | C4 | S6 |
| `sub` form per connection; pairwise or not; readable before first sign-in | The allow-list depends on it | S17, S18 |
| Access-token lifetime configurable to 10 minutes; `iat`/`exp` present | The server requires at most 900 s | S6, S12 |
| Token size with a realistic user | 8 KB cap | S6 |
| Redirect URI exactness, CORS on the token endpoint, end-session behavior | The PKCE plan in section 10 | S1, S2, S16 |
| Signing-key rotation overlap and JWKS availability | C8, C10 | S10, S11 |
| The same facts for Keycloak (fallback): the `typ` it sets, how the audience is added, subject form | The fallback may need `OIDC_ACCESS_TOKEN_TYPES=JWT` and therefore weaker discrimination | S6 |
