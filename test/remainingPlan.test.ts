import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EVALUATOR_VERSION } from "../src/eval/evaluate.js";
import type { Ledger } from "../src/eval/ledger.js";

const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
const md = readFileSync("docs/eval/plan-original-vs-current.md", "utf8");
const REAL_LEDGER = "docs/eval/ledger-cmp-3-2.json";
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const flag = (c: string, f: string) => new RegExp(`--${f} (\\S+)`).exec(c)?.[1];
const labelOf = (c: string) => flag(c, "label")!;
const realLedger = (): Ledger => JSON.parse(readFileSync(REAL_LEDGER, "utf8")) as Ledger;

/** All four planned invocations, in order, as the plan document lists them (remaining + already done). */
const ALL_LABELS = ["cmp-3-2-original-rep1", "cmp-3-2-current-rep1", "cmp-3-2-original-rep2", "cmp-3-2-current-rep2"];
const BUDGETS: Record<string, number> = { "cmp-3-2-original-rep2": 31_500, "cmp-3-2-current-rep2": 46_500 };

describe("the plan for the remaining invocations (derived from whatever the real ledger holds)", () => {
  const ledger = realLedger();
  const finished = ledger.entries.filter((e) => e.status === "finished").map((e) => e.label);
  const remaining = plan.remaining.commands as string[];

  it("uses the corrected evaluator for repetition 2, and names the previous one for repetition 1", () => {
    expect(plan.evaluator).toBe(EVALUATOR_VERSION);
    expect(EVALUATOR_VERSION).toBe("campaign-evaluator/3.3.0");
    expect(plan.identifiers.evaluator).toBe(EVALUATOR_VERSION);
    expect(plan.cohorts.A).toMatchObject({ evaluator: "campaign-evaluator/3.2.0", invocations: ["cmp-3-2-current-rep1", "cmp-3-2-original-rep1"] });
    expect(plan.cohorts.B).toMatchObject({ evaluator: "campaign-evaluator/3.3.0", invocations: ["cmp-3-2-current-rep2", "cmp-3-2-original-rep2"] });
  });
  it("lists exactly the planned invocations the ledger has not finished, and never a finished one", () => {
    expect(remaining.map(labelOf)).toEqual(ALL_LABELS.filter((l) => !finished.includes(l)));
    for (const l of finished) expect(remaining.map(labelOf)).not.toContain(l);
    expect(ledger.entries.filter((e) => ALL_LABELS.includes(e.label)).length).toBe(ledger.entries.length); // nothing foreign in the ledger
  });
  it("keeps every approved setting on each remaining command", () => {
    for (const c of remaining) {
      expect(flag(c, "models")).toBe("openai/gpt-6-luna");
      expect(flag(c, "max-output")).toBe("2500");
      expect(flag(c, "repair")).toBe("0");
      expect(flag(c, "retries")).toBe("0");
      expect(flag(c, "ledger")).toBe(REAL_LEDGER);
      expect(flag(c, "aggregate-ceiling-micros")).toBe("156000");
      expect(flag(c, "max-total-requests")).toBe("56");
      expect(c).not.toMatch(/--cases|--check-access/);
      expect(c).toMatch(/--yes-spend$/);
      if (labelOf(c) in BUDGETS) expect(flag(c, "budget-micros")).toBe(String(BUDGETS[labelOf(c)]));
    }
    expect(plan.approvedSettings).toMatchObject({ model: "gpt-6-luna", cases: 14, plannedGenerations: 56, maxOutputTokens: 2500, maxAggregateSpendMicros: 156000, retries: 0, repairs: 0, serviceTier: "default", responseStorage: "disabled (store:false)" });
  });
  it("recomputes budget and request totals from the real ledger and fits the ceiling and the cap", () => {
    const spent = ledger.entries.reduce((s, e) => s + (e.chargedMicros ?? 0), 0);
    const reqs = ledger.entries.reduce((s, e) => s + e.requests, 0);
    const reserve = remaining.reduce((s, c) => s + Number(flag(c, "budget-micros")), 0);
    expect(plan.remaining).toMatchObject({ invocations: remaining.length, requests: remaining.length * 14, reservedMicros: reserve, committedNowMicros: spent, requestsNow: reqs, committedAfterWorstCaseMicros: spent + reserve, requestsAfter: reqs + remaining.length * 14, fitsCeiling: true });
    expect(spent + reserve).toBeLessThanOrEqual(156_000);
    expect(reqs + remaining.length * 14).toBeLessThanOrEqual(56);
  });
  it("preserves the history recorded so far: the first entries are the rep-1 invocations with their recorded charges", () => {
    const by = Object.fromEntries(ledger.entries.map((e) => [e.label, e]));
    expect(by["cmp-3-2-original-rep1"]).toMatchObject({ status: "finished", requests: 14, chargedMicros: 2122 });
    expect(by["cmp-3-2-current-rep1"]).toMatchObject({ status: "finished", requests: 14, chargedMicros: 7290 });
    if (by["cmp-3-2-original-rep2"]) expect(by["cmp-3-2-original-rep2"]).toMatchObject({ status: "finished", requests: 14, chargedMicros: 2133 });
    expect(ledger.entries.every((e) => !e.halted)).toBe(true); // a halted entry would need a recorded reconciliation before the plan is runnable
  });
  it("states the cohort rule in the document", () => {
    expect(plan.cohorts.pooling).toMatch(/prohibited/);
    for (const phrase of [/Status: \d+ invocation\(s\) done, \d+ remaining, two evaluator cohorts/, /Evaluator correction/, /Cohorts are never pooled/, /not averaged, summed or compared as one sample/, /comparison tool refuses reports from different evaluators/, /output text of its 28 requests was never saved/, /Cohorts and the decision rule/, /Outputs are now saved/, /fits the existing ceiling and request cap/]) expect(md).toMatch(phrase);
  });
  it("lists only the remaining commands to run and marks the finished ones as done", () => {
    const block = md.slice(md.indexOf("## 10. Exact invocation"), md.indexOf("## 11."));
    for (const l of finished) {
      expect(block).toContain(l); // named in the DONE line
      expect(block).not.toMatch(new RegExp(`npm run eval:campaigns[^\\n]*--label ${l} `));
    }
    expect(block).toMatch(/# DONE \(do not rerun\):/);
    for (const c of remaining) expect(block).toContain(`--label ${labelOf(c)}`);
  });
  it("when every planned invocation is recorded, shows none remaining, the request cap used, the spend, per-invocation evaluators and the unresolved billing status", () => {
    if (finished.length !== ALL_LABELS.length) return; // only applies once the campaign is complete
    expect(ledger.entries.reduce((s, e) => s + e.requests, 0)).toBe(56);
    expect(plan.remaining).toMatchObject({ invocations: 0, requests: 0, reservedMicros: 0, requestsAfter: 56, fitsCeiling: true, commands: [] });
    expect(plan.remaining.committedNowMicros).toBe(19_098);
    expect(md).toMatch(/Status: 4 invocation\(s\) done, 0 remaining/);
    expect(md).toMatch(/136902 µUSD of the aggregate ceiling and 0 of 56 requests remain/);
    expect(md).toMatch(/no planned invocation remains and the request cap is used/);
    for (const l of ALL_LABELS) expect(md).toMatch(new RegExp(`\`${l}\` \\| DONE, 14 requests, \\d+ µUSD recorded \\| campaign-evaluator/3\\.[23]\\.0 \\| [AB]`));
    expect(md).toMatch(/\*\*Billing is unresolved\.\*\*/);
    expect(md).not.toMatch(/billing (has been|is) reconciled(?!\.)/i);
  });
  it("describes where the saved outputs go and how to rescore them offline", () => {
    expect(plan.outputs).toMatchObject({ directory: "docs/eval/outputs", artifactVersion: "campaign-eval-output/1" });
    expect(plan.outputs.rescoring).toMatch(/--rescore/);
  });
});

describe("plan-only checks on seeded ledgers (child processes, every network primitive blocked, real ledger never touched)", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const dir = mkdtempSync(join(tmpdir(), "ms-remaining-plan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const real = realLedger();
  const entry = (label: string) => structuredClone(real.entries.find((e) => e.label === label)!);
  const seeded = (name: string, entries: Ledger["entries"], patch: Partial<Ledger> = {}): string => {
    const p = join(dir, `${name}.json`);
    writeFileSync(p, JSON.stringify({ ...structuredClone(real), ...patch, entries }, null, 2));
    return p;
  };
  const commandFor = (label: string): string => {
    const b = BUDGETS[label]!;
    const prompt = label.includes("original") ? "original" : "current";
    return `--models openai/gpt-6-luna --max-output 2500 --repair 0 --retries 0 --ledger LEDGER --aggregate-ceiling-micros 156000 --max-total-requests 56 --prompt ${prompt} --budget-micros ${b} --label ${label}`;
  };
  /** Always without --yes-spend: a plan-only run can neither send nor write. */
  const dry = (label: string, ledgerPath: string) => {
    return spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), ...commandFor(label).replace("LEDGER", ledgerPath).split(" ")], {
      encoding: "utf8", timeout: 90_000,
      env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env" },
    });
  };
  const outputsList = () => (existsSync("docs/eval/outputs") ? readdirSync("docs/eval/outputs").sort() : []);

  it("with only repetition 1 recorded, original-rep2 may start (reserve 1662, budget 31500, 28 of 56 requests used)", () => {
    const l = seeded("rep1-only", [entry("cmp-3-2-original-rep1"), entry("cmp-3-2-current-rep1")]);
    const before = sha(l), realBefore = sha(REAL_LEDGER), outs = outputsList();
    const r = dry("cmp-3-2-original-rep2", l);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/14 case\(s\)/);
    expect(r.stdout).toMatch(/repair=0, retries=0, max output 2500 tokens, service tier "default", response storage disabled \(store:false\)/);
    expect(r.stdout).toContain("budget 31500 micro-USD");
    expect(Number(/per-request reserve up to (\d+)/.exec(r.stdout)?.[1])).toBe(1662);
    expect(r.stdout).toMatch(/committed 9412 of 156000 micro-USD, 28 of 56 requests; this invocation reserves 31500 micro-USD and 14 requests -> may start/);
    expect(r.stdout).toMatch(/Nothing was sent\. No network request was made\./);
    expect(sha(l)).toBe(before);
    expect(sha(REAL_LEDGER)).toBe(realBefore);
    expect(outputsList()).toEqual(outs);
  });
  it("with original-rep2 recorded as finished, current-rep2 may start and the earlier entries and spend are counted", () => {
    const l = seeded("rep1-and-orig2", [entry("cmp-3-2-original-rep1"), entry("cmp-3-2-current-rep1"), entry("cmp-3-2-original-rep2")]);
    const before = sha(l), realBefore = sha(REAL_LEDGER);
    const r = dry("cmp-3-2-current-rep2", l);
    expect(r.status, r.stderr).toBe(0);
    expect(Number(/per-request reserve up to (\d+)/.exec(r.stdout)?.[1])).toBe(2418);
    expect(r.stdout).toMatch(/committed 11545 of 156000 micro-USD, 42 of 56 requests; this invocation reserves 46500 micro-USD and 14 requests -> may start/);
    expect(r.stdout).toMatch(/No network request was made\./);
    expect(sha(l)).toBe(before);
    expect(sha(REAL_LEDGER)).toBe(realBefore);
  });
  it("an unreconciled halted invocation blocks the next one, naming the halted label", () => {
    const halted = { ...entry("cmp-3-2-original-rep1"), halted: "unexpected service tier (seeded for this test)" };
    const l = seeded("halted", [halted, entry("cmp-3-2-current-rep1")]);
    const r = dry("cmp-3-2-original-rep2", l);
    expect(r.stdout).toMatch(/REFUSED: an earlier invocation \("cmp-3-2-original-rep1"\) halted: unexpected service tier/);
    expect(r.stdout).toMatch(/reconcile/);
    expect(r.stdout).not.toMatch(/may start/);
  });
  it("a reconciled halt (with its note) no longer blocks, but its charge stays counted", () => {
    const halted = { ...entry("cmp-3-2-original-rep1"), halted: "seeded", reconciled: { note: "reviewed in a test", at: "2026-10-19T00:00:00.000Z" } };
    const l = seeded("reconciled", [halted, entry("cmp-3-2-current-rep1")]);
    const r = dry("cmp-3-2-original-rep2", l);
    expect(r.stdout).toMatch(/committed 9412 of 156000 micro-USD, 28 of 56 requests; .* -> may start/);
  });
  it("an invocation that never finished (crash) blocks the next one and is counted at its full reserve", () => {
    const crashed = { ...entry("cmp-3-2-original-rep1"), status: "started" as const };
    delete (crashed as { finishedAt?: string }).finishedAt;
    const l = seeded("crashed", [crashed, entry("cmp-3-2-current-rep1")]);
    const r = dry("cmp-3-2-original-rep2", l);
    expect(r.stdout).toMatch(/REFUSED: an earlier invocation \("cmp-3-2-original-rep1"\) never finished/);
    expect(r.stdout).not.toMatch(/may start/);
  });
  it("cannot exceed the aggregate ceiling: committed spend that leaves too little room refuses the invocation", () => {
    const e = entry("cmp-3-2-original-rep1");
    e.chargedMicros = 156_000 - 31_499; // one micro-USD short of room for the 31,500 reserve
    const l = seeded("ceiling", [e]);
    const r = dry("cmp-3-2-original-rep2", l);
    expect(r.stdout).toMatch(/REFUSED: committed \d+ \+ this invocation's reserve 31500 would pass the aggregate ceiling of 156000/);
    e.chargedMicros = 156_000 - 31_500; // exactly enough room is allowed
    const ok = dry("cmp-3-2-original-rep2", seeded("ceiling-exact", [e]));
    expect(ok.stdout).toMatch(/-> may start/);
  });
  it("cannot exceed the request cap: 43 recorded requests + 14 planned would pass 56", () => {
    const e = entry("cmp-3-2-original-rep1");
    e.requests = 43;
    const r = dry("cmp-3-2-original-rep2", seeded("cap", [e]));
    expect(r.stdout).toMatch(/REFUSED: 43 requests recorded \+ 14 planned would pass the cap of 56/);
    e.requests = 42;
    expect(dry("cmp-3-2-original-rep2", seeded("cap-exact", [e])).stdout).toMatch(/-> may start/);
  });
  it("the real ledger and the outputs directory are byte-identical after every plan-only run above", () => {
    const l = seeded("rep1-only-2", [entry("cmp-3-2-original-rep1"), entry("cmp-3-2-current-rep1")]);
    const realBefore = sha(REAL_LEDGER), outs = outputsList();
    dry("cmp-3-2-original-rep2", l);
    expect(sha(REAL_LEDGER)).toBe(realBefore);
    expect(outputsList()).toEqual(outs);
  });
});
