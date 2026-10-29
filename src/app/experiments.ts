import { z } from "zod";
import { getCampaignRow } from "./campaigns.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { newId } from "./util.js";
import { assertQuota } from "./quotas.js";
import type { AppContext } from "./context.js";

/**
 * Experiments. A plan (hypothesis, ONE principal variable, audience and placement, variants pinned to exact versions, success metric, duration, minimum data and a decision
 * rule written before the data) that a person starts and later concludes. What this file never does:
 *  - measure performance: results are entered or imported by people and labelled with their source; synthetic numbers are labelled synthetic and never support a conclusion;
 *  - change spend, edit a campaign, switch a creative or publish anything: concluding records a decision and nothing else;
 *  - claim statistical significance. A two-proportion test is shown only when its conditions hold, as INDICATIVE, because the app cannot verify how people were assigned to
 *    variants or that they saw them equally.
 */
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, "That is not a real date");
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");
const ID = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const PRINCIPAL_VARIABLES = ["headline", "primary_text", "call_to_action", "creative_image", "audience", "placement", "offer", "other"] as const;
export const SUCCESS_METRICS = ["lead_count", "qualified_rate", "won_rate", "cost_per_lead", "click_through_rate", "conversion_rate", "other"] as const;
export const METRIC_LABEL: Record<(typeof SUCCESS_METRICS)[number], string> = {
  lead_count: "Number of leads", qualified_rate: "Share of leads qualified or won", won_rate: "Share of leads won", cost_per_lead: "Cost per lead", click_through_rate: "Click-through rate", conversion_rate: "Conversion rate", other: "Other",
};
/** Metrics the app can compute from lead records. The rest only exist if a person enters or imports them. */
const FROM_LEADS: ReadonlySet<string> = new Set(["lead_count", "qualified_rate", "won_rate"]);
const RATE_FROM_LEADS: ReadonlySet<string> = new Set(["qualified_rate", "won_rate"]);

const VariantSchema = z.object({
  label: text(40), role: z.enum(["control", "variant"]), description: text(300),
  campaignId: ID.optional(), campaignVersion: z.number().int().min(1).optional(), creativeId: ID.optional(), creativeVersion: z.number().int().min(1).optional(),
}).strict();
const PlanFields = {
  name: text(100), hypothesis: text(400), principalVariable: z.enum(PRINCIPAL_VARIABLES), variableNote: text(300), audienceNote: text(300), placementNote: text(300),
  successMetric: z.enum(SUCCESS_METRICS), durationDays: z.number().int().min(1).max(365), minSample: z.number().int().min(1).max(1_000_000), decisionRule: text(400),
  variants: z.array(VariantSchema).min(2).max(4),
};
export const ExperimentPlanSchema = z.object(PlanFields).strict();
export const UsageSchema = z.object({ variantId: ID, usedFrom: DATE, usedTo: DATE.optional(), note: text(300) }).strict();
export const ObservationSchema = z.object({
  variantId: ID, metric: z.enum(SUCCESS_METRICS), successes: z.number().int().min(0).max(1_000_000_000).optional(), trials: z.number().int().min(1).max(1_000_000_000).optional(), value: z.number().finite().optional(),
  sourceType: z.enum(["user_entered", "imported", "synthetic"]), sourceNote: text(300), observedOn: DATE,
}).strict().refine((o) => (o.successes !== undefined && o.trials !== undefined && o.successes <= o.trials && o.value === undefined) || (o.successes === undefined && o.trials === undefined && o.value !== undefined), { message: "Enter either successes out of trials (successes cannot exceed trials) or a plain value" });
export const ConcludeSchema = z.object({ outcome: z.enum(["variant_better", "control_better", "inconclusive"]), rationale: text(600), acknowledgeWarnings: z.boolean().optional() }).strict();
export const AbandonSchema = z.object({ reason: text(300) }).strict();

