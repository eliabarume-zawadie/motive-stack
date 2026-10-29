# Moving MotiveStack's data and secrets out of OneDrive (localhost)

**Why.** On the development machine the project folder is `C:\Users\<you>\OneDrive\Desktop\...`. OneDrive therefore uploads everything in it: the SQLite database and its write-ahead log (`data/motivestack.db`, `-wal`, `-shm`), the backups (`data/backups`), `.env.local` and the file `secret-key`. Three problems follow:

1. **Secrets and personal data leave the machine.** They are copied to a cloud account (with its version history and recycle bin) that this project does not control.
2. **A live SQLite file can be corrupted or forked** by a sync client that copies it while the app is writing. The database file carries the OneDrive `ReparsePoint` flag, so it is a cloud-managed file.
3. **Backups kept beside the database are not a backup.** They share the disk and the sync fate.

**This procedure moves nothing by itself.** A person runs each step, in order, and each step has a check that must pass before the next. **The original database, assets, backups and secrets are kept exactly where they are until you explicitly approve cleanup (step 10).** Nothing in steps 1 to 9 deletes, renames or overwrites anything that already exists, so the whole move can be undone by pointing the settings back (see *Rollback*).

This is a localhost-only task: it needs no hosting, no cloud account and no network. Commands are PowerShell, run from the project folder. `D:\MotiveStackData` is an example; any folder **not** under `C:\Users\<you>\OneDrive` is fine.

## One fact to respect: the newest data is in the `-wal` file

On this machine the database file `motivestack.db` was last written on 2026-10-27, while `motivestack.db-wal` is about 4 MB and was written on 2026-10-28. SQLite keeps recent changes in the `-wal` file until a checkpoint. **Copying only `motivestack.db` would silently lose that recent work.** So: never copy the three files by hand. Always take the copy from a backup made with `npm run backup`, which uses SQLite's own online backup (it reads the `-wal` correctly), and never delete a `-wal` or `-shm` file, even when the app is stopped.

## What was rehearsed, and what was not

On 2026-10-29 steps 2, 4, 5, 6 and 7 were run end to end on a scratch folder under `%TEMP%` using the real database as the source (read only, through the online backup). Results: the OneDrive test returned True for the project and `data/` and False for the new location; the folder was locked to the current user; `npm run backup` passed 7/7 into the new location; `npm run restore:check` passed 12/12; the copy's SHA-256 equalled the manifest's; the app started against the copy and `/api/health/ready` answered `{"ok":true,...}`; the live database and the copy agreed on every row count (3 workspaces, 3 campaigns, 2 leads, 116 audit rows, 23 migrations) with `integrity_check` ok on both. The inventory script (step 1) and the comparison script (step 6) were run read-only against the real database and its newest backup (identical, 0 foreign-key violations). A normal development server was also started against an in-memory database on a spare port: it reported `Mode: MOCK`, answered readiness, refused a wrong `Host` header (403) and an unauthenticated workspace call (401). The scratch folder from the rehearsal was removed; the live app on port 3000 and the real data were untouched throughout.

**Not rehearsed (cannot be from here):** the actual move of the real data, the OneDrive clean-up in step 10 (it happens in your Microsoft account), and a different Windows user or drive. Treat those with care.

## Steps

