# Operations runbook

For whoever runs a MotiveStack server. It covers what exists today. It is not a deployment design: see **Open items** in [launch-readiness.md](launch-readiness.md) for what a public launch still needs (TLS and a proxy, monitoring, alerting, scheduled off-site backups).

## Run exactly one instance

The database is one SQLite file and the background worker runs inside the web process. Two instances on one database, or on copies of it, will conflict. Do not scale out.

## Settings for production

Set `DEPLOYMENT_ENV=production` (exactly that spelling: a misspelling such as `prod` or `Production` is refused immediately, before any database file is created, so a typo cannot quietly leave these protections off). The server then **refuses to start** unless all of these hold (it names each missing variable, never a value):

- `AUTH_MODE=oidc` (the shared local token must never face the public),
- `PUBLIC_ORIGINS` includes an `https://` origin,
- `HSTS_MAX_AGE_SEC` is above 0 (only once TLS is confirmed),
- `DATABASE_PATH` is set explicitly,
- **no live or external execution switch is on.** `INTEGRATION_MODE` must be unset or `mock`; `AI_PROVIDER_MODE` unset, `mock` or `local`; `LIVE_META`, `LIVE_GHL`, `ALLOW_LIVE_PROVIDER_CALLS` and `ALLOW_CUSTOM_PROVIDER_BASE_URL` unset or `false`; and no other variable starting `LIVE_` or `ALLOW_LIVE` set to a true-like value. The **standalone worker** (`npm run worker`, used with `WORKER_IN_PROCESS=false`) applies the same refusal and also needs an explicit `DATABASE_PATH`, because it executes approved jobs too. There is **no override**: enabling live ad-platform writes or billable AI in a deployment is a separate decision that needs a reviewed code change, not an environment variable. (The application has no code that sends e-mail or SMS or publishes content, so there is nothing to switch on for those.) Simulated operation is fully available.

The process listens on loopback only; put a TLS-terminating proxy in front of it. The proxy is also where unauthenticated request volume is limited: the app's own limiter only counts verified callers, resets on restart and is not shared.

### Startup checklist (production)

Do these in order; stop at the first one that fails.

1. The data folder (`DATABASE_PATH`, `ASSET_DIR`, `BACKUP_DIR`) is on the server's own disk and **not** in a cloud-synced folder such as OneDrive (see [move-data-outside-onedrive.md](move-data-outside-onedrive.md)).
2. Secrets are in the service's environment or a root-readable environment file, not in the repository folder.
3. `npm run backup` passes 7/7 and `npm run restore:check -- <that backup>` passes (a fresh install has nothing to back up; do this from the second start on).
4. Start the service. A refusal prints `Refusing to start: <VARIABLE>: <reason>` on standard error, exits with status 1, and has not opened the database. Fix the named variable and start again.
5. The log shows `MotiveStack listening` and `Server errors are logged to standard error as JSON lines`.
6. `GET /api/health/ready` through the public https address answers `200`, and the response carries the security headers (including `Strict-Transport-Security`).
7. Sign in as an allow-listed person and run the pilot walk-through before inviting anyone.

## Health checks

- `GET /api/health`: the process is up.
- `GET /api/health/ready`: `200 {"ok":true,"checks":{"database":true,"migrations":true}}` when the database answers and every migration is applied; `503` with the failing check otherwise. Point a load balancer or monitor at this.

What to alert on today: readiness not 200; the `repeated_server_errors` line in the error log (below); a rise in dead jobs or failed pictures (the inbox and *Problems & retries* list them); a rise in `5xx` at the proxy.

## Server errors: what is logged and what to do

Every HTTP 5xx answer writes **one JSON line on standard error** (a service manager such as systemd, or a PaaS, collects it). Example:

```
{"ts":"2030-01-02T03:04:05.000Z","level":"error","event":"server_error","requestId":"req_9f2c41a7be03d518","method":"PUT","route":"/api/workspaces/:wid/brain","status":500,"category":"internal","errorName":"TypeError","location":"src/app/workspaces.ts:51"}
```

- `route` is the route **template**, never the real URL, so no ids or query strings appear. `errorName` and `errorCode` are the error's class and code. `location` is the project file and line where it was thrown.
- **Never logged:** request bodies, headers, tokens, credentials, query strings, the error *message* (messages can echo values), or user data. Anything that is not a short plain identifier is dropped.
- `category` is one of `internal` (unexpected failure), `database_busy`, `provider` (an AI provider failed), or an application code such as `auth_unavailable`.
- On a `500` the caller also receives the same `requestId` in the answer body (`error.requestId`), so "it failed, id req_…" from a user can be matched to the line. Request ids are made by the server; a client cannot choose one.
- 4xx answers (bad input, no permission, not found) are ordinary refusals and are **not** logged here.
- Not covered: a crash of the whole process (Node prints it to standard error and exits; the service manager should restart it and record the exit), and background-job failures (those are stored with the job and shown under *Problems & retries*).

**Detecting repeated errors.** When 5 server errors occur within 5 minutes the process writes one extra line, and again only after a further 5 minutes of continuing trouble:

```
{"ts":"...","level":"alert","event":"repeated_server_errors","count":5,"windowSec":300,"threshold":5,"routes":["/api/workspaces/:wid/brain"]}
```

Alert on the string `"event":"repeated_server_errors"` in the service log (most log shippers and uptime services can match a keyword), in addition to the readiness check. Detection lives in the process's memory and resets on a restart, so a crash loop is seen by the service manager's restart count, not by this line.

**When the alert fires or a user reports an id:**

