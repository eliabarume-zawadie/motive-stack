import { config as loadEnv } from "dotenv";
import { loadConfig } from "../config.js";
import { buildContext } from "../app/context.js";
import { createWorker } from "../app/worker.js";
import { migrate, openDb } from "../db/db.js";
import { buildServer } from "./app.js";

loadEnv({ path: ".env.local" });
const env = process.env;

const dbPath = env.DATABASE_PATH ?? "./data/motivestack.db";
const db = openDb(dbPath);
const applied = migrate(db);
const ctx = buildContext({ db, env });
if (ctx.integrations.liveMeta) loadConfig(env); // fail fast with a clear message if live Meta is requested without a token

const app = buildServer(ctx);
let worker: ReturnType<typeof createWorker> | null = null;
if (env.WORKER_IN_PROCESS !== "false") {
  worker = createWorker(ctx);
  worker.start(500);
}

const port = Number(env.PORT ?? 3000);
await app.listen({ host: "127.0.0.1", port }); // localhost only: never exposed to the network

const i = ctx.integrations;
console.log(`MotiveStack listening on http://localhost:${port}`);
console.log(`Database: ${dbPath}${applied.length ? ` (applied ${applied.join(", ")})` : ""}`);
console.log(`Mode: ${i.mode.toUpperCase()}  |  Meta: ${i.liveMeta ? "LIVE" : "simulated"}  |  AI: ${i.liveAi ? "LIVE paid providers" : i.localAi ? "LOCAL model (Ollama)" : "mock only"}  |  CRM: simulated`);
if (i.mode === "live") console.log("WARNING: live mode is on for the providers listed above. Writes stay paused-only and approval-gated.");
console.log(`Worker: ${worker ? "running in this process" : "NOT running here; start it with: npm run worker"}`);

const shutdown = () => {
  worker?.stop();
  void app.close().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
