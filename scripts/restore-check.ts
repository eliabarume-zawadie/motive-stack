// Prove a backup can be restored: restores it into a SCRATCH folder (never over the live database), runs the normal migration step, and checks the result. Usage:
//   npm run restore:check -- ./data/backups/<timestamp>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreCheck } from "../src/ops/backup.js";

const dir = process.argv[2];
if (!dir) { console.error("Give the backup folder: npm run restore:check -- ./data/backups/<timestamp>"); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), "motivestack-restore-"));
const checks = restoreCheck(dir, scratch);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  -> ${c.detail}` : ""}`);
console.log(`\nScratch copy: ${scratch} (the live database was not touched)`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) FAILED` : `${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
