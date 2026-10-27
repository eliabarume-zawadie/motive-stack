# Credential security (Milestone 4.3)

Status: the **storage foundation** is implemented and tested offline. **Nothing consumes it yet**: no AI provider, Meta call or CRM call reads a stored credential, and the HTTP routes are a **masked status list** (`GET /api/workspaces/:wid/credentials`, section 4a) and **owner-only create/replace, revoke and delete** (section 4b). No route returns, reveals or exports a secret. Choosing a managed key service is a **deployment decision that is still open** (see "Decisions required").

## 1. How credentials work today (before and after this milestone)

| Credential | Where it lives | Scope |
|---|---|---|
| OpenAI and Anthropic API keys | Server environment variables, read once at startup, and only when live AI is enabled (`src/ai/stack.ts`) | One key for the whole server; every workspace shares it |
| Meta access token | Server environment variable, read on each live connector build (`src/config.ts`, `src/app/context.ts`) | One token for the whole server; which workspace may use which ad account is decided separately (`workspace_meta_accounts`, M4.2.2) |
| GoHighLevel | None: the connector is simulated | Not applicable |
| Workspace token (legacy) | SHA-256 hash in `workspaces.token_hash`; shown once | Per workspace; being retired (M4.2) |
| Browser | Holds only the workspace id and token in `localStorage`; never a provider key | Per browser |

No database column held an integration credential, and no code encrypted anything. Operator tools (`src/cli.ts`, the evaluation and `scripts/meta-*.sh` tools) read `.env.local`, `secret-key` or `LIVE_ENV_FILE` for the operator's own use; they are outside the workspace boundary and unchanged.

M4.3 adds an **encrypted vault** (`workspace_credentials`) that is empty and unused by anything else. Existing environment credentials are not imported and keep working exactly as before.

## 2. What is stored

Per workspace and per kind (`openai`, `anthropic`, `meta_graph`, `ghl`) at most one **active** credential. A row holds: ids and status, an optional human label, the **sealed secret**, the **wrapped data key**, and the **id** of the master key that wrapped it. There is no plaintext column and no column that could hold one (a test checks the schema). The database stores key *ids*, never keys. No fragment of a secret is kept (an earlier draft kept a four-character hint; migration 008 removed it).

## 3. Cryptographic design

Envelope encryption with AES-256-GCM (authenticated encryption), using only `node:crypto`; no dependency was added.

1. Each credential gets a fresh random 256-bit **data key**. The secret is sealed with it (`nonce 12 | tag 16 | ciphertext`, fresh random nonce, so a nonce is never reused under a data key).
2. The data key is **wrapped** by a **master key** held by a `KeyProvider` (`src/credentials/keys.ts`). A managed key service would perform this wrap/unwrap without ever handing the master key to this process.
3. Both operations are bound to their context as authenticated data: sealed secret to `workspace | credential id | kind`; wrapped key to the same plus the **master key id**. A ciphertext copied to another workspace, kind or credential, or a wrapped key presented under another key id, fails authentication. These are two independent bindings.
4. Any failure (wrong key, wrong context, modified byte, truncation) produces the same uninformative error, so nothing is learned from it. A failed read is audited as `credential.integrity_failure` with a coarse reason (`key_unavailable`, `authentication_failed`) and never any secret.
5. Plaintext exists only inside `vault.use()`: the secret reaches the caller's function as a `Buffer` that is wiped when the function returns; data keys are wiped after use. JavaScript strings cannot be wiped, so the secret is not turned into a string except to scrub it out of errors thrown by the caller's own code.
6. **Revocation wins over a read in flight.** After the data key is unwrapped (possibly a remote call) the vault re-checks that the credential is still active; if it was revoked, replaced or deleted meanwhile, the secret is wiped and never handed out. A call that has already started using the secret is not interrupted.
7. **Error scrubbing.** An error thrown by the caller's own function is cleaned in place: message, stack, own data properties and the `cause` chain (to a bounded depth and size), for the secret as is, JSON-escaped, URL-encoded, base64, base64url and hex. Only matching text is replaced, so class, `kind`, `code` and unrelated text survive; accessor properties are never run; cycles are safe; a thrown string stays a string. If a value holding the secret cannot be changed (a frozen error), a plain error with the redacted message replaces it instead of the original leaking. It cannot see inside internal slots (for example a `Headers` object) or Buffers, and it does not protect a value the function *returns*. Callers must not put secrets into errors on purpose.