interface ExpRow {
  id: string; name: string; status: "draft" | "running" | "concluded" | "abandoned"; hypothesis: string; principal_variable: (typeof PRINCIPAL_VARIABLES)[number]; variable_note: string; audience_note: string; placement_note: string;
  success_metric: (typeof SUCCESS_METRICS)[number]; duration_days: number; min_sample: number; decision_rule: string; created_at: string; created_by: string; started_at: string | null; started_by: string | null;
  concluded_at: string | null; concluded_by: string | null; outcome: string | null; outcome_rationale: string | null; warnings_at_conclusion: string | null;
}
interface VarRow { id: string; label: string; role: "control" | "variant"; description: string; campaign_id: string | null; campaign_version: number | null; creative_id: string | null; creative_version: number | null }
const getExp = (c: Core, wsId: string, id: string): ExpRow => {
  const r = c.db.prepare("SELECT * FROM experiments WHERE id = ? AND workspace_id = ?").get(id, wsId) as ExpRow | undefined;
  if (!r) throw notFound("Experiment");
  return r;
};
const variantsOf = (c: Core, wsId: string, id: string) => c.db.prepare("SELECT * FROM experiment_variants WHERE experiment_id = ? AND workspace_id = ? ORDER BY (role = 'control') DESC, label").all(id, wsId) as VarRow[];

/** Checks that every variant names real, versioned things in this workspace, and that the comparison is a comparison. */
function resolveVariants(c: Core, wsId: string, plan: z.infer<typeof ExperimentPlanSchema>) {
  const controls = plan.variants.filter((v) => v.role === "control");
  if (controls.length !== 1) throw new AppError(400, "one_control_required", "An experiment needs exactly one control: the version you compare against");
  if (new Set(plan.variants.map((v) => v.label.toLowerCase())).size !== plan.variants.length) throw new AppError(400, "duplicate_label", "Each variant needs its own label");
  const out = plan.variants.map((v) => {
    if (!v.campaignId && !v.creativeId) throw new AppError(400, "variant_needs_reference", `“${v.label}” must name a campaign version or a creative version, so the comparison stays reproducible`);
    let campaignId = v.campaignId ?? null, campaignVersion = v.campaignVersion ?? null, creativeId = v.creativeId ?? null, creativeVersion = v.creativeVersion ?? null;
    if (creativeId) {
      const cr = c.db.prepare("SELECT campaign_id, current_version FROM creatives WHERE id = ? AND workspace_id = ?").get(creativeId, wsId) as { campaign_id: string; current_version: number } | undefined;
      if (!cr) throw notFound("Creative");
      if (campaignId && campaignId !== cr.campaign_id) throw new AppError(400, "creative_not_in_campaign", `“${v.label}”: that creative belongs to a different campaign`);
      campaignId = cr.campaign_id;
      creativeVersion = creativeVersion ?? cr.current_version;
      if (!c.db.prepare("SELECT 1 FROM creative_versions WHERE creative_id = ? AND version = ? AND workspace_id = ?").get(creativeId, creativeVersion, wsId)) throw notFound("Creative version");
    }
    if (campaignId) {
      const camp = getCampaignRow(c, wsId, campaignId);
      campaignVersion = campaignVersion ?? (creativeId ? null : camp.current_version);
      if (campaignVersion !== null && !c.db.prepare("SELECT 1 FROM campaign_versions WHERE campaign_id = ? AND version = ? AND workspace_id = ?").get(campaignId, campaignVersion, wsId)) throw notFound("Campaign version");
    }
    return { ...v, campaignId, campaignVersion, creativeId, creativeVersion };
  });
  const refKey = (v: (typeof out)[number]) => `${v.campaignId}|${v.campaignVersion}|${v.creativeId}|${v.creativeVersion}`;
  if (new Set(out.map(refKey)).size !== out.length) throw new AppError(400, "identical_variants", "Two variants point at exactly the same version, so there is nothing to compare");
  if (plan.principalVariable === "creative_image" && out.some((v) => !v.creativeId)) throw new AppError(400, "creative_required", "When the principal variable is the creative image, every variant must name a creative version");
  return out;
}

/** Things a reviewer should know about the DESIGN. They do not block: the app cannot judge them, only say what it can see. */
function designWarnings(plan: { principalVariable: string }, vars: VarRow[]): string[] {
  const w: string[] = [];
  if (new Set(vars.map((v) => v.campaign_id).filter(Boolean)).size > 1) w.push("The variants belong to different campaigns, which usually differ in more than one way. This is not a single-variable test unless the campaigns are otherwise the same.");
  if (["audience", "placement", "offer", "other"].includes(plan.principalVariable)) w.push("The app cannot check that only the principal variable differs for this kind of change. It relies on the note you wrote.");
  if (vars.length > 2) w.push("With more than two variants the app shows each one's data but cannot compare them statistically.");
  return w;
}

