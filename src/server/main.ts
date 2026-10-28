import { config as loadEnv } from "dotenv";
import { buildAuthRuntime, loadAuthConfig } from "../auth/config.js";
import { loadConfig } from "../config.js";
import { buildContext } from "../app/context.js";
import { createWorker } from "../app/worker.js";
import { migrate, openDb } from "../db/db.js";
import { backfillTenancy } from "../app/tenancy.js";
import { syncAllLifecycles } from "../app/lifecycle.js";
import { LocalAssetStore } from "../storage/assetStore.js";
import { credentialStartupNotes } from "../credentials/provider.js";
import { buildServer } from "./app.js";
import { loadApiRateLimits, loadClaimRateLimits, loadCredentialRateLimits } from "./rateLimit.js";
import { loadSecurityConfig } from "./security.js";

loadEnv({ path: ".env.local" });
const env = process.env;

const dbPath = env.DATABASE_PATH ?? "./data/motivestack.db";
const db = openDb(dbPath);
const applied = migrate(db);
// Asset files live in a local folder (default data/assets, git-ignored). A development store: no backup, retention or object-storage claim.
const assetDir = env.ASSET_DIR && env.ASSET_DIR.trim() ? env.ASSET_DIR.trim() : "data/assets";
const ctx = buildContext({ db, env, assetStore: new LocalAssetStore(assetDir) });
const lifecycleFixed = syncAllLifecycles(ctx); // applies the exact lifecycle rules to every campaign; a campaign already correct is left alone
const tenancy = backfillTenancy(ctx); // only fills in what is missing (an organization or a policy row); a normal start changes nothing
if (ctx.integrations.liveMeta) loadConfig(env); // fail fast with a clear message if live Meta is requested without a token

const authConfig = loadAuthConfig(env);
const auth = buildAuthRuntime(authConfig); // fails fast on a half-configured OIDC setup
if (authConfig.mode === "oidc") {
  if (authConfig.allowedSubjects.length === 0) console.warn("WARNING: OIDC_ALLOWED_SUBJECTS is empty: nobody can sign up or create a workspace. Only people who already have an account can sign in.");
  if (authConfig.accessTokenTypes.includes("jwt")) console.warn("WARNING: OIDC_ACCESS_TOKEN_TYPES accepts typ \"JWT\", which many providers also put on ID tokens: the token-type header then cannot tell them apart, and only the audience, client-id and ID-token-claim checks remain.");
  console.log(`Onboarding: ${authConfig.allowedSubjects.length} authorized identit${authConfig.allowedSubjects.length === 1 ? "y" : "ies"}; legacy workspace claiming ${authConfig.claimSubjects.length ? `allowed for ${authConfig.claimSubjects.length}` : "DISABLED"}; token lifetime max ${authConfig.maxTokenLifetimeSec}s; signing keys trusted at most ${authConfig.jwksMaxAgeSec}s since the last fetch`);
}
const security = loadSecurityConfig(env); // an invalid origin or HSTS value stops startup, naming the variable only
if (security.publicOrigins.length === 0) console.log("Browser boundary: only loopback Host values (localhost, 127.0.0.1, [::1]) are accepted. Set PUBLIC_ORIGINS to serve this application under a public name.");
else console.log(`Browser boundary: loopback plus ${security.publicOrigins.length} public origin(s); HSTS ${security.hstsMaxAgeSec > 0 ? `on (max-age ${security.hstsMaxAgeSec}s)` : "off"}. TLS must be terminated in front of this process.`);
const app = buildServer(ctx, auth, { rateLimits: loadCredentialRateLimits(env), claimLimits: loadClaimRateLimits(env), apiLimits: loadApiRateLimits(env), security }); // an invalid limit stops startup, naming the variable only
for (const n of credentialStartupNotes(env, ctx.credentials.available)) (n.level === "warn" ? console.warn : console.log)(`${n.level === "warn" ? "WARNING: " : ""}${n.text}`);
let worker: ReturnType<typeof createWorker> | null = null;
if (env.WORKER_IN_PROCESS !== "false") {
  worker = createWorker(ctx);
  worker.start(500);
}

for (const n of ctx.aiPolicy.customBaseUrls) console.warn(`WARNING: ${n} is a custom host (ALLOW_CUSTOM_PROVIDER_BASE_URL=true): the provider key will be sent there, not to the official API. Development use only.`);
const port = Number(env.PORT ?? 3000);
await app.listen({ host: "127.0.0.1", port }); // localhost only: never exposed to the network

const i = ctx.integrations;
console.log(`MotiveStack listening on http://localhost:${port}`);
console.log(`Database: ${dbPath}${applied.length ? ` (applied ${applied.join(", ")})` : ""}`);
if (lifecycleFixed) console.log(`Lifecycle sync: ${lifecycleFixed} campaign(s) brought in line with their records`);
if (tenancy.organizationsCreated || tenancy.policiesCreated) console.log(`Tenancy backfill: ${tenancy.organizationsCreated} organization(s), ${tenancy.policiesCreated} policy row(s) created`);
console.log(`Mode: ${i.mode.toUpperCase()}  |  Meta: ${i.liveMeta ? "LIVE" : "simulated"}  |  AI: ${i.liveAi ? "LIVE paid providers" : i.localAi ? "LOCAL model (Ollama)" : "mock only"}  |  CRM: simulated`);
if (i.mode === "live") console.log("WARNING: live mode is on for the providers listed above. Writes stay paused-only and approval-gated.");
{
  const orphaned = ctx.credentials.keyDependencies().filter((d) => d.available === false);
  if (orphaned.length) console.warn(`WARNING: ${orphaned.reduce((n, d) => n + d.credentials, 0)} stored credential(s) depend on master key(s) the server does not have (${orphaned.map((d) => d.keyId).join(", ")}). They cannot be read until the key is restored. Never remove a master key while credentials depend on it.`);
}
console.log(`Credential vault: ${ctx.credentials.available ? `ON, master keys from ${ctx.credentials.providerName} (not a managed key service; see docs/credential-security.md)` : "OFF (no key provider configured); nothing is stored or read"}`);
console.log(`Auth: ${auth.mode === "oidc" ? "OIDC identities at /api/me; workspace routes still use workspace tokens until memberships (M4.2)" : "workspace tokens only (no identity provider configured)"}`);
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
