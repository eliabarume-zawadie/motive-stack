// Backup the database (online, consistent) and the asset folder, then verify the copy. Usage:  npm run backup
// Settings (environment): DATABASE_PATH (default ./data/motivestack.db), ASSET_DIR (default data/assets), BACKUP_DIR (default ./data/backups), BACKUP_COPY_DIR (optional second location).
// It reads the source and writes only inside the backup folders. It never deletes anything and prints no secret.
import { config as loadEnv } from "dotenv";
import { backupNow, verifyBackup } from "../src/ops/backup.js";

loadEnv({ path: ".env.local" });
const env = process.env;
const r = await backupNow({
  databasePath: env.DATABASE_PATH ?? "./data/motivestack.db", assetDir: (env.ASSET_DIR && env.ASSET_DIR.trim()) || "data/assets",
  backupDir: env.BACKUP_DIR ?? "./data/backups", extraCopyDir: env.BACKUP_COPY_DIR,
});
const checks = [...verifyBackup(r.dir), ...(r.extraDir ? verifyBackup(r.extraDir).map((c) => ({ ...c, name: `second copy: ${c.name}` })) : [])];
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  -> ${c.detail}` : ""}`);
console.log(`\nBackup: ${r.dir}${r.extraDir ? `\nSecond copy: ${r.extraDir}` : ""}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) FAILED: do not rely on this backup.` : `${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