### 1. Inventory: what is configured, and what is synced (read only)
```
@'
// Read-only inventory: where the data lives and whether it is in a cloud-synced folder. Prints settings from an allowlist; for every other key in .env.local it prints the NAME only.
const fs = require("fs"), path = require("path"), dotenv = require("dotenv");
const local = fs.existsSync(".env.local") ? dotenv.parse(fs.readFileSync(".env.local")) : {};
const get = (k) => (process.env[k] !== undefined ? process.env[k] : local[k]);
const SAFE = ["DEPLOYMENT_ENV", "AUTH_MODE", "INTEGRATION_MODE", "AI_PROVIDER_MODE", "ALLOW_LIVE_PROVIDER_CALLS", "LIVE_META", "LIVE_GHL", "DATABASE_PATH", "ASSET_DIR", "BACKUP_DIR", "BACKUP_COPY_DIR", "PORT", "WORKER_IN_PROCESS"];
const synced = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean).map((r) => r.replace(/[\\/]+$/, "").toLowerCase() + path.sep);
const inCloud = (p) => synced.some((r) => (path.resolve(p).toLowerCase() + path.sep).startsWith(r));
const where = { database: get("DATABASE_PATH") || "./data/motivestack.db", assets: get("ASSET_DIR") || "data/assets", backups: get("BACKUP_DIR") || "./data/backups" };
console.log("Settings (allowlist only):");
for (const k of SAFE) { const v = get(k); if (v !== undefined) console.log("  " + k + " = " + (v === "" ? "(empty)" : v) + (k in local && process.env[k] === undefined ? "   [from .env.local]" : "")); }
console.log("Other keys in .env.local (names only, values not shown):", Object.keys(local).filter((k) => !SAFE.includes(k)).join(", ") || "none");
console.log("Effective locations and whether each is inside a OneDrive folder:");
for (const [n, p] of Object.entries(where)) console.log("  " + n.padEnd(9) + path.resolve(p) + "   inside OneDrive: " + inCloud(p));
console.log("  project   " + process.cwd() + "   inside OneDrive: " + inCloud(process.cwd()));
const db = path.resolve(where.database);
for (const s of ["", "-wal", "-shm"]) console.log("  file " + path.basename(db) + s + ": " + (fs.existsSync(db + s) ? fs.statSync(db + s).size + " bytes, modified " + fs.statSync(db + s).mtime.toISOString() : "absent"));
const b = path.resolve(where.backups);
console.log("  backups: " + (fs.existsSync(b) ? fs.readdirSync(b, { withFileTypes: true }).filter((d) => d.isDirectory()).length + " folder(s)" : "none"));
const risky = ["INTEGRATION_MODE", "AI_PROVIDER_MODE", "ALLOW_LIVE_PROVIDER_CALLS", "LIVE_META", "LIVE_GHL"].filter((k) => get(k) && !["mock", "false", "local"].includes(String(get(k)).trim()));
console.log("Mode: " + (risky.length ? "NOT PURELY MOCK, check " + risky.join(", ") : "mock (no live setting is on)"));
'@ | node -
```
It prints the real database path and the `-wal`/`-shm` sizes, which folders are inside OneDrive, and whether any live setting is on. It never prints a secret: only allowlisted settings show a value; every other key in `.env.local` shows its name only. **Write the output down; it is your "before" record.** Also open the OneDrive tray icon and note whether *Manage backup* is on for Desktop: if it is, everything on the Desktop is synced, which is why the project itself should leave the Desktop (step 8).

### 2. Make the new, protected folders
```
$D = "D:\MotiveStackData"
New-Item -ItemType Directory -Force "$D\db","$D\assets","$D\backups","$D\secrets" | Out-Null
icacls $D /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
icacls $D        # only your account may appear
```
Check that the new location is not synced: set `$env:DATABASE_PATH="$D\db\motivestack.db"`, run the step 1 script again, and then `Remove-Item Env:DATABASE_PATH` so the setting does not linger. The database line must read `inside OneDrive: False`. If it says True, choose another folder. Do not continue until it is False.

### 3. Stop the app cleanly
Close the app by pressing **Ctrl+C in the terminal that is running it**; the app then closes its database cleanly. (If you must end the process instead, `Stop-Process` on the process listening on the port also works, but an abrupt stop may leave the `-wal` and `-shm` files in place. That is harmless for this procedure, because the backup in step 4 reads them correctly. **Do not delete them.**) Confirm nothing is listening:
```
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue   # must print nothing
```
The app is stopped before the backup so that nothing written afterwards can be missed. Do **not** run a second copy of the app on the same database to "keep working": two instances on one database conflict.

### 4. Take a verified backup into the new location, then prove it restores
```
$env:BACKUP_DIR = "$D\backups"
npm run backup                               # all 7 lines PASS, ending "7/7 checks passed"
Remove-Item Env:BACKUP_DIR
$b = Get-ChildItem "$D\backups" -Directory | Sort-Object Name | Select-Object -Last 1
npm run restore:check -- $b.FullName         # ending "12/12 checks passed ... the live database was not touched"
```
The backup verifies the SHA-256 of the database against its manifest, `integrity_check`, foreign keys, that the applied migrations equal the manifest's, every table's row count and every asset file's hash; the restore check then restores it into a scratch folder, runs the normal start-up migration on that copy and re-checks it. **If either command fails, stop and fix it.** `restore:check` leaves a scratch folder under `%TEMP%` (`motivestack-restore-*`); **do not delete those folders** until you approve cleanup, and know they hold a full copy of the data.

