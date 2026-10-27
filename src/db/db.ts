import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

export function openDb(path: string, opts: { readonly?: boolean } = {}): Db {
  if (opts.readonly) {
    // For tools that must not change anything: SQLite itself refuses every write, creates no file, and leaves the journal mode alone.
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    ro.pragma("foreign_keys = ON");
    return ro;
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON"); // freed pages are overwritten with zeros (erased credentials must not linger in the file)
  return db;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Apply pending SQL migrations in filename order. Returns the names applied. Never drops data. */
export function migrate(db: Db): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + file, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    })();
    applied.push(file);
  }
  return applied;
}
