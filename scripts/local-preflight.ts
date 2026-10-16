/**
 * Readiness check for local AI mode (Ollama). Talks ONLY to localhost. No key, no billing, no secrets involved.
 * Usage: npm run local:preflight
 */
import os from "node:os";
import { assertLoopbackUrl, DEFAULT_OLLAMA_BASE_URL } from "../src/ai/ollamaProvider.js";
import { ModelRegistry } from "../src/ai/registry.js";

const baseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
let bad = 0;
const row = (ok: boolean, label: string, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

console.log("Local AI (Ollama) preflight. Only localhost is contacted.\n");

let root = "";
try {
  const u = assertLoopbackUrl(baseUrl);
  root = `${u.protocol}//${u.host}`;
  row(true, "OLLAMA_BASE_URL points at this machine", u.host);
} catch (e) {
  row(false, "OLLAMA_BASE_URL points at this machine", (e as Error).message);
}

const reg = ModelRegistry.fromFile(process.env.AI_MODELS_FILE ?? "config/ai-models.json");
const wanted = reg.entries.filter((e) => e.provider === "ollama" && e.enabled);
row(wanted.length > 0, "an enabled ollama model is in the registry", wanted.map((m) => m.model).join(", "));

async function get(path: string) {
  const r = await fetch(root + path, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

if (root) {
  try {
    const v = await get("/api/version");
    row(v.status === 200, "Ollama server is running", `version ${v.json.version}`);
    const tags = await get("/api/tags");
    const installed: string[] = (tags.json.models ?? []).map((m: any) => m.name);
    for (const m of wanted) {
      const have = installed.includes(m.model);
      row(have, `model ${m.model} is installed`, have ? "" : `run: ollama pull ${m.model.replace(/:latest$/, "")}`);
    }
    const ps = await get("/api/ps");
    const running = (ps.json.models ?? []).map((m: any) => `${m.name} (${(m.size_vram / 1e9).toFixed(1)} GB in VRAM)`);
    console.log(`INFO  loaded in memory right now: ${running.join(", ") || "none (the first request loads the model, which takes extra seconds)"}`);
    const usesGpu = (ps.json.models ?? []).some((m: any) => m.size_vram > 0);
    if (ps.json.models?.length) console.log(`INFO  inference is running on the ${usesGpu ? "GPU" : "CPU"}`);
  } catch (e) {
    row(false, "Ollama server is running", `no answer from ${root}: start the Ollama app, then retry (${(e as Error).name})`);
  }
}

console.log(`INFO  RAM: ${(os.totalmem() / 1e9).toFixed(1)} GB total, ${(os.freemem() / 1e9).toFixed(1)} GB free. An 8B model needs about 6 GB.`);
console.log("INFO  CPU-only generation is slow (about 2-3 tokens/s on the dev PC): a full brief takes around 2 minutes.");
console.log(bad === 0
  ? "\nReady. Start with:  AI_PROVIDER_MODE=local npm start      Measure it with:  npm run test:local:ollama"
  : `\n${bad} check(s) failed: local mode is not ready.`);
process.exitCode = bad === 0 ? 0 : 1;
