/**
 * Production never starts with a switch that lets the application reach the outside world or spend money on its own. Simulated (mock) operation and a local model stay available,
 * development and test processes are never affected, there is no override, and the refusal names variables but never echoes their values. Offline: the one spawned process exits
 * before it opens a database or a network connection.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { liveExecutionProblems, productionProblems, workerProblems } from "../src/deployment.js";

/** Everything else production requires, so only the live-execution rules are being tested. */
const PROD_OK = { DEPLOYMENT_ENV: "production", AUTH_MODE: "oidc", PUBLIC_ORIGINS: "https://app.example.test", HSTS_MAX_AGE_SEC: "31536000", DATABASE_PATH: "/srv/motivestack/data.db" };
const names = (problems: string[]) => problems.map((p) => p.split(":")[0]);

describe("production refuses live and external execution switches", () => {
  it("starts with nothing set, with explicit mock settings, and with a local model (nothing external)", () => {
    expect(productionProblems(PROD_OK)).toEqual([]);
    expect(productionProblems({ ...PROD_OK, INTEGRATION_MODE: "mock", AI_PROVIDER_MODE: "mock", LIVE_META: "false", LIVE_GHL: "false", ALLOW_LIVE_PROVIDER_CALLS: "false", ALLOW_CUSTOM_PROVIDER_BASE_URL: "false" })).toEqual([]);
    expect(productionProblems({ ...PROD_OK, INTEGRATION_MODE: "", AI_PROVIDER_MODE: "", LIVE_META: "", LIVE_GHL: "" })).toEqual([]);
    expect(productionProblems({ ...PROD_OK, AI_PROVIDER_MODE: "local" })).toEqual([]); // a model server on this machine reaches nothing outside
  });

  it("refuses live ad-platform mode, live CRM, billable AI, and provider keys sent to a custom host", () => {
    for (const [name, value] of [["INTEGRATION_MODE", "live"], ["AI_PROVIDER_MODE", "live"], ["LIVE_META", "true"], ["LIVE_GHL", "true"], ["ALLOW_LIVE_PROVIDER_CALLS", "true"], ["ALLOW_CUSTOM_PROVIDER_BASE_URL", "true"]] as const) {
      const problems = productionProblems({ ...PROD_OK, [name]: value });
      expect(names(problems), `${name}=${value}`).toEqual([name]);
    }
  });

  it("refuses spellings that a person might expect to work, and any unrecognised integration or AI mode", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", " true "]) expect(names(productionProblems({ ...PROD_OK, LIVE_META: v })), v).toEqual(["LIVE_META"]);
    for (const v of ["Live", "LIVE", "staging", "prod"]) expect(names(productionProblems({ ...PROD_OK, INTEGRATION_MODE: v })), v).toEqual(["INTEGRATION_MODE"]);
    for (const v of ["Live", "openai", "remote"]) expect(names(productionProblems({ ...PROD_OK, AI_PROVIDER_MODE: v })), v).toEqual(["AI_PROVIDER_MODE"]);
  });

  it("refuses a future LIVE_* or ALLOW_LIVE* switch even though nobody listed it, but not a setting that merely starts with LIVE_", () => {
    expect(names(productionProblems({ ...PROD_OK, LIVE_SMS: "true", ALLOW_LIVE_EMAIL: "1", LIVE_PUBLISH: "yes" }))).toEqual(["ALLOW_LIVE_EMAIL", "LIVE_PUBLISH", "LIVE_SMS"]);
    expect(productionProblems({ ...PROD_OK, LIVE_TEST_BUDGET_MICROS: "5000", LIVE_ENV_FILE: "/srv/x.env", LIVE_NOTHING: "false" })).toEqual([]);
  });

  it("reports each problem once, together with the other production requirements, and never echoes a value", () => {
    const env = { ...PROD_OK, INTEGRATION_MODE: "VALUE-ECHO-CHECK-1", LIVE_META: "true", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_PROVIDER_MODE: "VALUE-ECHO-CHECK-2" };
    const problems = productionProblems(env);
    expect(names(problems)).toEqual(["INTEGRATION_MODE", "AI_PROVIDER_MODE", "LIVE_META", "ALLOW_LIVE_PROVIDER_CALLS"]);
    expect(problems.join(" ")).not.toMatch(/VALUE-ECHO-CHECK/);
    const mixed = productionProblems({ DEPLOYMENT_ENV: "production", INTEGRATION_MODE: "live" }); // also missing AUTH_MODE, origins, HSTS, database path
    expect(names(mixed)).toEqual(["AUTH_MODE", "PUBLIC_ORIGINS", "HSTS_MAX_AGE_SEC", "DATABASE_PATH", "INTEGRATION_MODE"]);
  });

  it("does not affect development, test, or an unset deployment: mock and live-looking settings are both left to the existing rules", () => {
    for (const dep of ["development", "test", undefined]) {
      expect(productionProblems({ ...(dep ? { DEPLOYMENT_ENV: dep } : {}), INTEGRATION_MODE: "live", LIVE_META: "true", ALLOW_LIVE_PROVIDER_CALLS: "true" })).toEqual([]);
    }
  });

  it("has no override: no environment variable switches the refusal off", () => {
    const env = { ...PROD_OK, LIVE_META: "true", ALLOW_PRODUCTION_LIVE: "true", ALLOW_LIVE_EXECUTION: "true", FORCE: "true", PRODUCTION_OVERRIDE: "true", DEPLOYMENT_ENV_OVERRIDE: "development" };
    expect(names(liveExecutionProblems(env))).toContain("LIVE_META");
    expect(names(productionProblems(env))).toContain("LIVE_META");
  });
});