### 5. Copy the database from the verified backup, and check its hash
```
$man = Get-Content "$($b.FullName)\manifest.json" -Raw | ConvertFrom-Json
Copy-Item "$($b.FullName)\$($man.databaseFile)" "$D\db\motivestack.db"
$h = (Get-FileHash "$D\db\motivestack.db" -Algorithm SHA256).Hash.ToLower()
"manifest : $($man.databaseSha256)"; "copy     : $h"; $h -eq $man.databaseSha256     # must print True
if (Test-Path "$($b.FullName)\assets") { Copy-Item "$($b.FullName)\assets\*" "$D\assets" -Recurse }
```
`Copy-Item` silently overwrites a file of the same name, so this is only safe because `$D\db` is new and empty: run `Get-ChildItem "$D\db"` before this step and stop if it lists anything. Never copy `motivestack.db-wal` or `-shm`.

### 6. Prove the copy is the same data (read only on both files)
```
@'
// Read-only comparison of two SQLite files. Opens both read-only; changes nothing.
const D = require("better-sqlite3"), fs = require("fs");
const [a, b] = process.argv.slice(2);
const summary = (p) => {
  const db = new D(p, { readonly: true, fileMustExist: true }); const o = {};
  for (const t of ["workspaces", "users", "workspace_memberships", "campaigns", "leads", "lead_events", "action_proposals", "approvals", "jobs", "audit_events", "schema_migrations"]) {
    try { o[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch { o[t] = "(no table)"; }
  }
  o.lastMigration = db.prepare("SELECT MAX(name) n FROM schema_migrations").get().n;
  o.integrity = db.pragma("integrity_check", { simple: true });
  o.foreignKeyViolations = db.pragma("foreign_key_check").length;
  o.tables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  db.close(); return o;
};
const x = summary(a), y = summary(b);
console.log("A:", JSON.stringify(x)); console.log("B:", JSON.stringify(y));
const diff = Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
console.log(diff.length ? "DIFFERENT in: " + diff.join(", ") : "IDENTICAL on every count, the last migration, integrity and foreign keys");
console.log("clean (integrity ok, 0 foreign-key violations, 23+ migrations on both):", x.integrity === "ok" && y.integrity === "ok" && x.foreignKeyViolations === 0 && y.foreignKeyViolations === 0);
process.exit(diff.length ? 1 : 0);
'@ | node - ".\data\motivestack.db" "$D\db\motivestack.db"
"exit code: $LASTEXITCODE"                   # 0 means identical
```
Required: `IDENTICAL ...`, `clean ...: True`, exit code 0. The first path is the original (opened read only, so its `-wal` is read but not changed). Anything else: stop; the original is untouched and the old way of working still applies.

### 7. Start the app against the copy and check it (mock settings forced)
Variables set in the shell win over `.env.local`, so these settings cannot reach anything outside even if the old file has other values. Use `127.0.0.1` rather than `localhost` for the checks: in Windows PowerShell `localhost` tries IPv6 first, the app listens on IPv4 only, and the check stalls.
```
$env:DATABASE_PATH="$D\db\motivestack.db"; $env:ASSET_DIR="$D\assets"; $env:BACKUP_DIR="$D\backups"
$env:INTEGRATION_MODE="mock"; $env:AI_PROVIDER_MODE="mock"; $env:ALLOW_LIVE_PROVIDER_CALLS="false"; $env:LIVE_META="false"
npm start
```
Start-up can take up to 30 seconds. In a second window:
```
curl.exe -s http://127.0.0.1:3000/api/health/ready      # {"ok":true,"checks":{"database":true,"migrations":true}}
curl.exe -s http://127.0.0.1:3000/api/config            # "mode":"mock", "live":{"meta":false,"ai":false,"ghl":false}
```
The start-up text must show `Database: D:\MotiveStackData\db\motivestack.db` and `Mode: MOCK | Meta: simulated | AI: mock only | CRM: simulated`. Open the app in the browser and confirm your workspaces and campaigns are there. Then stop it with Ctrl+C. This also loads the newest code, including the server-error log line, which the older running instance does not have.

