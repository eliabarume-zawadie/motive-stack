import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVALUATOR_VERSION } from "../src/eval/evaluate.js";
import type { Ledger } from "../src/eval/ledger.js";

const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
const md = readFileSync("docs/eval/plan-original-vs-current.md", "utf8");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const flag = (c: string, f: string) => new RegExp(`--${f} (\\S+)`).exec(c)?.[1];

describe("the plan for the remaining two invocations", () => {
  const remaining = plan.remaining.commands as string[];

  it("uses the corrected evaluator for both, and names the previous one for the finished cohort", () => {
    expect(plan.evaluator).toBe(EVALUATOR_VERSION);
    expect(EVALUATOR_VERSION).toBe("campaign-evaluator/3.3.0");
    expect(plan.identifiers.evaluator).toBe(EVALUATOR_VERSION);
    expect(plan.cohorts.B).toMatchObject({ evaluator: "campaign-evaluator/3.3.0", invocations: ["cmp-3-2-original-rep2", "cmp-3-2-current-rep2"] });
    expect(plan.cohorts.A).toMatchObject({ evaluator: "campaign-evaluator/3.2.0", invocations: ["cmp-3-2-current-rep1", "cmp-3-2-original-rep1"] });
  });
  it("is exactly original repetition 2 and current repetition 2", () => {
    expect(remaining).toHaveLength(2);
    expect(flag(remaining[0]!, "label")).toBe("cmp-3-2-original-rep2");
    expect(flag(remaining[0]!, "prompt")).toBe("original");
    expect(flag(remaining[1]!, "label")).toBe("cmp-3-2-current-rep2");
    expect(flag(remaining[1]!, "prompt")).toBe("current");
  });
  it("keeps every approved setting: model, all 14 cases, token cap, zero retries and repairs, shared ledger, budgets and ceiling", () => {
    for (const c of remaining) {
      expect(flag(c, "models")).toBe("openai/gpt-6-luna");
      expect(flag(c, "max-output")).toBe("2500");
      expect(flag(c, "repair")).toBe("0");
      expect(flag(c, "retries")).toBe("0");
      expect(flag(c, "ledger")).toBe("docs/eval/ledger-cmp-3-2.json");
      expect(flag(c, "aggregate-ceiling-micros")).toBe("156000");
      expect(flag(c, "max-total-requests")).toBe("56");
      expect(c).not.toMatch(/--cases|--check-access/);
      expect(c).toMatch(/--yes-spend$/);
    }
    expect(flag(remaining[0]!, "budget-micros")).toBe("31500");
    expect(flag(remaining[1]!, "budget-micros")).toBe("46500");
    expect(plan.approvedSettings).toMatchObject({ model: "gpt-6-luna", cases: 14, plannedGenerations: 56, maxOutputTokens: 2500, maxAggregateSpendMicros: 156000, retries: 0, repairs: 0, serviceTier: "default", responseStorage: "disabled (store:false)" });
  });
  it("fits the existing aggregate budget and request cap, computed from the real ledger", () => {
    const l = JSON.parse(readFileSync("docs/eval/ledger-cmp-3-2.json", "utf8")) as Ledger;
    const spent = l.entries.reduce((s, e) => s + (e.chargedMicros ?? 0), 0);
    const reqs = l.entries.reduce((s, e) => s + e.requests, 0);
    expect(plan.remaining).toMatchObject({ invocations: 2, requests: 28, reservedMicros: 78_000, fitsCeiling: true });
    expect(plan.remaining.committedNowMicros).toBe(spent);
    expect(plan.remaining.requestsNow).toBe(reqs);
    expect(spent + 78_000).toBeLessThanOrEqual(156_000);
    expect(reqs + 28).toBe(56);
    expect(plan.remaining.committedAfterWorstCaseMicros).toBe(spent + 78_000);
    expect(l.entries.map((e) => e.label)).toEqual(["cmp-3-2-original-rep1", "cmp-3-2-current-rep1"]); // nothing from the remaining two has been run
  });
  it("states the cohort rule: repetition 1 keeps its evaluator, nothing is pooled, repetition 1 cannot be rescored", () => {
    expect(plan.cohorts.pooling).toMatch(/prohibited/);
    for (const phrase of [/Status: two invocations done, two remaining, two evaluator cohorts/, /Evaluator correction/, /Cohorts are never pooled/, /not averaged, summed or compared as one sample/, /comparison tool refuses reports from different evaluators/, /output text of its 28 requests was never saved/, /Cohorts and the decision rule/, /Outputs are now saved/, /fits the existing ceiling and request cap/]) expect(md).toMatch(phrase);
  });
  it("lists only the two remaining commands to run, and marks the finished ones as done", () => {
    const block = md.slice(md.indexOf("## 10. Exact invocation"), md.indexOf("## 11."));
    expect(block).toMatch(/# DONE \(do not rerun\): cmp-3-2-current-rep1, cmp-3-2-original-rep1/);
    expect(block).toContain("--label cmp-3-2-original-rep2");
    expect(block).toContain("--label cmp-3-2-current-rep2");
    expect(block).not.toMatch(/npm run eval:campaigns[^\n]*--label cmp-3-2-(original|current)-rep1 /);
  });
  it("describes where the saved outputs go and how to rescore them offline", () => {
    expect(plan.outputs).toMatchObject({ directory: "docs/eval/outputs", artifactVersion: "campaign-eval-output/1" });
    expect(plan.outputs.rescoring).toMatch(/--rescore/);
  });
});

describe("plan-only checks of the remaining invocations (child processes, every network primitive blocked)", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const dry = (cmd: string) => {
    const args = cmd.replace(/^npm run eval:campaigns -- /, "").replace(/ --yes-spend$/, "").split(" ");
    return spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), ...args], {
      encoding: "utf8", timeout: 90_000,
      env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env" },
    });
  };
  it.each([[0, 1662, 31_500], [1, 2418, 46_500]])("remaining command %i: ready, reserve %i, budget %i, no network, nothing written", (i, reserve, budget) => {
    const ledgerBefore = sha("docs/eval/ledger-cmp-3-2.json");
    const outputsBefore = existsSync("docs/eval/outputs") ? readdirSync("docs/eval/outputs").sort() : [];
    const r = dry(plan.remaining.commands[i]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/14 case\(s\)/);
    expect(r.stdout).toMatch(/repair=0, retries=0, max output 2500 tokens, service tier "default", response storage disabled \(store:false\)/);
    expect(r.stdout).toContain(`budget ${budget} micro-USD`);
    expect(Number(/per-request reserve up to (\d+)/.exec(r.stdout)?.[1])).toBe(reserve);
    expect(r.stdout).toMatch(/committed 9412 of 156000 micro-USD, 28 of 56 requests; this invocation reserves \d+ micro-USD and 14 requests -> may start/);
    expect(r.stdout).toMatch(/Nothing was sent\. No network request was made\./);
    expect(sha("docs/eval/ledger-cmp-3-2.json")).toBe(ledgerBefore); // the ledger is not touched by a dry run
    expect(existsSync("docs/eval/outputs") ? readdirSync("docs/eval/outputs").sort() : []).toEqual(outputsBefore); // and no outputs file is created
  });
  it("the first repetition's invocations are refused if someone tries to rerun them? No: the ledger records them as done, and the remaining count is what is left", () => {
    const l = JSON.parse(readFileSync("docs/eval/ledger-cmp-3-2.json", "utf8")) as Ledger;
    expect(l.entries.filter((e) => e.status === "finished").length).toBe(2);
    expect(l.entries.every((e) => !e.halted)).toBe(true);
  });
});