describe("a misspelt DEPLOYMENT_ENV is refused up front", () => {
  it("is a startup problem for the web server and for the worker, names only the variable and the allowed values, and never echoes what was typed", () => {
    for (const typo of ["prod", "Production", "PRODUCTION", "staging", "1"]) {
      for (const problems of [productionProblems({ ...PROD_OK, DEPLOYMENT_ENV: typo, LIVE_META: "true" }), workerProblems({ ...PROD_OK, DEPLOYMENT_ENV: typo, LIVE_META: "true" })]) {
        expect(names(problems), typo).toEqual(["DEPLOYMENT_ENV"]);
        expect(problems[0]).toContain("development, test, production");
      }
    }
    // a value that cannot overlap the message's own words, so an echo would be visible
    for (const problems of [productionProblems({ ...PROD_OK, DEPLOYMENT_ENV: "Zq-ECHO-CHECK-91" }), workerProblems({ ...PROD_OK, DEPLOYMENT_ENV: "Zq-ECHO-CHECK-91" })]) expect(problems.join(" ")).not.toContain("ECHO-CHECK");
    expect(productionProblems({})).toEqual([]); // unset or blank is still "not known to be production", as before
    expect(workerProblems({ DEPLOYMENT_ENV: "  " })).toEqual([]);
  });
});

describe("the standalone worker is guarded like the web process", () => {
  it("in production it needs an explicit database path and refuses every live switch; the sign-in and browser settings are not its business", () => {
    const { AUTH_MODE: _a, PUBLIC_ORIGINS: _p, HSTS_MAX_AGE_SEC: _h, ...workerEnv } = PROD_OK;
    expect(workerProblems(workerEnv)).toEqual([]);
    expect(names(workerProblems({ ...workerEnv, INTEGRATION_MODE: "live", LIVE_META: "true", ALLOW_LIVE_PROVIDER_CALLS: "true", LIVE_NEW_THING: "1" }))).toEqual(["INTEGRATION_MODE", "LIVE_META", "ALLOW_LIVE_PROVIDER_CALLS", "LIVE_NEW_THING"]);
    expect(names(workerProblems({ DEPLOYMENT_ENV: "production" }))).toEqual(["DATABASE_PATH"]);
    for (const dep of ["development", "test", undefined]) expect(workerProblems({ ...(dep ? { DEPLOYMENT_ENV: dep } : {}), INTEGRATION_MODE: "live", LIVE_META: "true" })).toEqual([]);
    expect(workerProblems({ ...workerEnv, INTEGRATION_MODE: "VALUE-ECHO-CHECK" }).join(" ")).not.toMatch(/VALUE-ECHO-CHECK/);
  });
});

