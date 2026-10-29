import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../db/db.js";

/**
 * Backup and restore verification for the SQLite database and the asset folder. A backup that was never restored is a hope, not a backup, so this module does both halves:
 *  - backupNow(): an ONLINE, consistent copy of the database (safe while the app runs), a hash-checked copy of every asset file, and a manifest;
 *  - verifyBackup(): opens the copy read-only and checks integrity, foreign keys, the applied migrations, every table's row count, and every asset file's hash;
 *  - restoreCheck(): restores the backup into a scratch folder, runs the normal migration step on it, and confirms the app's own tables are intact.
 * It never touches the source database except to read it, never deletes anything, and never prints a secret.
 */
export interface BackupOptions { databasePath: string; assetDir?: string | undefined; backupDir: string; extraCopyDir?: string | undefined; now?: () => Date }
export interface Manifest {
  format: "motivestack-backup-1"; createdAt: string; databaseFile: string; databaseSha256: string; databaseBytes: number; migrations: string[]; tableCounts: Record<string, number>;
  assetFiles: Array<{ path: string; sha256: string; bytes: number }>;
}
export interface Check { name: string; ok: boolean; detail: string }

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tables = (db: Database.Database): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const counts = (db: Database.Database): Record<string, number> => Object.fromEntries(tables(db).map((t) => [t, (db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n]));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p); }
  return out;
}

export async function backupNow(o: BackupOptions): Promise<{ dir: string; manifest: Manifest; extraDir: string | null }> {
  if (!existsSync(o.databasePath)) throw new Error("No database was found at the given path. Nothing was created.");
  const stamp = (o.now ? o.now() : new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = resolve(o.backupDir, stamp);
  if (existsSync(dir)) throw new Error("That backup folder already exists. Nothing was overwritten.");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "motivestack.db");
  const src = new Database(o.databasePath, { readonly: true });
  try { await src.backup(dest); } finally { src.close(); }
  const bk = new Database(dest, { readonly: true });
  let migrations: string[]; let tableCounts: Record<string, number>;
  try { migrations = (bk.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name); tableCounts = counts(bk); } finally { bk.close(); }
  const dbBytes = readFileSync(dest);
  const assetFiles: Manifest["assetFiles"] = [];
  if (o.assetDir && existsSync(o.assetDir)) {
    const root = resolve(o.assetDir);
    for (const f of walk(root)) {
      const rel = relative(root, f).split(sep).join("/");
      const target = join(dir, "assets", ...rel.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(f, target);
      const b = readFileSync(target);
      assetFiles.push({ path: rel, sha256: sha(b), bytes: b.length });
    }
  }
  const manifest: Manifest = { format: "motivestack-backup-1", createdAt: (o.now ? o.now() : new Date()).toISOString(), databaseFile: "motivestack.db", databaseSha256: sha(dbBytes), databaseBytes: dbBytes.length, migrations, tableCounts, assetFiles };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  let extraDir: string | null = null;
  if (o.extraCopyDir) {
    extraDir = resolve(o.extraCopyDir, stamp);
    for (const f of walk(dir)) { const t = join(extraDir, relative(dir, f)); mkdirSync(join(t, ".."), { recursive: true }); copyFileSync(f, t); }
  }
  return { dir, manifest, extraDir };
}

/** Opens a backup read-only and checks it against its manifest. Nothing is changed. */
export function verifyBackup(dir: string): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  let m: Manifest;
  try { m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest; } catch { add("manifest readable", false, "manifest.json is missing or not valid"); return checks; }
  add("manifest readable", m.format === "motivestack-backup-1", m.format);
  const dbPath = join(dir, m.databaseFile);
  if (!existsSync(dbPath)) { add("database file present", false, "missing"); return checks; }
  add("database hash matches the manifest", sha(readFileSync(dbPath)) === m.databaseSha256, `${m.databaseBytes} bytes`);
  const db = new Database(dbPath, { readonly: true });
  try {
    add("integrity_check", db.pragma("integrity_check", { simple: true }) === "ok");
    add("no foreign-key violations", (db.pragma("foreign_key_check") as unknown[]).length === 0);
    const mig = (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    add("applied migrations match the manifest", JSON.stringify(mig) === JSON.stringify(m.migrations), `${mig.length} applied, last ${mig[mig.length - 1] ?? "none"}`);
    const c = counts(db);
    const bad = Object.keys({ ...c, ...m.tableCounts }).filter((t) => c[t] !== m.tableCounts[t]);
    add("every table's row count matches the manifest", bad.length === 0, bad.length ? bad.join(", ") : `${Object.keys(c).length} tables`);
  } finally { db.close(); }
  const badFiles: string[] = [];
  for (const f of m.assetFiles) { const p = join(dir, "assets", ...f.path.split("/")); if (!existsSync(p) || sha(readFileSync(p)) !== f.sha256) badFiles.push(f.path); }
  add("every asset file is present and matches its hash", badFiles.length === 0, badFiles.length ? `${badFiles.length} bad: ${badFiles.slice(0, 3).join(", ")}` : `${m.assetFiles.length} files`);
  return checks;
}

/** Restores a backup into a scratch folder (never over a live database), runs the normal migration step, and checks the result is usable. */
export function restoreCheck(dir: string, scratchDir: string): Check[] {
  const checks = verifyBackup(dir);
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  mkdirSync(scratchDir, { recursive: true });
  const target = join(scratchDir, "restored.db");
  if (existsSync(target)) throw new Error("The scratch folder already holds a restored database. Nothing was overwritten.");
  copyFileSync(join(dir, m.databaseFile), target);
  const db = new Database(target);
  try {
    db.pragma("foreign_keys = ON");
    const applied = migrate(db as never);
    add("the app's normal start-up migration runs on the restored copy", true, applied.length ? `applied ${applied.join(", ")}` : "nothing pending");
    add("restored copy passes integrity_check", db.pragma("integrity_check", { simple: true }) === "ok");
    const c = counts(db);
    const lost = Object.keys(m.tableCounts).filter((t) => (c[t] ?? -1) < m.tableCounts[t]!);
    add("no table lost rows in the restore", lost.length === 0, lost.length ? lost.join(", ") : "all tables intact");
    add("workspaces are readable", (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n === (m.tableCounts.workspaces ?? 0));
  } finally { db.close(); }
  const info = statSync(target);
  add("restored file is not empty", info.size > 0, `${info.size} bytes`);
  return checks;
}
