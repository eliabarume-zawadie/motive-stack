# Operations runbook

For whoever runs a MotiveStack server. It covers what exists today. It is not a deployment design: see **Open items** in [launch-readiness.md](launch-readiness.md) for what a public launch still needs (TLS and a proxy, monitoring, alerting, scheduled off-site backups).

## Run exactly one instance

The database is one SQLite file and the background worker runs inside the web process. Two instances on one database, or on copies of it, will conflict. Do not scale out.

## Settings for production

Set `DEPLOYMENT_ENV=production`. The server then **refuses to start** unless all of these hold (it names each missing variable, never a value):

- `AUTH_MODE=oidc` (the shared local token must never face the public),
- `PUBLIC_ORIGINS` includes an `https://` origin,
- `HSTS_MAX_AGE_SEC` is above 0 (only once TLS is confirmed),
- `DATABASE_PATH` is set explicitly.

The process listens on loopback only; put a TLS-terminating proxy in front of it. The proxy is also where unauthenticated request volume is limited: the app's own limiter only counts verified callers, resets on restart and is not shared.

## Health checks

- `GET /api/health`: the process is up.
- `GET /api/health/ready`: `200 {"ok":true,"checks":{"database":true,"migrations":true}}` when the database answers and every migration is applied; `503` with the failing check otherwise. Point a load balancer or monitor at this.

What to alert on today: readiness not 200; a rise in dead jobs or failed pictures (the inbox and *Problems & retries* list them); a rise in `5xx` at the proxy.

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

There is no automated rollback: to go back, restore the backup from step 1 and deploy the old code. Do not edit `schema_migrations` by hand.

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