Code that can decrypt is confined: `createCipheriv`/`createDecipheriv` appear only in `src/credentials/crypto.ts`, `unwrap` only in the vault, the keyring environment variables only in `keys.ts`, and nothing outside the vault calls `use` (a test scans the source tree for each).

## 4. Lifecycle and who may do what

| Operation | Who | Effect |
|---|---|---|
| store / replace | Owner (signed in) | Seals the new secret. Replacing revokes and **erases** the previous version in the same transaction, so there are never two live secrets of one kind |
| masked status | Admin or owner (signed in) | Kind, status, version, label and who last changed it. No part of the secret and no key id (section 4a). The legacy workspace token cannot read it |
| use | Server code only (no route) | Decrypts for one call; see section 3 |
| revoke | Owner | Status `revoked`; sealed secret, wrapped key, key id are erased from the live row, SQLite overwrites freed pages (`secure_delete`), and the write-ahead log is checkpointed and truncated right away (best effort: it cannot finish while another connection is mid-read). It cannot be reactivated (database trigger); store a new one. **Copies outside this process stay outside our reach:** database backups, replicas, and disk blocks the storage layer has not yet reused. Backups should expire on a schedule, and master-key rotation plus retiring the old key is what makes an old copy permanently unreadable |
| delete | Owner | Revokes and also forgets the label of every version; a bare tombstone row remains for the audit trail |
| master-key rotation | Operator (server code, `rewrapAll()`) | Re-wraps data keys under the active master key. Secrets are not read or re-encrypted. A record that changes meanwhile is skipped; one that cannot be unwrapped is counted, audited and left as it was. Rotation is safe to interrupt and to repeat: each record is one atomic update, so a stopped run leaves some records on the old key and some on the new, and both keys must stay in the keyring until a rerun finishes. **Software cannot stop an operator removing a key from the environment.** `canRetire(keyId)` says whether it is safe (not the active key and nothing depends on it), `keyDependencies()` lists the keys live credentials depend on and whether the server still has them, and at startup the server prints a warning naming any missing key and how many credentials it strands |

The database enforces that an active row has key material and an ended row has none, that one credential is live per workspace and kind, that workspace, kind and version never change, and that nothing is revived. Audit events (`credential.stored|replaced|revoked|deleted|rewrapped|rewrap_failed|integrity_failure`) carry the actor, workspace, kind, version and ids; never a secret, label or hint.

Permissions: `credentials.read` (admin) and `credentials.manage` (owner), enforced by the vault itself and, for the person-only rule below, by the central request check. `credentials.read` is attached to the one status route (section 4a). `credentials.manage` is intentionally **not** attached to any HTTP route yet (Milestone 4.4b).