### 8. Secrets and the working copy
The application reads `.env.local` **from the folder it is started in**, and `secret-key` is used only by the Meta helper scripts in `scripts/`. Choose one:

- **A. Move the whole working copy (recommended).** Copy or clone the project to a folder outside OneDrive (for example `D:\dev\motive-stack`), copy `.env.local` into it, set `DATABASE_PATH`, `ASSET_DIR` and `BACKUP_DIR` in that copy's `.env.local` to the folders from step 2, and work from there. This also stops OneDrive syncing `node_modules` and removes the Desktop-backup exposure. In the new copy run `git status`: it must show exactly the work you expect (uncommitted work does not travel with a clone, so copy the folder, or commit first with your approval). Run steps 1 and 7 again from the new copy.
- **B. Keep the working copy where it is (not recommended).** Keep the secrets in `$D\secrets\env.local` and load them into the shell before starting: `Get-Content "$D\secrets\env.local" | ForEach-Object { if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { Set-Item "Env:$($Matches[1])" $Matches[2] } }`. The old `.env.local` is left in place until step 10. The project folder is still synced, so keep nothing else sensitive in it.

Either way, lock the new secrets file to your account: `icacls "<path to env.local>" /inheritance:r /grant:r "${env:USERNAME}:F"`, and never put real keys in `.env.example`.

### 9. Switch day-to-day work to the new location
Start the app only with the new settings (the new copy's `.env.local`, or the variables from step 7). Run the step 1 inventory again: every location must read `inside OneDrive: False`, the database path must be the new one, and the mode line must say mock. The originals stay where they are, unmodified and unused.

### 10. Clean up OneDrive, only after you approve it in writing (not rehearsed)
**I will not do this step, and nothing here does it automatically.** Do it only after steps 1 to 9 passed, the app has run from the new location for a while, and you have a second copy of the new data (a verified backup somewhere else). Then, in this order:

1. Delete `data\`, `.env.local` and `secret-key` from the synced project folder.
2. On the OneDrive web site (onedrive.live.com) empty the **Recycle bin** and the **Second-stage recycle bin**, so version history goes too.
3. Treat every secret that ever sat in the synced folder as exposed to that Microsoft account. Today that includes an OpenAI key in `.env.local` (value not examined). Revoke and replace keys at the provider; put the new ones only in the protected location. If a key is a test key with no spending power, accepting the risk is your decision.
4. Real personal data (leads) that was synced was stored by that account. Note it in your data-protection record.
5. Only now delete the `motivestack-restore-*` folders and any other scratch copies of the data under `%TEMP%`.

## Rollback (any time before step 10)
Nothing was removed, so rolling back is a settings change:
1. Stop the app (Ctrl+C).
2. Remove the new settings: open a new PowerShell window (so the variables from step 7 are gone), and if you chose option A go back to the old project folder; in option B leave the old `.env.local` as it is.
3. Start the app from the old folder and run the step 1 inventory: it must show the **original** database path again, with its `-wal` file.
4. Check `curl.exe -s http://127.0.0.1:3000/api/health/ready` and open the app.
5. **Anything written after step 9 exists only in the new location.** If you need it, stop the app, run `npm run backup` with the new settings so there is a verified copy, and decide deliberately how to bring that data across. Never copy the new database over the original without a verified backup of the original first.

## Acceptance checks (all must hold before step 10)
| Check | Where |
|---|---|
| Inventory shows database, assets and backups all `inside OneDrive: False` | step 9 |
| Backup 7/7 and restore check 12/12 from the new location | step 4 |
| SHA-256 of the copy equals the manifest's | step 5 |
| Comparison prints IDENTICAL, integrity ok, 0 foreign-key violations, same last migration | step 6 |
| Readiness `ok:true`; config shows mock and no live flag; the browser shows your workspaces | step 7 |
| Originals still present and unmodified | before step 10 |