/**
 * Runs an entry point as a real child process in production mode from a NEUTRAL folder, so the repository's own .env.local (which a developer may have, and which holds real keys) is
 * never loaded: a .env.local in the child's working folder would otherwise add variables and change the result. The child must exit before it opens a database or a port.
 */
function startInProduction(entry: string, extraEnv: Record<string, string>) {
  const repo = process.cwd();
  const tsx = pathToFileURL(createRequire(join(repo, "package.json")).resolve("tsx")).href;
  const tmp = mkdtempSync(join(tmpdir(), "ms-prodsafety-"));
  try {
    const marker = join(tmp, "must-not-exist.db");
    const child = spawnSync(process.execPath, ["--import", tsx, join(repo, entry)], {
      cwd: tmp, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...PROD_OK, DATABASE_PATH: marker, PORT: "3398", ...extraEnv },
    });
    return {
      status: child.status, stdout: child.stdout || "", database: existsSync(marker), filesCreated: readdirSync(tmp),
      refused: (child.stderr || "").split("\n").filter((l) => l.startsWith("Refusing to start:")).map((l) => l.split(":")[1]!.trim()),
    };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe("the real processes", () => {
  it("the web server refuses to start in production with live switches, names them on standard error, exits 1, and opens no database", () => {
    const r = startInProduction("src/server/main.ts", { INTEGRATION_MODE: "live", LIVE_META: "true", ALLOW_LIVE_PROVIDER_CALLS: "true" });
    expect(r.status).toBe(1);
    expect(r.refused).toEqual(["INTEGRATION_MODE", "LIVE_META", "ALLOW_LIVE_PROVIDER_CALLS"]);
    expect(r.stdout).not.toMatch(/listening/);
    expect(r.database).toBe(false);
    expect(r.filesCreated.filter((f) => f !== "must-not-exist.db")).toEqual([]);
  }, 60_000);

  it("the standalone worker refuses in the same way, so a separately started worker cannot run live jobs in production", () => {
    const r = startInProduction("src/worker.ts", { INTEGRATION_MODE: "live", LIVE_META: "true", LIVE_GHL: "true" });
    expect(r.status).toBe(1);
    expect(r.refused).toEqual(["INTEGRATION_MODE", "LIVE_META", "LIVE_GHL"]);
    expect(r.stdout).not.toMatch(/Worker running/);
    expect(r.database).toBe(false);
  }, 60_000);

  it("a misspelt DEPLOYMENT_ENV stops both processes before they create or open a database", () => {
    for (const entry of ["src/server/main.ts", "src/worker.ts"]) {
      const r = startInProduction(entry, { DEPLOYMENT_ENV: "prod", INTEGRATION_MODE: "live", LIVE_META: "true" });
      expect([entry, r.status, r.refused]).toEqual([entry, 1, ["DEPLOYMENT_ENV"]]);
      expect([entry, r.database, r.filesCreated]).toEqual([entry, false, []]); // nothing was created in the working folder, not even an empty database file
    }
  }, 90_000);

  it("a worker in production without an explicit database path is refused too, and nothing is created", () => {
    const r = startInProduction("src/worker.ts", { DATABASE_PATH: "" });
    expect(r.status).toBe(1);
    expect(r.refused).toEqual(["DATABASE_PATH"]);
  }, 60_000);
});