### 4a. The masked status route (M4.4a)
`GET /api/workspaces/:wid/credentials` (and the `HEAD` Fastify derives from it):
- **Who:** an admin or owner who is a signed-in person. Viewers and operators get 403; a non-member gets the same 404 as a workspace that does not exist; anonymous callers get 401. The legacy workspace token is refused (403) even though it is admin-equivalent elsewhere: `credentials.*` are *person-only* permissions (`PERSON_ONLY_PERMISSIONS`), checked in the central request hook and again by the vault, and the vault is not consulted for a token.
- **Workspace:** taken from the verified authorization context, never from a query string, header, cookie or body. Another workspace's URL is a 404 for someone who is not a member.
- **Response:** `{ "available": true, "credentials": [ { kind, status, version, label, updatedAt, updatedBy } ] }`, an explicit allow-list of fields. It never contains the secret, **any fragment of it** (no last characters, no hint), a decrypted value, ciphertext, a wrapped key, a master key, or even a master key *id* (key ids describe key configuration; the vault's `protectedBy` is deliberately left out). People tell two credentials apart by `label` and `version`. No fragment of a secret exists anywhere in the model.
- **No key provider:** the fixed response `{ "available": false, "credentials": [] }`, byte for byte, even if rows exist. It says nothing about keys, providers or configuration, and only admins and owners receive it (anyone else gets the usual refusal, so availability is not disclosed to them).
- **Caching:** every response under `/credentials` (success and refusal, `GET` and `HEAD`) carries `Cache-Control: no-store`.
- **Read-only:** it writes no row (no user, audit or credential), and no other method or sub-path exists (they answer 404).

### 4b. The write routes (M4.4b)

| Route | Effect |
|---|---|
| `PUT /api/workspaces/:wid/credentials/:kind` | Create the credential, or replace the current one. Body: `{ "secret": "...", "label": "..." | null }` |
| `POST /api/workspaces/:wid/credentials/:kind/revoke` | Revoke and erase the secret. No body |
| `DELETE /api/workspaces/:wid/credentials/:kind` | Delete: revoke, and forget every label. No body |

`:kind` is exactly `openai`, `anthropic`, `meta_graph` or `ghl`. Every response carries masked status only (`{ outcome, credential: { kind, status, version, label, updatedAt, updatedBy } }`) and an `ETag` with the credential's version. Nothing returns, echoes or logs a secret.

**Authorization.** A signed-in person who is an **owner** of the verified workspace (`credentials.manage`, person-only). Viewers, operators and admins get 403, the legacy workspace token gets 403, anonymous callers 401, non-members the same 404 as a workspace that does not exist. A refused identified caller is recorded as `credential.denied` (actor, operation, reason; never the body), throttled so a refused caller cannot flood the audit trail. The workspace is the one the central check verified; nothing in the body, query, headers or cookies can redirect a write.

**Strict input, decided before the body is read.**
- The rate limiter runs first, in a route-level `onRequest` hook, so a limited caller never has a body parsed.
- `PUT` must be `application/json` (utf-8 or no charset); a revoke or delete that carries a body must be too. Anything else is 415. (Fastify would otherwise accept `text/plain` as a string, so this is checked explicitly.)
- Bodies are limited to 8 KB (413). A query string is refused (400 `query_not_allowed`). The PUT body is a strict object with only `secret` and `label`; anything else is 400 `validation`. Revoke and delete accept no fields.
- Validation failures return a fixed code and message and never the Zod issue list (it can echo values). The vault's own checks (16 to 4096 visible characters, no spaces or line breaks; a plain label that does not contain the secret) use fixed messages as well.
- The logger is off, so bodies are never logged. `req.body` is cleared when the handler finishes, on success and on failure. Every response under `/credentials`, success or refusal, including 413, 415, 429, 503 and unknown sub-paths, is `Cache-Control: no-store`.

**Optimistic concurrency (`If-Match` is the credential's version: `1`, `"1"` or `W/"1"`; `*` and anything else is 400).**
| Situation | Result |
|---|---|
| Nothing ever stored, no `If-Match` | **Create** (201), version 1. The only create that needs no precondition |
| Nothing stored, `If-Match` given | 412 (there is nothing to match) |
| Ended (revoked or deleted) credential, no `If-Match` | 428. A stale client retrying an old create must not bring back a credential an owner has since ended |
| Ended credential, `If-Match` = newest version | **Create** (201), version = newest + 1, so history continues |
| Ended credential, `If-Match` not the newest version | 412 |
| Credential active, no `If-Match`, **same secret and label** | 200 `unchanged`: nothing is written (safe to retry after a lost response) |
| Credential active, no `If-Match`, anything else | 428 `precondition_required` |
| Credential active, `If-Match` stale | 412 `precondition_failed`, even if the secret is the same |
| Credential active, `If-Match` current, same secret and label | 200 `unchanged` |
| Credential active, `If-Match` current, different | 200 `replaced`: the old version is erased in the same transaction |
| Revoke or delete, no `If-Match` | 428; stale 412; never stored 404 |
| Revoke or delete repeated with the same version | 200 `unchanged` (no second audit event of the change) |
| Revoke after delete | 404 |
| State changes between the checks and the write (including while an "unchanged" comparison is still running) | 409 `credential_changed`, nothing written, and never an "unchanged" for a state that no longer exists |

Revoke and delete are bound to the version in `If-Match`: a retry carrying an older version is 412 and cannot touch a newer credential, whatever happened in between (replace, revoke, delete, re-create). Only a retry carrying the **current** version is an idempotent 200 `unchanged`.

*Behavior changed in the M4.4b closeout, and why:* before, a PUT without `If-Match` was accepted whenever the newest version was revoked or deleted. A client whose first create succeeded but whose response was lost could retry after an owner revoked the credential and silently resurrect it. Now that case is 428. The "unchanged" answer is also re-validated after the (possibly slow) secret comparison, because a revoke could land during it.

The "same secret" comparison happens inside the vault (decrypt, constant-time compare, wipe); only the yes/no leaves it. Concurrent writes are serialized by the database write lock plus the re-check in the transaction, so exactly one of several simultaneous creations or replacements with the same precondition succeeds and the others are told so; a losing secret is never stored.

**Rate limiting (in-process, no dependency).** Per workspace and caller, per workspace in total, and a stricter lockout after repeated client errors (4xx from an admitted request, including parser refusals). Defaults and variables:

| Variable | Default | Meaning |
|---|---|---|
| `CREDENTIAL_RL_CALLER_MAX` | 10 | writes one person may attempt against one workspace per window |
| `CREDENTIAL_RL_WORKSPACE_MAX` | 30 | writes all people together may attempt against one workspace per window |
| `CREDENTIAL_RL_WINDOW_SEC` | 60 | the window |
| `CREDENTIAL_RL_FAILURE_MAX` | 5 | client errors one person may accumulate against one workspace per failure window before a lockout |
| `CREDENTIAL_RL_FAILURE_WINDOW_SEC` | 300 | the failure window |
| `CREDENTIAL_RL_LOCKOUT_SEC` | 900 | how long the lockout lasts |
| `CREDENTIAL_RL_DENIED_AUDIT_MAX` | 10 | `credential.denied` events recorded per person per window |

Invalid values stop startup, naming the variable only. A limited request gets 429 with `Retry-After` and a fixed body that does not say which limit applied; it is audited once per window as `credential.rate_limited`. Reading the masked list is not limited. **Limitation:** counters live in the memory of one process. With several instances each counts separately (the effective limit is multiplied by the instance count) and counters reset on restart; a multi-instance deployment needs shared state, which is a deployment decision. The table is bounded: expired entries go first, then the oldest entries that hold **no active lockout** (down to 90% of `maxKeys`, default 10,000), so a flood of unique caller ids can neither grow memory nor erase an existing lockout. Only if lockouts alone exceed twice `maxKeys` are the oldest lockouts dropped (a hard memory bound). The key being counted is never evicted by its own call, so a new offender can still accumulate failures while the table is full of lockouts. Lockouts are keyed by workspace **and** person: being locked out of one workspace does not affect the same person in another, nor other people in that workspace. All three write routes (PUT, revoke, DELETE) share one `writeRoute` configuration (rate gate, strict JSON, failure counting); a test fails if a write route is added without it.

**Vault unavailable.** Every write is 503 `credentials_unavailable` (fixed message, nothing about keys), and nothing is stored. Callers who may not write are refused as usual, so the vault's state is not disclosed to them.

**Audit.** `credential.stored|replaced|revoked|deleted` (as before), `credential.unchanged` (an idempotent repeat), `credential.denied`, `credential.rate_limited`. Details hold only ids, kind, version, operation, scope or reason.

**Independence.** These routes only store and erase. Nothing reads a stored credential for use (`vault.use` is called by no one), a stored `meta_graph` credential authorizes no ad account, and authorizing an ad account stores no credential.

## 5. Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Database file or backup is stolen | Only ciphertext and wrapped keys are in it; master keys are elsewhere | If the master keys are stolen too, everything opens. With the local keyring they sit in the process environment |
| SQL injection or a read-only database leak | Same as above | Same |
| One tenant reads or uses another's credential | The workspace comes from the verified authorization, never from arguments; both ciphertext and wrapped key are bound to workspace and kind; reads are scoped by workspace | A compromised server process can ask the vault for any workspace's credential (it must be able to) |
| Someone with write access to the database rearranges ciphertext | Binding to workspace, id, kind and master key id makes moved or edited records fail authentication, and the failure is audited | They can still destroy credentials (denial of service) |
| Secret leaks through logs, errors, API, audit, UI | Never returned or logged; validation errors never echo input; errors from code using a secret are scrubbed; audit holds no secret or label; a test sweeps every GET route and the database | A caller that copies the Buffer or the string it derives from it can still leak it. Callers must follow the contract |
| Stolen or compromised owner account | Owner-only changes, audited with the real actor | An owner can replace or revoke a credential; that is the intended power |
| Stale access after offboarding | Role is read from the database on each call; revoke erases the secret | A secret already copied elsewhere is outside our control. Provider-side revocation is a separate external action |
| Key loss | None in software | Losing a master key makes the credentials it protects unrecoverable (by design); they must be stored again |
| Memory disclosure of a running process | Buffers wiped after use | Keys and secrets are briefly in memory; JavaScript strings cannot be wiped |

## 6. Key management: what is and is not decided

**Deployment guard (`DEPLOYMENT_ENV`).** `DEPLOYMENT_ENV` is `development`, `test` or `production` (exact lowercase). One function, `selectKeyProvider` (src/credentials/provider.ts), chooses the vault's key provider and fails closed:

| `DEPLOYMENT_ENV` | Local keyring from the environment | Injected provider (code) |
|---|---|---|
| `production` | **Refused**, whatever `CREDENTIAL_ALLOW_LOCAL_KEYRING` says | Accepted only if it declares `managed === true` (an approved managed key service). None exists yet, so the vault is **OFF** and every credential write is 503 |
| `development` / `test` | Only with `CREDENTIAL_ALLOW_LOCAL_KEYRING=true` | Accepted |
| unset or blank | Refused (not known to be development or test); startup warns | Accepted (a code-level choice) |
| anything else (`prod`, `Production`, ...) | Startup fails, naming the variable and the allowed values, never the value | Startup fails |

The value is read only from the environment object passed in (never the real process environment inside the library), so tests are deterministic and need no real credentials. Startup prints what the guard decided (never a value). **Implemented:** the `KeyProvider` interface (with `managed`), a test fake (any `LocalKeyring` built with random in-memory keys), and `LocalKeyring`, which reads `CREDENTIAL_KEYRING` (`id:base64key,id2:base64key2`, each key 32 random bytes) and `CREDENTIAL_ACTIVE_KEY` from the environment **only when the guard above allows it and `CREDENTIAL_ALLOW_LOCAL_KEYRING=true` is set**. Otherwise a keyring in the environment is ignored (and the server says so at startup). With nothing set, the vault is **off**: storing and using are refused with a clear 503 and nothing is stored. A malformed keyring stops the server at startup, naming the variable but not its contents; constant (for example all-zero) keys are refused.

**This is not a managed key service.** Master keys in an environment variable stay out of the database and out of source control, but anyone who can read the process environment, a crash dump or the deployment's secret store can read them, and there is no per-use access log or hardware protection. It is suitable for local development, tests and, at most, a single-host pilot with an understood risk. A key generated for real use should come from a cryptographic source (for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`) and be injected by the platform's secret store, never committed or pasted into chat.

### Decisions required before real customer credentials are stored
1. **Which managed key service** (cloud KMS or a hardware module) will hold master keys. This depends on the hosting provider, region and budget, none of which the repository fixes. The adapter is small: implement `activeKeyId`, `wrap` and `unwrap` over that service, passing the context as its encryption context, and add its error mapping to `KeyUnavailableError`.
2. **Who may operate rotation**, how often, and the retirement procedure (re-wrap, check `canRetire`, then remove the old key). Rotation is a server-code function today (`rewrapAll()`) with no command or route.
3. **Backup and recovery policy** for master keys (a lost key loses credentials).
4. **Whether `LocalKeyring` is allowed in production.** Decided and enforced: no (`DEPLOYMENT_ENV=production` refuses it regardless of any other setting). What remains open is only decision 1: until a managed provider is approved and implemented, production has credential storage OFF. Operators must set `DEPLOYMENT_ENV` in every deployment; an unset value is safe (local keyring refused) but disables the vault.

## 7. What this milestone deliberately does not do

- **No consumer.** AI providers still read environment keys; the Meta connector still uses the shared token. Wiring `vault.use()` into them is a later, separately authorized step, and for Meta it must not be done on the strength of `owner_assertion` alone (the ad-account authorization source is an owner's statement, not proof of ownership).
- **No authority from a credential.** Storing a `meta_graph` credential authorizes no ad account and reaches no connector; authorizing an account stores no credential (both directions are tested). The two are decided by different tables and code.
- **No route that reveals, exports or reads a secret**, and no UI (Milestone 4.4c). The status list (4a) and the owner-only writes (4b) are the only credential routes.
- **No provider-side revocation.** Revoking here erases our copy; invalidating the key at OpenAI, Anthropic or Meta is an external action for the credential's owner.
- **No automatic import** of environment credentials.

## 8. Rollback

Revert the commit. Migration 007 is additive: a table and two triggers, empty unless something stored credentials. Migration 008 is a forward migration that drops the `last4` column (007 itself is unchanged, so history is preserved); older code that still wrote `last4` would fail against it, so revert the code and the migration together on a database that has not gone live. To remove the feature, drop `workspace_credentials`. If credentials were stored and the master keys are discarded, those records are unrecoverable by design.

## 9. Key operations (M4.4c, Package 1)

Offline tooling for master keys. It adds **no** managed-key adapter, does not enable production credential storage, and does not change any consumer or Meta authorization. Key management is **not production-ready**: the procedures below are tested against fakes only, and the decisions at the end are still open.

### The command
Run on the server host, with the same `DATABASE_PATH` and key configuration as the server (it reads `.env.local` from the **current working directory** the way the server does). It never creates a database, never runs migrations, and never prints a secret, a key, wrapped bytes or anything a provider said (only fixed text, counts and key **ids** that look like ids). Commands that never write (`report`, `probe`, `rewrap --dry-run`) open the database **read-only**, so SQLite itself refuses any write and a rollback-journal database is not converted to WAL; only a real `rewrap` opens it for writing. Results go to **stdout**; error messages (wrong command line, no database, unopenable database, configuration error, no provider) go to **stderr**. Observed limitation: a read-only connection to a WAL database may leave an **empty** `-wal` file and a small `-shm` index beside it (the database file itself stays byte-identical).

```
npx tsx src/credentialKeys.ts report
npx tsx src/credentialKeys.ts probe
npx tsx src/credentialKeys.ts rewrap [--dry-run] [--limit N]
```

| Command | Does | Changes data |
|---|---|---|
| `report` | Which master keys live credentials depend on, whether the provider holds each, which can be retired. Works with no provider. Exit 1 if a credential depends on a key the provider does not hold | No |
| `probe` | Asks the provider to unwrap every live credential's data key (the **secret is never decrypted**). Exit 1 if any fails | No |
| `rewrap` | Moves live credentials from older master keys to the active one. `--dry-run` does everything except the write; `--limit N` examines at most N per run | Only the wrapped data key of a record |

Exit codes: 0 fine, 1 a problem was found (or no provider is available), 2 the command or configuration was wrong or the database could not be used. A database that is missing, not a SQLite file, or lacks the credential table is exit 2 with a fixed message. The provider is chosen by the same guarded function as the server (`selectKeyProvider`), so **in production there is no provider and `probe` and `rewrap` refuse** until an approved managed provider exists; the command line has no option to choose a provider.

### How rewrap stays safe
- For each record: unwrap the old wrapping, wrap under the active key, then **unwrap the new wrapping and compare** before writing anything. A provider that returns an unopenable wrapping, the wrong key id, or a wrapping of some other key cannot replace a working one.
- The write is conditional on the record still being active with the same key and wrapped bytes: a record revoked, replaced or already rewrapped meanwhile is skipped. Two overlapping runs move each record once between them.
- A record that fails is left exactly as it was, counted by a coarse reason (`key_unavailable`, `authentication_failed`, `busy`, `provider_error`) and audited (`credential.rewrap_failed`, ids and reason only). The run continues, and re-running picks it up. Successes are audited (`credential.rewrapped`).
- Secrets are never decrypted or re-encrypted; only data keys are re-wrapped. Master-key rotation does not change data keys.
- Nothing generates master key material, ever. The only random keys in the code are per-record data keys.

### Rotation workflow (local keyring; development, test or an accepted single-host pilot)
1. `report`, and take a backup of the database and of the current key material according to your policy.
2. Add the new key to `CREDENTIAL_KEYRING` **alongside** the old one, set `CREDENTIAL_ACTIVE_KEY` to the new id, restart the server. New and replaced credentials now use the new key.
3. `probe`, then `rewrap --dry-run`, then `rewrap` (repeat, or use `--limit`, until nothing remains).
4. `report` must show 0 needing a rewrap and the old key no longer listed (it is then retirable).
5. **Do not delete the old key while any backup taken before the rotation may need to be restored**: those backups are wrapped under it. Decide the retention period first.
6. Remove the old key from the keyring, restart, run `report` again. Never delete a key while `report` shows a dependency on it.

### Missing keys (D4): current behavior, and a proposal (not implemented)
Current, verified from code:
- **Active key missing**: the server refuses to start (the keyring is rejected). Nothing generates a replacement.
- **An older key missing**: the server starts and prints a warning naming key ids and counts. Credentials that depend on it fail closed: `vault.use()` answers **503 `credential_key_unavailable`** (fixed message, no key id) and writes a `credential.integrity_failure` audit event (reason only); the masked list and revoke/delete still work, and the rest of the application is unaffected; a replacement re-wraps under the active key, which is a legitimate recovery path. Only a provider that reports the key as unavailable (`KeyUnavailableError`) gives 503: **tampering, a wrong key under the same id, and any unclassified provider failure stay 500 `credential_unreadable`**, so an integrity or internal fault is never mistaken for an outage. A managed-key adapter must raise `KeyUnavailableError` for outages (a conformance check). No HTTP route calls `vault.use()` yet, so this is the vault's answer for the consumers added later. `report` and `probe` show the problem and exit 1.
- **Proposal (not implemented, needs approval)**: keep warn-and-continue as the default, and add an **opt-in** `CREDENTIAL_REQUIRE_KEYS=true` that refuses to start while any live credential depends on an unavailable key. Operational consequence: one missing old key then stops the **whole** service (campaigns, approvals, everything), not just credentials, so it should be opt-in and paired with the runbook above. In the meantime, run `report` (exit code 1) as a pre-start check in deployment.

### Provider conformance checks
`test/support/keyProviderConformance.ts` (`checkKeyProvider`; test tooling, kept out of `src/` so the source guards that confine decryption to the vault stay exact) is a set of executable checks any future managed-key adapter must pass before use: round trip under the active key id; the caller's buffer is neither changed nor kept; the result is a private copy; wrapping is randomized; a different workspace, credential or kind (context) is refused; an unknown key id raises `KeyUnavailableError`; modified, truncated, extended or empty wrapped data is refused; failures never repeat the key, context or wrapped bytes; concurrent use; and, given a rotated provider, old wrappings still open while new ones use the new key. Results hold only check names and fixed notes. The suite is itself tested against fourteen deliberately faulty providers (plus two rotation faults). **It cannot prove** what only a real service has: access policy and IAM, per-use audit logging, latency and failure behavior, regional failover, or hardware protection.

### Limitations
- Works with the local keyring (and any provider supplied in code). No managed provider exists; none was chosen or integrated.
- Availability of a key is only known if the provider implements `hasKey`; otherwise `report` says "availability unknown" and `probe` is the real check.
- The server reads its keyring at start: after changing the environment, restart it. The command can run while the server is up (writes are conditional), but the server will not see a new key until restarted.
- No scheduling, no automatic rewrap at startup, no alerting.
- Backups of the database made before a rotation still depend on the old key.

### Decisions still needed (not made here)
Who may run these commands and how often keys rotate; the backup, escrow and recovery policy for master keys (including a tested restore drill); the retention period before retiring an old key; whether to adopt `CREDENTIAL_REQUIRE_KEYS`; and the managed key service itself (D2, deferred until the host is assessed).
