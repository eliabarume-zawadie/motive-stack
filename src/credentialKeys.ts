import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { executeKeyCommand, parseKeyArgs, type KeyCommandResult } from "./credentials/keyOps.js";
import { openDb, type Db } from "./db/db.js";

// Operator command for credential master keys. Run it on the server host:
//   npx tsx src/credentialKeys.ts report | probe | rewrap [--dry-run] [--limit N]
// It uses the same DATABASE_PATH and key configuration as the server, never creates a database, never prints a secret or a key,
// and does not run migrations. Commands that never write (report, probe, rewrap --dry-run) open the database READ-ONLY, so SQLite itself
// refuses any write. Results go to stdout; error messages go to stderr. See docs/credential-security.md ("Key operations").
loadEnv({ path: ".env.local" });

function print(result: KeyCommandResult): void {
  const write = result.stderr ? console.error : console.log;
  for (const line of result.lines) write(line);
  process.exitCode = result.code;
}

async function main(): Promise<void> {
  const env = process.env;
  const parsed = parseKeyArgs(process.argv.slice(2));
  if (!parsed.ok) return print(parsed.result); // a wrong command line never opens the database
  const dbPath = env.DATABASE_PATH ?? "./data/motivestack.db";
  if (dbPath === ":memory:" || !existsSync(dbPath)) {
    console.error("No database was found at the configured path. Nothing was created or changed.");
    process.exitCode = 2;
    return;
  }
  let db: Db;
  try {
    db = openDb(dbPath, { readonly: !parsed.writes });
  } catch {
    console.error("The database could not be opened. Nothing was changed."); // fixed text: no path, no driver message
    process.exitCode = 2;
    return;
  }
  try {
    print(await executeKeyCommand({ argv: process.argv.slice(2), env, db }));
  } finally {
    db.close();
  }
}

try {
  await main();
} catch {
  console.error("The command failed unexpectedly. Nothing further was changed.");
  process.exitCode = 1;
}