export function createExperiment(c: AppContext, wsId: string, actor: string, input: unknown) {
  const plan = ExperimentPlanSchema.parse(input);
  const vars = resolveVariants(c, wsId, plan);
  assertQuota(c, wsId, "experiments");
  const id = newId("exp");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO experiments (id, workspace_id, name, status, hypothesis, principal_variable, variable_note, audience_note, placement_note, success_metric, duration_days, min_sample, decision_rule, created_at, created_by)
                  VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`).run(id, wsId, plan.name, plan.hypothesis, plan.principalVariable, plan.variableNote, plan.audienceNote, plan.placementNote, plan.successMetric, plan.durationDays, plan.minSample, plan.decisionRule, iso(c), actor);
    for (const v of vars) c.db.prepare("INSERT INTO experiment_variants (id, experiment_id, workspace_id, label, role, description, campaign_id, campaign_version, creative_id, creative_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(newId("var"), id, wsId, v.label, v.role, v.description, v.campaignId, v.campaignVersion, v.creativeId, v.creativeVersion, iso(c));
    audit(c, wsId, actor, "experiment.created", "experiment", id, { principalVariable: plan.principalVariable, successMetric: plan.successMetric, variants: vars.length });
  })();
  return experimentView(c, wsId, id);
}

/** A draft plan can be replaced. Once started, the plan is frozen: the hypothesis, variants and decision rule cannot be changed to suit the data. */
export function replaceDraftPlan(c: Core, wsId: string, actor: string, id: string, input: unknown) {
  const plan = ExperimentPlanSchema.parse(input);
  const e = getExp(c, wsId, id);
  if (e.status !== "draft") throw conflict("plan_locked", `This experiment is ${e.status}. Its plan is frozen so it cannot be changed to suit the data. Start a new experiment instead.`);
  const vars = resolveVariants(c, wsId, plan);
  c.db.transaction(() => {
    c.db.prepare(`UPDATE experiments SET name = ?, hypothesis = ?, principal_variable = ?, variable_note = ?, audience_note = ?, placement_note = ?, success_metric = ?, duration_days = ?, min_sample = ?, decision_rule = ? WHERE id = ? AND workspace_id = ?`)
      .run(plan.name, plan.hypothesis, plan.principalVariable, plan.variableNote, plan.audienceNote, plan.placementNote, plan.successMetric, plan.durationDays, plan.minSample, plan.decisionRule, id, wsId);
    c.db.prepare("DELETE FROM experiment_variants WHERE experiment_id = ? AND workspace_id = ?").run(id, wsId);
    for (const v of vars) c.db.prepare("INSERT INTO experiment_variants (id, experiment_id, workspace_id, label, role, description, campaign_id, campaign_version, creative_id, creative_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(newId("var"), id, wsId, v.label, v.role, v.description, v.campaignId, v.campaignVersion, v.creativeId, v.creativeVersion, iso(c));
    audit(c, wsId, actor, "experiment.plan_replaced", "experiment", id, { variants: vars.length });
  })();
  return experimentView(c, wsId, id);
}

export function startExperiment(c: Core, wsId: string, actor: string, id: string) {
  const e = getExp(c, wsId, id);
  if (e.status !== "draft") throw conflict("not_draft", `This experiment is ${e.status}`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE experiments SET status = 'running', started_at = ?, started_by = ? WHERE id = ? AND workspace_id = ? AND status = 'draft'").run(iso(c), actor, id, wsId);
    audit(c, wsId, actor, "experiment.started", "experiment", id, { plannedDays: e.duration_days, minSample: e.min_sample });
  })();
  return experimentView(c, wsId, id);
}

export function recordUsage(c: Core, wsId: string, actor: string, id: string, input: unknown) {
  const b = UsageSchema.parse(input);
  const e = getExp(c, wsId, id);
  if (e.status !== "running") throw conflict("not_running", "Use is recorded while the experiment is running");
  if (!c.db.prepare("SELECT 1 FROM experiment_variants WHERE id = ? AND experiment_id = ? AND workspace_id = ?").get(b.variantId, id, wsId)) throw notFound("Variant");
  if (b.usedTo && b.usedTo < b.usedFrom) throw new AppError(400, "bad_range", "The end date is before the start date");
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO experiment_usage (id, experiment_id, variant_id, workspace_id, used_from, used_to, note, recorded_by, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(newId("use"), id, b.variantId, wsId, b.usedFrom, b.usedTo ?? null, b.note, actor, iso(c));
    audit(c, wsId, actor, "experiment.usage_recorded", "experiment", id, { variantId: b.variantId, usedFrom: b.usedFrom });
  })();
  return experimentView(c, wsId, id);
}

export function recordObservation(c: Core, wsId: string, actor: string, id: string, input: unknown) {
  const b = ObservationSchema.parse(input);
  const e = getExp(c, wsId, id);
  if (e.status !== "running") throw conflict("not_running", "Results are recorded while the experiment is running");
  if (!c.db.prepare("SELECT 1 FROM experiment_variants WHERE id = ? AND experiment_id = ? AND workspace_id = ?").get(b.variantId, id, wsId)) throw notFound("Variant");
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO experiment_observations (id, experiment_id, variant_id, workspace_id, metric, successes, trials, value, source_type, source_note, observed_on, recorded_by, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(newId("obs"), id, b.variantId, wsId, b.metric, b.successes ?? null, b.trials ?? null, b.value ?? null, b.sourceType, b.sourceNote, b.observedOn, actor, iso(c));
    audit(c, wsId, actor, "experiment.observation_recorded", "experiment", id, { variantId: b.variantId, metric: b.metric, sourceType: b.sourceType });
  })();
  return experimentView(c, wsId, id);
}

/* ------------------------------------------------------------------------------------------------ analysis */

const normalCdf = (z: number): number => {
  // Abramowitz and Stegun 7.1.26 via the error function; accurate to about 1e-7, which is far finer than the data deserves
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
};
/** Two-sided pooled two-proportion z-test. Returns null when the normal approximation is not valid (any of the four cells under 5). */
export function twoProportionTest(a: { successes: number; trials: number }, b: { successes: number; trials: number }): { z: number; p: number } | null {
  const cells = [a.successes, a.trials - a.successes, b.successes, b.trials - b.successes];
  if (a.trials < 1 || b.trials < 1 || cells.some((x) => x < 5)) return null;
  const pool = (a.successes + b.successes) / (a.trials + b.trials);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.trials + 1 / b.trials));
  if (se === 0) return null;
  const z = (b.successes / b.trials - a.successes / a.trials) / se;
  return { z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

export interface Warning { code: string; severity: "blocking" | "caution"; message: string }

export function experimentAnalysis(c: Core, wsId: string, id: string) {
  const e = getExp(c, wsId, id);
  const vars = variantsOf(c, wsId, id);
  const warnings: Warning[] = [];
  const now = c.now().getTime();
  const plannedEnd = e.started_at ? new Date(Date.parse(e.started_at) + e.duration_days * 86400000).toISOString() : null;
  const durationReached = e.started_at ? now >= Date.parse(plannedEnd!) : null;

  const perVariant = vars.map((v) => {
    const where = ["workspace_id = ?"]; const args: Array<string | number> = [wsId];
    if (v.campaign_id) { where.push("campaign_id = ?"); args.push(v.campaign_id); }
    if (v.campaign_version !== null) { where.push("campaign_version = ?"); args.push(v.campaign_version); }
    if (v.creative_id) { where.push("creative_id = ?", "creative_version = ?"); args.push(v.creative_id, v.creative_version ?? -1); }
    const rows = c.db.prepare(`SELECT origin, status, COUNT(*) n FROM leads WHERE ${where.join(" AND ")} GROUP BY origin, status`).all(...args) as Array<{ origin: string; status: string; n: number }>;
    const byOrigin: Record<string, number> = { synthetic: 0, imported: 0, real: 0, unknown: 0 };
    for (const r of rows) byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + r.n;
    const countable = rows.filter((r) => r.origin === "imported" || r.origin === "real");
    const leadSample = countable.reduce((a, r) => a + r.n, 0);
    const qualified = countable.filter((r) => r.status === "qualified" || r.status === "won").reduce((a, r) => a + r.n, 0);
    const won = countable.filter((r) => r.status === "won").reduce((a, r) => a + r.n, 0);
    const unversioned = v.campaign_id && v.campaign_version !== null ? (c.db.prepare("SELECT COUNT(*) n FROM leads WHERE workspace_id = ? AND campaign_id = ? AND campaign_version IS NULL").get(wsId, v.campaign_id) as { n: number }).n : 0;
    const obs = (c.db.prepare("SELECT metric, successes, trials, value, source_type, source_note, observed_on, recorded_by FROM experiment_observations WHERE experiment_id = ? AND variant_id = ? AND workspace_id = ? ORDER BY observed_on, recorded_at").all(id, v.id, wsId) as Array<Record<string, any>>)
      .map((o) => ({ metric: o.metric as string, successes: o.successes as number | null, trials: o.trials as number | null, value: o.value as number | null, sourceType: o.source_type as string, sourceNote: o.source_note as string, observedOn: o.observed_on as string, byKind: kindOf(o.recorded_by) }));
    const usage = (c.db.prepare("SELECT used_from, used_to, note, recorded_by FROM experiment_usage WHERE experiment_id = ? AND variant_id = ? AND workspace_id = ? ORDER BY used_from").all(id, v.id, wsId) as Array<Record<string, any>>)
      .map((u) => ({ usedFrom: u.used_from as string, usedTo: (u.used_to ?? null) as string | null, note: u.note as string, byKind: kindOf(u.recorded_by) }));
    const metricObs = obs.filter((o) => o.metric === e.success_metric);
    const nonSyntheticObsTrials = metricObs.filter((o) => o.sourceType !== "synthetic").reduce((a, o) => a + (o.trials ?? 0), 0);
    const sample = FROM_LEADS.has(e.success_metric) ? leadSample : nonSyntheticObsTrials;
    return { v, leads: { byOrigin, countedFrom: "leads with this exact campaign version (and creative version when named)", leadSample, qualified, won, notCountedNoVersion: unversioned }, obs, usage, sample, metricObs };
  });

  if (e.status === "running" || e.status === "draft") {
    if (e.status === "running" && durationReached === false) warnings.push({ code: "duration_not_reached", severity: "blocking", message: `The planned ${e.duration_days} days have not passed yet (until ${plannedEnd!.slice(0, 10)}). Stopping early on a lucky stretch is a common way to fool yourself.` });
    for (const p of perVariant) if (p.sample < e.min_sample) warnings.push({ code: "below_min_sample", severity: "blocking", message: `“${p.v.label}” has ${p.sample} data point${p.sample === 1 ? "" : "s"} that count, below the planned minimum of ${e.min_sample}.` });
    if (perVariant.every((p) => p.sample === 0) || perVariant.every((p) => p.leads.leadSample === 0 && p.metricObs.every((o) => o.sourceType === "synthetic"))) {
      const anySynthetic = perVariant.some((p) => (p.leads.byOrigin.synthetic ?? 0) > 0 || p.obs.some((o) => o.sourceType === "synthetic"));
      if (anySynthetic) warnings.push({ code: "only_synthetic_data", severity: "blocking", message: "The only data is synthetic (made by this app or entered as synthetic). It says nothing about real people and cannot support a decision." });
    }
    if (!FROM_LEADS.has(e.success_metric) && perVariant.some((p) => p.metricObs.length === 0)) warnings.push({ code: "metric_not_entered", severity: "blocking", message: `“${METRIC_LABEL[e.success_metric]}” is not measured by this app. Someone has to enter or import it for every variant; at least one variant has none.` });
    if (e.status === "running" && perVariant.some((p) => p.usage.length === 0)) warnings.push({ code: "no_usage_recorded", severity: "caution", message: "No record says which variant was actually used for some variants. A plan is not a record of what ran." });
  }
  const sources = new Set(perVariant.flatMap((p) => p.metricObs.map((o) => o.sourceType)).concat(perVariant.some((p) => p.leads.leadSample > 0) ? ["leads"] : []));
  if (sources.size > 1) warnings.push({ code: "mixed_sources", severity: "caution", message: `Data comes from more than one source (${[...sources].join(", ")}). They are shown separately and never added together.` });
  if (perVariant.some((p) => p.leads.notCountedNoVersion > 0)) warnings.push({ code: "leads_without_version", severity: "caution", message: "Some leads for these campaigns have no recorded campaign version, so they could not be assigned to a variant and are not counted." });
  warnings.push({ code: "assignment_unverified", severity: "caution", message: "The app cannot verify how people were assigned to variants, or that they saw them equally. A difference may come from audience, timing or placement rather than the variant." });

  // Significance: only under conditions that make the number meaningful, and even then only indicative.
  let significance: Record<string, unknown> = { assessed: false, reason: "Not assessed.", claimsSignificance: false };
  const control = perVariant.find((p) => p.v.role === "control")!;
  const others = perVariant.filter((p) => p.v.role !== "control");
  if (perVariant.length !== 2) significance = { assessed: false, reason: "The app compares two variants (the control and one other). With more, it shows each one's data but does not test them.", claimsSignificance: false };
  else if (!(RATE_FROM_LEADS.has(e.success_metric) || e.success_metric === "click_through_rate" || e.success_metric === "conversion_rate" || e.success_metric === "other")) significance = { assessed: false, reason: `“${METRIC_LABEL[e.success_metric]}” is not a count out of a total, so no proportion test applies.`, claimsSignificance: false };
  else {
    const challenger = others[0]!;
    let dataset: string | null = null; let a: { successes: number; trials: number } | null = null; let b: { successes: number; trials: number } | null = null;
    if (RATE_FROM_LEADS.has(e.success_metric)) {
      dataset = "leads (imported and real only; synthetic leads are never used)";
      const pick = (p: (typeof perVariant)[number]) => ({ successes: e.success_metric === "won_rate" ? p.leads.won : p.leads.qualified, trials: p.leads.leadSample });
      a = pick(control); b = pick(challenger);
    } else {
      const both = (["imported", "user_entered"] as const).find((st) => [control, challenger].every((p) => p.metricObs.some((o) => o.sourceType === st && o.successes !== null && o.trials !== null)));
      if (both) {
        dataset = `entered results (${both}) for the success metric`;
        const sum = (p: (typeof perVariant)[number]) => p.metricObs.filter((o) => o.sourceType === both && o.successes !== null).reduce((x, o) => ({ successes: x.successes + (o.successes ?? 0), trials: x.trials + (o.trials ?? 0) }), { successes: 0, trials: 0 });
        a = sum(control); b = sum(challenger);
      }
    }
    if (!a || !b || !dataset) significance = { assessed: false, reason: "No successes-out-of-trials data from one non-synthetic source exists for both variants.", claimsSignificance: false };
    else if (a.trials < e.min_sample || b.trials < e.min_sample) significance = { assessed: false, reason: `Each variant needs at least the planned minimum of ${e.min_sample} (control ${a.trials}, other ${b.trials}).`, claimsSignificance: false };
    else {
      const t = twoProportionTest(a, b);
      significance = !t ? { assessed: false, reason: "Too few successes or failures in one group for the test to be valid (it needs at least 5 of each).", claimsSignificance: false }
        : { assessed: true, method: "two-proportion z-test (pooled), two-sided", dataset, control: { ...a, rate: a.successes / a.trials }, variant: { ...b, rate: b.successes / b.trials }, difference: b.successes / b.trials - a.successes / a.trials, pValue: Number(t.p.toFixed(4)),
            interpretation: "INDICATIVE ONLY. This is the probability of a difference at least this large if the variants truly did not differ, assuming people were assigned by chance. The app cannot check that assumption, so this is not a claim that the result is statistically significant.", claimsSignificance: false };
    }
  }

  return {
    experimentId: id, status: e.status,
    plan: { successMetric: e.success_metric, successMetricLabel: METRIC_LABEL[e.success_metric], durationDays: e.duration_days, minSample: e.min_sample, decisionRule: e.decision_rule, measuredByApp: FROM_LEADS.has(e.success_metric) },
    timing: { startedAt: e.started_at, plannedEnd, durationReached },
    variants: perVariant.map((p) => ({ id: p.v.id, label: p.v.label, role: p.v.role, leads: p.leads, observations: p.obs, usage: p.usage, sample: p.sample })),
    warnings, blocking: warnings.filter((w) => w.severity === "blocking"), significance,
    readiness: e.status !== "running" ? e.status : warnings.some((w) => w.severity === "blocking") ? "collecting" : "enough_data_to_consider",
    note: "Readiness means the planned time and minimum data are met. It does not mean the result is true: a person still decides, and the decision rule was written before the data.",
  };
}

/* ------------------------------------------------------------------------------------------------ conclude, view */

export function concludeExperiment(c: Core, wsId: string, id: string, input: unknown, by: string) {
  const b = ConcludeSchema.parse(input);
  const e = getExp(c, wsId, id);
  if (e.status !== "running") throw conflict("not_running", `This experiment is ${e.status}`);
  const a = experimentAnalysis(c, wsId, id);
  if (b.outcome !== "inconclusive" && a.blocking.length > 0 && !b.acknowledgeWarnings)
    throw conflict("warnings_unacknowledged", `The data does not yet support picking a winner: ${a.blocking.map((w) => w.message).join(" | ")} Conclude as inconclusive, or acknowledge these warnings to record your judgement anyway.`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE experiments SET status = 'concluded', concluded_at = ?, concluded_by = ?, outcome = ?, outcome_rationale = ?, warnings_at_conclusion = ? WHERE id = ? AND workspace_id = ? AND status = 'running'")
      .run(iso(c), by, b.outcome, b.rationale, JSON.stringify(a.warnings), id, wsId);
    audit(c, wsId, by, "experiment.concluded", "experiment", id, { outcome: b.outcome, acknowledgedWarnings: b.acknowledgeWarnings === true, blockingWarnings: a.blocking.length });
  })();
  return experimentView(c, wsId, id);
}

export function abandonExperiment(c: Core, wsId: string, id: string, input: unknown, by: string) {
  const b = AbandonSchema.parse(input);
  const e = getExp(c, wsId, id);
  if (e.status !== "draft" && e.status !== "running") throw conflict("not_open", `This experiment is ${e.status}`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE experiments SET status = 'abandoned', concluded_at = ?, concluded_by = ?, outcome = 'abandoned', outcome_rationale = ? WHERE id = ? AND workspace_id = ?").run(iso(c), by, b.reason, id, wsId);
    audit(c, wsId, by, "experiment.abandoned", "experiment", id, { from: e.status });
  })();
  return experimentView(c, wsId, id);
}

export function experimentView(c: Core, wsId: string, id: string) {
  const e = getExp(c, wsId, id);
  const vars = variantsOf(c, wsId, id);
  const names = new Map((c.db.prepare("SELECT id, name FROM campaigns WHERE workspace_id = ?").all(wsId) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  const cnames = new Map((c.db.prepare("SELECT id, name FROM creatives WHERE workspace_id = ?").all(wsId) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  return {
    id: e.id, name: e.name, status: e.status, hypothesis: e.hypothesis, principalVariable: e.principal_variable, variableNote: e.variable_note, audienceNote: e.audience_note, placementNote: e.placement_note,
    successMetric: e.success_metric, successMetricLabel: METRIC_LABEL[e.success_metric], durationDays: e.duration_days, minSample: e.min_sample, decisionRule: e.decision_rule,
    planLocked: e.status !== "draft", createdAt: e.created_at, createdByKind: kindOf(e.created_by), startedAt: e.started_at, concludedAt: e.concluded_at,
    outcome: e.outcome, outcomeRationale: e.outcome_rationale, warningsAtConclusion: e.warnings_at_conclusion ? (JSON.parse(e.warnings_at_conclusion) as Warning[]) : null,
    variants: vars.map((v) => ({ id: v.id, label: v.label, role: v.role, description: v.description, campaign: v.campaign_id ? { id: v.campaign_id, name: names.get(v.campaign_id) ?? null, version: v.campaign_version } : null, creative: v.creative_id ? { id: v.creative_id, name: cnames.get(v.creative_id) ?? null, version: v.creative_version } : null })),
    designWarnings: designWarnings({ principalVariable: e.principal_variable }, vars),
    neverAutomatic: "Concluding an experiment records a decision. It does not change any budget, campaign or creative, and nothing is published.",
  };
}

export function listExperiments(c: Core, wsId: string) {
  return { experiments: (c.db.prepare("SELECT id FROM experiments WHERE workspace_id = ? ORDER BY created_at DESC, id").all(wsId) as Array<{ id: string }>).map((r) => experimentView(c, wsId, r.id)) };
}
