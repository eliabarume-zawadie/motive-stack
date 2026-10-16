import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_PASS, type CaseResult, type Dimension, type EvalReport } from "./evaluate.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mark = (n: number) => (n >= DIMENSION_PASS ? pct(n) : `**${pct(n)}**`);

/** Markdown report: scores per case and dimension, aggregate, and a diagnostic of every failed check with its reason. */
export function renderMarkdown(r: EvalReport, baseline?: EvalReport): string {
  const a = r.aggregate;
  const L: string[] = [];
  L.push(`# Campaign quality evaluation: ${r.label}`, "");
  L.push(`Source: ${r.source} | generated ${r.generatedAt}`, "");
  L.push(`**${a.passed} of ${a.total} cases pass** (no hard failure and every dimension at or above ${pct(DIMENSION_PASS)}). ` +
    `Briefs obtained: ${a.generated}/${a.total}. Hard failures: ${a.hardFails}. Mean overall: ${pct(a.meanOverall)}.`, "");
  L.push(`Schema-valid: ${r.cases.filter((c) => c.schemaValid).length}/${a.total}. Quality pass ignoring schema validity: ${r.cases.filter((c) => c.qualityPassed).length}/${a.total}. Not scored (nothing to score): ${r.cases.filter((c) => !c.generated).length} (${r.cases.filter((c) => c.failure === "truncated").length} cut off at the token limit).`, "");
  L.push("Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**", "");

  if (r.run) {
    L.push("## Run", "");
    const id = r.run.identity;
    if (id) L.push(`- Prompt: \`${id.promptVersion}\` (sha256 \`${id.promptSha256.slice(0, 12)}\`)`, `- Output contract: \`${id.schemaVersion}\` (sha256 \`${id.schemaSha256.slice(0, 12)}\`)`);
    if (r.run.evaluator) L.push(`- Evaluator: \`${r.run.evaluator}\``);
    if (r.run.model) L.push(`- Model: ${r.run.model}`);
    if (r.run.params) L.push(`- Parameters: ${Object.entries(r.run.params).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
    if (r.run.note) L.push(`- ${r.run.note}`);
    L.push("");
  }
  L.push("## Scores by case", "");
  L.push(`| Case | ${DIMENSIONS.map((d) => DIMENSION_LABELS[d]).join(" | ")} | Overall | Result |`);
  L.push(`|---|${DIMENSIONS.map(() => "---").join("|")}|---|---|`);
  for (const c of r.cases) {
    L.push(`| ${c.caseId} | ${DIMENSIONS.map((d) => mark(c.scores[d])).join(" | ")} | ${pct(c.overall)} | ${c.hardFail ? "HARD FAIL" : c.passed ? "pass" : "fail"} |`);
  }
  L.push(`| **mean** | ${DIMENSIONS.map((d) => mark(a.meanByDimension[d])).join(" | ")} | ${pct(a.meanOverall)} | ${a.passed}/${a.total} |`, "");

  if (r.cases.every((c) => c.comparable)) {
    const cd = DIMENSIONS.filter((d) => d !== "schemaValidity");
    L.push("## Comparable view (checks both the original and current brief contracts can express)", "");
    L.push("Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.", "");
    L.push(`| Case | ${cd.map((d) => DIMENSION_LABELS[d]).join(" | ")} | Overall | Result |`, `|---|${cd.map(() => "---").join("|")}|---|---|`);
    for (const c of r.cases) L.push(`| ${c.caseId} | ${cd.map((d) => (c.comparable.scores[d] === undefined ? "n/a" : mark(c.comparable.scores[d] as number))).join(" | ")} | ${pct(c.comparable.overall)} | ${c.comparable.hardFail ? "HARD FAIL" : c.comparable.passed ? "pass" : "fail"} |`);
    L.push("");
  }

  if (baseline) {
    const b = baseline.aggregate;
    L.push(`## Change from baseline (${baseline.label})`, "");
    L.push("| Dimension | Baseline | Now | Change |", "|---|---|---|---|");
    for (const d of DIMENSIONS) {
      const delta = a.meanByDimension[d] - b.meanByDimension[d];
      L.push(`| ${DIMENSION_LABELS[d]} | ${pct(b.meanByDimension[d])} | ${pct(a.meanByDimension[d])} | ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)} pts |`);
    }
    L.push(`| **Cases passing** | ${b.passed}/${b.total} | ${a.passed}/${a.total} | ${a.passed - b.passed >= 0 ? "+" : ""}${a.passed - b.passed} |`);
    L.push(`| **Hard failures** | ${b.hardFails} | ${a.hardFails} | ${a.hardFails - b.hardFails >= 0 ? "+" : ""}${a.hardFails - b.hardFails} |`, "");
  }

  const live = r.cases.filter((c) => c.meta && (c.meta.latencyMs !== undefined || c.meta.inputTokens !== undefined));
  if (live.length) {
    L.push("## Provider usage for this run", "");
    L.push("| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |", "|---|---|---|---|---|---|");
    for (const c of live) {
      const m = c.meta!;
      L.push(`| ${c.caseId} | ${m.model ?? ""} | ${m.latencyMs ?? "?"} ms | ${m.inputTokens ?? "unknown"}/${m.outputTokens ?? "unknown"} | ${m.attempts ?? "?"} | ${m.costMicros === undefined || m.costMicros === null ? "unknown" : `${m.costMicros} micro-USD`} |`);
    }
    L.push("");
  }

  L.push("## Diagnostics: what failed and why", "");
  const failing = r.cases.filter((c) => !c.passed);
  if (failing.length === 0) L.push("Every case passed every check.", "");
  for (const c of failing) {
    L.push(`### ${c.caseId}${c.hardFail ? " (HARD FAIL)" : ""}`, "", `_${c.title}_`, "");
    if (!c.generated) { L.push(`- **No brief obtained${c.failure === "truncated" ? " (cut off at the token limit; billed, but nothing to score)" : ""}:** ${c.generationError}${c.meta?.costNote ? ` | cost: ${c.meta.costNote}` : ""}`, ""); continue; }
    const low = DIMENSIONS.filter((d) => c.scores[d] < DIMENSION_PASS);
    if (low.length) L.push(`Below the pass line: ${low.map((d) => `${DIMENSION_LABELS[d]} (${pct(c.scores[d])})`).join(", ")}`, "");
    for (const k of c.checks.filter((x) => !x.pass)) L.push(`- ${k.hard ? "**HARD** " : ""}[${DIMENSION_LABELS[k.dimension as Dimension]}] \`${k.id}\`: ${k.detail}`);
    L.push("");
  }

  L.push("## Limits of this evaluation", "");
  L.push(
    "- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.",
    "- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.",
    "- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.",
    "- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.",
    "- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.",
    "",
  );
  return L.join("\n");
}

export function renderConsole(r: EvalReport): string {
  const a = r.aggregate;
  const rows = r.cases.map((c: CaseResult) => `  ${c.passed ? "PASS" : c.hardFail ? "HARD" : "FAIL"}  ${c.caseId.padEnd(38)} overall ${pct(c.overall).padStart(4)}  ` + DIMENSIONS.map((d) => `${DIMENSION_LABELS[d].split(" ")[0]?.slice(0, 5)}:${pct(c.scores[d])}`).join(" "));
  return [`${r.label} [${r.source}]: ${a.passed}/${a.total} pass, ${a.hardFails} hard fail, mean ${pct(a.meanOverall)}`, ...rows].join("\n");
}

/**
 * Side-by-side of two runs over the SAME cases (for example the original and the current prompt on one model). Uses the comparable view
 * only, and states what the comparison cannot show.
 */
export function renderComparison(a: EvalReport, b: EvalReport, names: { a: string; b: string }): string {
  const cd = DIMENSIONS.filter((d) => d !== "schemaValidity");
  for (const [n, r] of [[names.a, a], [names.b, b]] as const) {
    if (r.cases.some((c) => !c.comparable)) throw new Error(`report "${n}" predates the comparable view (Milestone 3.1) and cannot be compared fairly; re-run it with the current harness`);
  }
  const L: string[] = [`# Comparison:${names.a} vs ${names.b}`, ""];
  for (const [n, r] of [[names.a, a], [names.b, b]] as const) {
    const id = r.run?.identity;
    L.push(`- **${n}**: ${r.source}${id ? ` | prompt \`${id.promptVersion}\`, contract \`${id.schemaVersion}\`` : ""}${r.run?.model ? ` | ${r.run.model}` : ""}`);
  }
  L.push("", "Scored on the comparable view only (checks both contracts can express), against the same fixture ground truth. Schema validity and unscorable cases are listed separately.", "");
  L.push(`| Case | ${names.a} overall | ${names.b} overall | ${cd.map((d) => DIMENSION_LABELS[d].split(" ")[0] + " (" + names.a.slice(0, 3) + "/" + names.b.slice(0, 3) + ")").join(" | ")} | Hard fail (${names.a}/${names.b}) | Schema valid (${names.a}/${names.b}) |`);
  L.push(`|---|---|---|${cd.map(() => "---").join("|")}|---|---|`);
  const bid = new Map(b.cases.map((c) => [c.caseId, c]));
  let wins = 0, losses = 0, ties = 0;
  for (const ca of a.cases) {
    const cb = bid.get(ca.caseId);
    if (!cb) continue;
    const d = cb.comparable.overall - ca.comparable.overall;
    if (Math.abs(d) < 0.005) ties++; else if (d > 0) wins++; else losses++;
    const f = (c: CaseResult, dim: Dimension) => (c.comparable.scores[dim] === undefined ? "n/a" : pct(c.comparable.scores[dim] as number));
    L.push(`| ${ca.caseId} | ${ca.generated ? pct(ca.comparable.overall) : "no brief"} | ${cb.generated ? pct(cb.comparable.overall) : "no brief"} | ${cd.map((dim) => `${f(ca, dim)} / ${f(cb, dim)}`).join(" | ")} | ${ca.comparable.hardFail ? "yes" : "no"} / ${cb.comparable.hardFail ? "yes" : "no"} | ${ca.schemaValid ? "yes" : "no"} / ${cb.schemaValid ? "yes" : "no"} |`);
  }
  L.push("", `Cases where ${names.b} scored higher: ${wins}; lower: ${losses}; equal: ${ties}.`, "");
  L.push("## What this comparison cannot show", "",
    "- Three to a dozen synthetic cases are an indication, not statistical evidence. Do not report a win as proof of improvement.",
    "- Model output varies from run to run; one run per case says little about consistency.",
    "- The comparable view omits what the original contract cannot express (reasoning fields, differentiator decisions, review flags), which are a real product difference this comparison does not credit.",
    "- The original arm saw only the Business Brain fields the original system had. That is faithful to the original, and also means it could not be told about facts the current Business Brain can carry.",
    "- Automated checks are heuristics (see docs/campaign-evaluation.md).", "");
  return L.join("\n");
}
