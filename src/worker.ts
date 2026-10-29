import { config as loadEnv } from "dotenv";
import { workerProblems } from "./deployment.js";
import { loadConfig } from "./config.js";
import { buildContext } from "./app/context.js";
import { createWorker } from "./app/worker.js";
import { migrate, openDb } from "./db/db.js";

// Standalone background worker (use with WORKER_IN_PROCESS=false on the server).
loadEnv({ path: ".env.local" });
const env = process.env;
{
  // The worker executes approved jobs, so a production deployment gets the same refusal as the web process, before any database is opened (see workerProblems in deployment.ts).
  const problems = workerProblems(env);
  if (problems.length) { for (const p of problems) console.error(`Refusing to start: ${p}`); process.exit(1); }
}
const db = openDb(env.DATABASE_PATH ?? "./data/motivestack.db");
migrate(db);
const ctx = buildContext({ db, env });
if (ctx.integrations.liveMeta) loadConfig(env);
const worker = createWorker(ctx);
worker.start(500);
console.log(`Worker running. Mode: ${ctx.integrations.mode.toUpperCase()}. Ctrl+C to stop.`);
process.on("SIGINT", () => {
  worker.stop();
  db.close();
  process.exit(0);
});