1. Find the lines: `journalctl -u motivestack --since "1 hour ago" | grep '"event":"server_error"'` (or search your log file for the id). Count by route and category: `... | jq -r '[.route,.category,.errorName] | @tsv' | sort | uniq -c | sort -rn`.
2. One route and one `errorName` after a deploy: it is almost certainly the deploy. Follow **Safe rollback** below.
3. `database_busy` many times: something is holding the database (a backup that did not finish, a second process on the same file). Check for a second instance; never run two.
4. `provider`: an AI provider is failing. In mock/pilot mode this should not happen; check `AI_PROVIDER_MODE` and the provider status page.
5. `internal` with `location` in `src/`: open that file and line; the `errorName` tells the kind. Reproduce on a copy of the database, not on the live one.
6. Check readiness. If it is not 200, follow **If the server misbehaves**.
7. Write down what happened and when (the log lines are the evidence). If personal data may have been exposed, see **If a secret may have leaked** and the data-protection steps in your retention policy.

Limits: this is a log, not a monitoring service. Nobody is paged unless you connect the keyword alert and the readiness check to something that notifies a person.

## Backups

Take one before every upgrade and on a schedule you choose.

```
npm run backup
```

It makes an **online, consistent** copy of the database (safe while the app runs) and a hash-checked copy of every asset file, writes a `manifest.json`, then **verifies** the copy: integrity, foreign keys, applied migrations, every table's row count and every file's hash. Settings: `DATABASE_PATH`, `ASSET_DIR`, `BACKUP_DIR` (default `./data/backups`) and `BACKUP_COPY_DIR` (a second location, also verified). It only reads the live data and writes inside the backup folders. A backup is only good if every check says PASS.

**Keep a copy somewhere other than the server.** `BACKUP_COPY_DIR` is a second folder, not an off-site copy: moving it off the machine is yours to arrange. The database and the asset folder must be kept together.

## Prove a restore (do this before you need it)

```
npm run restore:check -- ./data/backups/<timestamp>
```

It restores the backup into a **scratch folder** (never over the live database), runs the normal start-up migration on the restored copy, and checks the result. Run it after every backup you intend to rely on.

**To restore for real:** stop the app; keep the damaged files aside; copy `motivestack.db` from the backup to `DATABASE_PATH` and the `assets` folder to `ASSET_DIR`; start the app (it applies any newer migration); check `/api/health/ready`.

**After a restore, re-apply erasures.** A restored backup brings back anyone erased after it was taken. Before reopening to users, list `audit_events` of type `lead.erased` newer than the backup (their `entity_id` is the lead id) and erase those leads again. Erasure is recorded by id only, so this needs no personal data.

## Upgrading

1. `npm run backup`, and check every line is PASS.
2. Run the migration on a **copy** first: copy the newest backup's `motivestack.db` somewhere, point a scratch process at it, and confirm it starts. (`npm run restore:check` does this migration step for you.)
3. Stop, deploy the new code, start. Migrations are forward-only and additive; they apply on start and are recorded in `schema_migrations`.
4. Check `/api/health/ready`, then run a quick walk-through.

There is no automated rollback. Do not edit `schema_migrations` by hand.

### Safe rollback

Decide first whether the new version changed the database. Compare the number of rows in `schema_migrations` now with the number recorded in step 1's backup manifest (`manifest.json` lists the applied migrations; `npm run backup` also prints it).

| Situation | Do this | Cost |
|---|---|---|
| **No new migration applied** (same count) | Stop the service, deploy the previous version, start it, check `/api/health/ready`. The database is untouched. | None |
| **A migration was applied** | Preferred: **roll forward** with a fixed version, because the old code may not understand the newer schema. If you must go back: stop the service; keep the current database and assets aside (do not delete them); `npm run restore:check -- <step-1 backup>` must pass; copy that backup's `motivestack.db` to `DATABASE_PATH` and its `assets` folder to `ASSET_DIR`; deploy the previous version; start; check readiness. | **Everything written after the backup is lost** (leads, edits, approvals). Keep the aside copy so it can be inspected or merged by hand. |

After any restore: **re-apply erasures** (see *Prove a restore*), tell affected users that recent work may need to be redone, and look at the audit trail for gaps. Before relying on this in a pilot, rehearse it once on a copy: restore the newest backup into a scratch folder with `npm run restore:check`, start a scratch process on it with `PORT` set to an unused port, and confirm `/api/health/ready`.

## Data requests

- **Export:** an admin downloads Settings → *Data, privacy and usage* → *Download my workspace data*, or `GET /api/workspaces/:id/export`. Every secret is removed; image files are not included; the file contains personal data, so handle it as such.
- **Erase a person:** open their lead and use *Erase this person's personal data* (admin, with a reason). It removes the name, e-mail address and phone number from the lead, its status history, the simulated CRM copy and the event payload. The audit trail records only that it happened. It cannot reach older backups or a real CRM (none is connected).
- **Not built:** erasing a whole workspace or a staff member, retention schedules, automated deletion.

## If a secret may have leaked

1. **Provider key** (AI, Meta): revoke it at the provider first, then replace it in the server's environment and restart. Keys are read from the environment and never stored in the database or shown.
2. **A workspace token** (local mode only): in token mode a workspace owner can disable the legacy token; a leaked token is admin-equivalent for that workspace. Production does not use tokens.
3. **A stored credential** (needs a managed key provider, not configured today): revoke and replace it from Settings.
4. Look at the audit trail for the affected workspace (`GET /export` includes it, or Activity in the app). Each row names the kind of actor and the action.

## If the server misbehaves

1. Check `/api/health/ready`. If the database check fails, stop the app and run `PRAGMA integrity_check` on a **copy** of the file.
2. If the database is damaged, restore the newest verified backup (above).
3. A job stuck in *running* after a crash is re-queued automatically on start; execution jobs never send twice (an unknown outcome goes to *needs review*).
4. Do not delete rows by hand. The audit trail refuses edits and deletes at the database level.
