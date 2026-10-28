import { z } from "zod";
import { audit, iso, type Core } from "./core.js";
import type { AppContext } from "./context.js";
import { AppError, conflict, notFound } from "./errors.js";
import { generateCampaign, getCampaignRecord, regenerateCampaign, updateBrief } from "./campaigns.js";
import { LIFECYCLE_LABEL, type LifecycleState } from "./lifecycle.js";
import { liveCampaignBudgetSum, planBudgets, planFingerprint, touchPlanBudget } from "./planBudget.js";
import { newId, safeError } from "./util.js";
import { getBrain } from "./workspaces.js";
import { budgetPosition } from "./budgetCommitments.js";
import { separationOutcome, type SeparationOutcome } from "./workspacePolicy.js";
import type { Plan } from "./campaignPlan.js";

/**
 * Marketing plans: a group of SEPARATE campaigns that share one daily budget. A plan is a way to propose, review and generate; it is never approved as a whole.
 * Every campaign it produces is an ordinary campaign with its own versions, proposal, approval and lifecycle, and one campaign's approval never covers another.
 *
 * Three ways to start a campaign are supported: one campaign (the existing generate route), a recommended plan, and a batch of drafts from a plan's selected
 * opportunities. The recommendation is RULE-BASED, from services the owner confirmed in the Business Brain: it is not a model's opinion and not a forecast.
 * What the Business Brain does not say is reported as unknown, never as "not offered".
 */

const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noControl, "No control characters");
const GOALS = ["lead_generation", "promote_service", "local_awareness"] as const;

export const RecommendSchema = z.object({
  name: text(2, 80).optional(),
  goal: z.enum(GOALS).default("lead_generation"),
  totalDailyBudgetCents: z.number().int().min(1).max(1_000_000).optional(),
  durationDays: z.number().int().min(1).max(90).optional(),
  maxOpportunities: z.number().int().min(1).max(5).default(5),
}).strict();

export const PlanUpdateSchema = z.object({
  name: text(2, 80).optional(),
  totalDailyBudgetCents: z.number().int().min(1).max(1_000_000).nullable().optional(),
  durationDays: z.number().int().min(1).max(90).nullable().optional(),
}).strict();

export const OpportunityUpdateSchema = z.object({
  status: z.enum(["selected", "excluded", "saved"]).optional(),
  title: text(2, 100).optional(),
  angle: text(2, 200).optional(),
  allocationCents: z.number().int().min(1).max(1_000_000).nullable().optional(),
  acknowledgeDuplicate: z.boolean().optional(),
}).strict();

export const GenerateBatchSchema = z.object({ opportunityIds: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).min(1).max(5).optional(), providerId: z.string().min(1).optional(), model: z.string().min(1).optional() }).strict();
export const BudgetReviewSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), note: text(1, 300).optional() }).strict();

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const STALE_GENERATION_MS = 10 * 60 * 1000;
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

interface PlanRow {
  id: string; workspace_id: string; name: string; source: string; goal: Plan["goal"]; total_daily_budget_cents: number | null; duration_days: number | null; version: number;
  budget_reviewed_fingerprint: string | null; budget_changed_by: string | null; budget_reviewed_by: string | null; budget_reviewed_at: string | null; budget_separation: string | null;
  basis: string; created_at: string; created_by: string; updated_at: string; archived_at: string | null;
}
interface OppRow {
  id: string; plan_id: string; position: number; title: string; focus_service: string; angle: string; rationale: string; unknowns: string; status: string; allocation_cents: number | null;
  campaign_id: string | null; duplicate_of: string | null; duplicate_note: string | null; duplicate_acknowledged: number; similarity: number | null; similar_to: string | null;
  error_code: string | null; error_message: string | null; generation_started_at: string | null;
}

function getPlanRow(c: Core, wsId: string, planId: string): PlanRow {
  const p = c.db.prepare("SELECT * FROM marketing_plans WHERE id = ? AND workspace_id = ?").get(planId, wsId) as PlanRow | undefined;
  if (!p) throw notFound("Plan");
  return p;
}
function getOpp(c: Core, wsId: string, planId: string, oppId: string): OppRow {
  const o = c.db.prepare("SELECT * FROM plan_opportunities WHERE id = ? AND plan_id = ? AND workspace_id = ?").get(oppId, planId, wsId) as OppRow | undefined;
  if (!o) throw notFound("Opportunity");
  return o;
}

/** Other, live campaigns in this workspace that already focus on this service (so a new opportunity for it would repeat them). */
function overlapsWithExisting(c: Core, wsId: string, service: string, exceptPlanId: string | null): Array<{ id: string; name: string }> {
  const like = `%${norm(service).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  return c.db.prepare(
    `SELECT k.id, k.name FROM campaigns k LEFT JOIN campaign_plans cp ON cp.campaign_id = k.id
     WHERE k.workspace_id = ? AND k.archived_at IS NULL AND (k.plan_id IS NULL OR k.plan_id != ?) AND (lower(cp.focus_service) = ? OR lower(k.name) LIKE ? ESCAPE '\\')`,
  ).all(wsId, exceptPlanId ?? "", norm(service), like) as Array<{ id: string; name: string }>;
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
const copyOf = (b: { headlines: string[]; primaryTexts: string[] }) => [...b.headlines, ...b.primaryTexts].join(" ");

/* ------------------------------------------------------------------ views */

function oppView(c: Core, wsId: string, o: OppRow, budgets: ReturnType<typeof planBudgets>) {
  let campaign: Record<string, unknown> | null = null;
  if (o.campaign_id) {
    const k = c.db.prepare("SELECT id, name, current_version, lifecycle_state, archived_at FROM campaigns WHERE id = ? AND workspace_id = ?").get(o.campaign_id, wsId) as { id: string; name: string; current_version: number; lifecycle_state: LifecycleState | null; archived_at: string | null } | undefined;
    const b = budgets.find((x) => x.opportunityId === o.id);
    if (k) campaign = {
      id: k.id, name: k.name, version: k.current_version, lifecycle: k.lifecycle_state ?? "draft", lifecycleLabel: LIFECYCLE_LABEL[k.lifecycle_state ?? "draft"], archived: k.archived_at !== null,
      dailyBudgetCents: b?.campaignBudgetCents ?? null, overShare: !!b && o.allocation_cents !== null && (b.campaignBudgetCents ?? 0) > o.allocation_cents,
    };
  }
  return {
    id: o.id, position: o.position, title: o.title, focusService: o.focus_service, angle: o.angle, rationale: o.rationale, unknowns: JSON.parse(o.unknowns) as string[], status: o.status,
    allocationCents: o.allocation_cents, campaign,
    duplicate: o.duplicate_of ? { of: o.duplicate_of, note: o.duplicate_note, acknowledged: o.duplicate_acknowledged === 1 } : null,
    similar: o.similar_to ? { to: o.similar_to, score: Math.round((o.similarity ?? 0) * 100) / 100 } : null,
    error: o.error_code ? { code: o.error_code, message: o.error_message } : null,
  };
}

export function planView(c: Core, wsId: string, planId: string) {
  const p = getPlanRow(c, wsId, planId);
  const brain = getBrain(c, wsId)?.brain;
  const budgets = planBudgets(c, wsId, planId);
  const opps = (c.db.prepare("SELECT * FROM plan_opportunities WHERE plan_id = ? AND workspace_id = ? ORDER BY position").all(planId, wsId) as OppRow[]).map((o) => oppView(c, wsId, o, budgets));
  const liveSum = liveCampaignBudgetSum(budgets);
  const shares = opps.filter((o) => o.status === "selected" || o.status === "generated" || o.status === "generating").reduce((n, o) => n + (o.allocationCents ?? 0), 0);
  const fp = planFingerprint(c, wsId, planId);
  // Money already committed OUTSIDE this plan (other plans and stand-alone campaigns) comes off the workspace-wide daily limit first.
  const pos = budgetPosition(c, wsId);
  const outsideCommitted = pos.commitments.filter((x) => x.planId !== planId).reduce((n, x) => n + x.cents, 0);
  const availableForPlan = pos.ceilingCents === null ? null : Math.max(0, pos.ceilingCents - outsideCommitted);
  const reviewedCurrent = p.budget_reviewed_fingerprint !== null && p.budget_reviewed_fingerprint === fp;
  const gaps: string[] = [];
  if (p.total_daily_budget_cents === null) gaps.push("Set the plan's daily total.");
  else if (liveSum > p.total_daily_budget_cents) gaps.push(`The campaigns add up to ${liveSum}¢ per day, more than the total of ${p.total_daily_budget_cents}¢.`);
  if (opps.some((o) => o.campaign?.overShare)) gaps.push("A campaign is above its planned share.");
  if (p.total_daily_budget_cents !== null && availableForPlan !== null && p.total_daily_budget_cents > availableForPlan) gaps.push(`Other approved campaigns already use part of your daily limit, leaving ${availableForPlan}¢ per day for this plan, less than its total of ${p.total_daily_budget_cents}¢. Not every campaign in it can be approved.`);
  if (p.total_daily_budget_cents !== null && !reviewedCurrent) gaps.push(p.budget_reviewed_fingerprint ? "The budget changed since it was reviewed." : "The total and each campaign's budget have not been reviewed.");
  return {
    id: p.id, name: p.name, source: p.source, goal: p.goal, durationDays: p.duration_days, version: p.version, archived: p.archived_at !== null, basis: p.basis, createdAt: p.created_at, createdByKind: kindOf(p.created_by),
    /** What this is not: a forecast, an approval, or a guarantee. Shown with every plan. */
    notice: "A plan groups separate campaigns. It is not approved as a whole and it predicts no results: each campaign needs its own review and approval.",
    budget: {
      totalDailyCents: p.total_daily_budget_cents, ceilingCents: brain?.maxDailyBudgetCents ?? null, plannedSharesCents: shares, campaignsAddUpToCents: liveSum,
      /** What the workspace-wide daily limit leaves for this plan after everything committed elsewhere. */
      availableForPlanCents: availableForPlan,
      unassignedCents: p.total_daily_budget_cents === null ? null : Math.max(0, p.total_daily_budget_cents - shares),
      fingerprint: fp,
      review: { done: reviewedCurrent, stale: p.budget_reviewed_fingerprint !== null && !reviewedCurrent, at: p.budget_reviewed_at, byKind: kindOf(p.budget_reviewed_by), separation: p.budget_separation },
    },
    gaps,
    opportunities: opps,
  };
}

export function listPlans(c: Core, wsId: string, includeArchived = false) {
  const rows = c.db.prepare(`SELECT id FROM marketing_plans WHERE workspace_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY created_at DESC, id`).all(wsId) as Array<{ id: string }>;
  return { plans: rows.map((r) => planView(c, wsId, r.id)) };
}

/* ------------------------------------------------------------------ recommend */

export function recommendPlan(c: Core, wsId: string, actor: string, input: unknown) {
  const body = RecommendSchema.parse(input ?? {});
  const stored = getBrain(c, wsId);
  if (!stored) throw conflict("brain_required", "Save the Business Brain before asking for a plan");
  const brain = stored.brain;
  if (body.totalDailyBudgetCents !== undefined && body.totalDailyBudgetCents > brain.maxDailyBudgetCents) throw new AppError(422, "budget_exceeds_ceiling", `The plan's daily total (${body.totalDailyBudgetCents}¢) is above your ceiling of ${brain.maxDailyBudgetCents}¢`);
  const seen = new Set<string>();
  const services = brain.services.filter((s) => { const k = norm(s); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, body.maxOpportunities);
  if (!services.length) throw conflict("no_services", "Add the services you offer in My business so there is something to plan");
  const planId = newId("plan");
  const at = iso(c);
  const unknownsFor = (service: string): string[] => {
    const u = [`Your website may not list everything you offer. Only services you confirmed in My business are used; anything else is unknown, not "not offered".`];
    if (!brain.approvedPricing) u.push("No price is approved, so this campaign will not state one.");
    if (!brain.differentiators.length && !brain.verifiedFacts.length) u.push("No strengths or credentials are on file, so it will make no trust claims.");
    if (services.length > 1) u.push(`Budget for ${service} is a share of one daily total, not an extra amount.`);
    return u;
  };
  const share = body.totalDailyBudgetCents !== undefined ? Math.floor(body.totalDailyBudgetCents / services.length) : null;
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO marketing_plans (id, workspace_id, name, source, goal, total_daily_budget_cents, duration_days, version, basis, created_at, created_by, updated_at, budget_changed_by)
                  VALUES (?,?,?,'recommended',?,?,?,1,?,?,?,?,?)`)
      .run(planId, wsId, body.name ?? "Marketing plan", body.goal, body.totalDailyBudgetCents ?? null, body.durationDays ?? null,
        "Rule-based: one separate campaign for each service you confirmed in My business. It is a starting point to review, not a forecast, and a model has not judged it.", at, actor, at, actor);
    const ins = c.db.prepare(`INSERT INTO plan_opportunities (id, plan_id, workspace_id, position, title, focus_service, angle, rationale, unknowns, status, allocation_cents, duplicate_of, duplicate_note, created_at, updated_at)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    services.forEach((service, i) => {
      const others = services.filter((s) => s !== service);
      const dup = overlapsWithExisting(c, wsId, service, planId)[0];
      ins.run(newId("opp"), planId, wsId, i + 1, `${service} campaign`, service, i % 2 === 0 ? "Urgent need: the customer has a problem now" : "Trust: why this provider",
        `A separate campaign about ${service}, so its copy, audience and budget are not mixed with ${others.length ? others.join(", ") : "other work"}.`, JSON.stringify(unknownsFor(service)),
        dup ? "suggested" : "selected", share, dup?.id ?? null, dup ? `You already have a campaign about this service ("${dup.name}"). Exclude this one, or confirm it should be a separate campaign.` : null, at, at);
    });
    audit(c, wsId, actor, "plan.created", "plan", planId, { source: "recommended", opportunities: services.length, goal: body.goal, totalDailyBudgetCents: body.totalDailyBudgetCents ?? null });
  })();
  return planView(c, wsId, planId);
}

/* ------------------------------------------------------------------ edits */

function checkTotals(c: Core, wsId: string, plan: PlanRow, total: number | null, opps: Array<{ status: string; allocation_cents: number | null }>) {
  const ceiling = getBrain(c, wsId)?.brain.maxDailyBudgetCents;
  if (total !== null && ceiling !== undefined && total > ceiling) throw new AppError(422, "budget_exceeds_ceiling", `The plan's daily total (${total}¢) is above your ceiling of ${ceiling}¢`);
  const shares = opps.filter((o) => ["selected", "generated", "generating"].includes(o.status)).reduce((n, o) => n + (o.allocation_cents ?? 0), 0);
  if (total !== null && shares > total) throw new AppError(422, "allocation_exceeds_total", `The planned shares add up to ${shares}¢, which is more than the plan's total of ${total}¢`);
  void plan;
}

export function updatePlan(c: Core, wsId: string, actor: string, planId: string, input: unknown) {
  const body = PlanUpdateSchema.parse(input);
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) throw conflict("plan_archived", "This plan is archived");
  const total = body.totalDailyBudgetCents === undefined ? plan.total_daily_budget_cents : body.totalDailyBudgetCents;
  const opps = c.db.prepare("SELECT status, allocation_cents FROM plan_opportunities WHERE plan_id = ? AND workspace_id = ?").all(planId, wsId) as Array<{ status: string; allocation_cents: number | null }>;
  checkTotals(c, wsId, plan, total, opps);
  const budgetChanged = total !== plan.total_daily_budget_cents;
  c.db.transaction(() => {
    c.db.prepare("UPDATE marketing_plans SET name = ?, total_daily_budget_cents = ?, duration_days = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(body.name ?? plan.name, total, body.durationDays === undefined ? plan.duration_days : body.durationDays, iso(c), planId, wsId);
    if (budgetChanged) touchPlanBudget(c, wsId, planId, actor);
    audit(c, wsId, actor, "plan.updated", "plan", planId, { totalDailyBudgetCents: budgetChanged ? { from: plan.total_daily_budget_cents, to: total } : undefined, renamed: body.name !== undefined });
  })();
  return planView(c, wsId, planId);
}

export function updateOpportunity(c: Core, wsId: string, actor: string, planId: string, oppId: string, input: unknown) {
  const body = OpportunityUpdateSchema.parse(input);
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) throw conflict("plan_archived", "This plan is archived");
  const o = getOpp(c, wsId, planId, oppId);
  if (o.status === "generating") throw conflict("generating", "This opportunity is being generated right now");
  if (body.status !== undefined && (o.status === "generated")) throw conflict("already_generated", "A campaign was already made from this opportunity. Archive that campaign instead.");
  const status = body.status ?? (o.status === "failed" ? "selected" : o.status);
  const allocation = body.allocationCents === undefined ? o.allocation_cents : body.allocationCents;
  const all = c.db.prepare("SELECT id, status, allocation_cents FROM plan_opportunities WHERE plan_id = ? AND workspace_id = ?").all(planId, wsId) as Array<{ id: string; status: string; allocation_cents: number | null }>;
  checkTotals(c, wsId, plan, plan.total_daily_budget_cents, all.map((x) => (x.id === oppId ? { status, allocation_cents: allocation } : x)));
  const ceiling = getBrain(c, wsId)?.brain.maxDailyBudgetCents;
  if (allocation !== null && ceiling !== undefined && allocation > ceiling) throw new AppError(422, "budget_exceeds_ceiling", `A campaign's share (${allocation}¢) is above your ceiling of ${ceiling}¢`);
  const budgetRelevant = status !== o.status || allocation !== o.allocation_cents;
  c.db.transaction(() => {
    c.db.prepare("UPDATE plan_opportunities SET title = ?, angle = ?, status = ?, allocation_cents = ?, duplicate_acknowledged = ?, error_code = CASE WHEN ? = 'selected' THEN NULL ELSE error_code END, error_message = CASE WHEN ? = 'selected' THEN NULL ELSE error_message END, updated_at = ? WHERE id = ? AND plan_id = ? AND workspace_id = ?")
      .run(body.title ?? o.title, body.angle ?? o.angle, status, allocation, body.acknowledgeDuplicate === undefined ? o.duplicate_acknowledged : body.acknowledgeDuplicate ? 1 : 0, status, status, iso(c), oppId, planId, wsId);
    if (budgetRelevant) touchPlanBudget(c, wsId, planId, actor);
    audit(c, wsId, actor, "plan.opportunity_updated", "plan", planId, { opportunityId: oppId, status: status !== o.status ? { from: o.status, to: status } : undefined, allocationCents: allocation !== o.allocation_cents ? { from: o.allocation_cents, to: allocation } : undefined, duplicateAcknowledged: body.acknowledgeDuplicate });
  })();
  return planView(c, wsId, planId);
}

export function archivePlan(c: Core, wsId: string, actor: string, planId: string) {
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) return planView(c, wsId, planId);
  c.db.transaction(() => {
    c.db.prepare("UPDATE marketing_plans SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), iso(c), planId, wsId);
    audit(c, wsId, actor, "plan.archived", "plan", planId, {});
  })();
  return planView(c, wsId, planId);
}

/* ------------------------------------------------------------------ batch generation */

/**
 * Makes a draft for each selected opportunity, one at a time. It is RESUMABLE and IDEMPOTENT: an opportunity with a campaign is never generated again, an
 * opportunity is claimed (selected/failed -> generating) before anything is requested, the campaign and the claim complete in one transaction, and a failure
 * marks just that opportunity as failed with a safe message so the rest continue. Running it again finishes what is left and never duplicates.
 */
export async function generatePlanDrafts(c: AppContext, wsId: string, actor: string, planId: string, input: unknown) {
  const body = GenerateBatchSchema.parse(input ?? {});
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) throw conflict("plan_archived", "This plan is archived");
  // a generation that was interrupted long ago (the server stopped) is released so it can be retried; a recent one is left alone
  c.db.prepare("UPDATE plan_opportunities SET status = 'failed', error_code = 'interrupted', error_message = 'Generation was interrupted. Try again.', updated_at = ? WHERE plan_id = ? AND workspace_id = ? AND status = 'generating' AND generation_started_at < ?")
    .run(iso(c), planId, wsId, new Date(c.now().getTime() - STALE_GENERATION_MS).toISOString());
  const all = c.db.prepare("SELECT * FROM plan_opportunities WHERE plan_id = ? AND workspace_id = ? ORDER BY position").all(planId, wsId) as OppRow[];
  const wanted = all.filter((o) => (body.opportunityIds ? body.opportunityIds.includes(o.id) : true) && (o.status === "selected" || o.status === "failed"));
  if (body.opportunityIds) for (const id of body.opportunityIds) if (!all.some((o) => o.id === id)) throw notFound("Opportunity");
  const results: Array<{ opportunityId: string; outcome: "generated" | "skipped" | "failed"; reason?: string; campaignId?: string }> = [];
  for (const o of wanted) {
    if (o.duplicate_of && !o.duplicate_acknowledged) { results.push({ opportunityId: o.id, outcome: "skipped", reason: "duplicate_not_acknowledged" }); continue; }
    if (plan.total_daily_budget_cents !== null && o.allocation_cents === null) { results.push({ opportunityId: o.id, outcome: "skipped", reason: "share_missing" }); continue; }
    const claim = c.db.prepare("UPDATE plan_opportunities SET status = 'generating', generation_started_at = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status IN ('selected','failed') AND campaign_id IS NULL")
      .run(iso(c), iso(c), o.id, planId, wsId);
    if (claim.changes !== 1) { results.push({ opportunityId: o.id, outcome: "skipped", reason: "not_available" }); continue; }
    try {
      const rec = await generateCampaign(c, wsId, { ...(body.providerId ? { providerId: body.providerId } : {}), ...(body.model ? { model: body.model } : {}) }, undefined,
        { goal: plan.goal, focusService: o.focus_service, ...(plan.duration_days ? { durationDays: plan.duration_days } : {}) }, { planId, opportunityId: o.id, allocationCents: o.allocation_cents });
      results.push({ opportunityId: o.id, outcome: "generated", campaignId: rec.id });
      touchPlanBudget(c, wsId, planId, actor);
      // how alike is it to a sibling in this plan? (reported, never hidden)
      const sibs = c.db.prepare("SELECT campaign_id FROM plan_opportunities WHERE plan_id = ? AND workspace_id = ? AND campaign_id IS NOT NULL AND campaign_id != ?").all(planId, wsId, rec.id) as Array<{ campaign_id: string }>;
      let best: { id: string; score: number } | null = null;
      for (const s of sibs) { const score = similarity(copyOf(rec.brief), copyOf(getCampaignRecord(c, wsId, s.campaign_id).brief)); if (!best || score > best.score) best = { id: s.campaign_id, score }; }
      if (best) c.db.prepare("UPDATE plan_opportunities SET similarity = ?, similar_to = ? WHERE id = ? AND workspace_id = ?").run(best.score, best.score >= 0.6 ? best.id : null, o.id, wsId);
    } catch (e) {
      const code = e instanceof AppError ? e.code : typeof (e as { kind?: unknown })?.kind === "string" ? String((e as { kind: string }).kind) : "generation_failed";
      c.db.prepare("UPDATE plan_opportunities SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND plan_id = ? AND workspace_id = ? AND status = 'generating'").run(code, safeError(e, 240), iso(c), o.id, planId, wsId);
      audit(c, wsId, actor, "plan.generation_failed", "plan", planId, { opportunityId: o.id, code });
      results.push({ opportunityId: o.id, outcome: "failed", reason: code });
    }
  }
  audit(c, wsId, actor, "plan.generated", "plan", planId, { requested: wanted.length, generated: results.filter((r) => r.outcome === "generated").length, failed: results.filter((r) => r.outcome === "failed").length, skipped: results.filter((r) => r.outcome === "skipped").length });
  return { ...planView(c, wsId, planId), results };
}

/** Ask again for one opportunity's campaign, as a new version of the same campaign. Only while it has not been approved or run. */
export async function regenerateOpportunity(c: AppContext, wsId: string, actor: string, planId: string, oppId: string, input: unknown) {
  const body = z.object({ providerId: z.string().min(1).optional(), model: z.string().min(1).optional() }).strict().parse(input ?? {});
  const plan = getPlanRow(c, wsId, planId);
  const o = getOpp(c, wsId, planId, oppId);
  if (!o.campaign_id) throw conflict("not_generated", "There is no draft to regenerate yet");
  await regenerateCampaign(c, wsId, o.campaign_id, { ...(body.providerId ? { providerId: body.providerId } : {}), ...(body.model ? { model: body.model } : {}) }, undefined, actor,
    { goal: plan.goal, focusService: o.focus_service, ...(plan.duration_days ? { durationDays: plan.duration_days } : {}) }, o.allocation_cents);
  touchPlanBudget(c, wsId, planId, actor);
  return planView(c, wsId, planId);
}

/**
 * Lowers every campaign that is above its planned share to that share, as a clearly labelled edit by a person (a new version each, so approvals for the old
 * numbers go stale). It never raises a budget. A campaign that was already run is left alone.
 */
export function applyAllocations(c: Core, wsId: string, actor: string, planId: string) {
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) throw conflict("plan_archived", "This plan is archived");
  const changed: string[] = [];
  for (const b of planBudgets(c, wsId, planId)) {
    if (!b.campaignId || b.campaignArchived || b.allocationCents === null || (b.campaignBudgetCents ?? 0) <= b.allocationCents) continue;
    const rec = getCampaignRecord(c, wsId, b.campaignId);
    if (rec.status !== "draft") continue;
    const note = ` Lowered to its planned share of ${b.allocationCents}¢ per day in the plan "${plan.name}" by a person.`;
    updateBrief(c, wsId, b.campaignId, { ...rec.brief, dailyBudgetCents: b.allocationCents, budgetRationale: (rec.brief.budgetRationale + note).slice(-500) }, actor);
    changed.push(b.campaignId);
  }
  audit(c, wsId, actor, "plan.allocations_applied", "plan", planId, { campaigns: changed.length });
  return { ...planView(c, wsId, planId), changedCampaigns: changed };
}

/**
 * A person reviews the plan's daily total and each campaign's budget as they are right now. The review names the exact numbers (a fingerprint); if anything it
 * covers changes afterwards it is stale and campaigns cannot be proposed until it is done again. With separation of duties on, the reviewer is not the person who
 * last changed those numbers.
 */
export function reviewPlanBudget(c: Core, wsId: string, planId: string, input: unknown, by: { decidedBy: string; approver?: { kind: string } }) {
  const body = BudgetReviewSchema.parse(input);
  const plan = getPlanRow(c, wsId, planId);
  if (plan.archived_at) throw conflict("plan_archived", "This plan is archived");
  if (plan.total_daily_budget_cents === null) throw conflict("plan_total_missing", "Set the plan's daily total before reviewing it");
  const rows = planBudgets(c, wsId, planId);
  const sum = liveCampaignBudgetSum(rows);
  if (sum > plan.total_daily_budget_cents) throw new AppError(422, "plan_budget_exceeded", `The campaigns add up to ${sum}¢ per day, more than the total of ${plan.total_daily_budget_cents}¢`);
  if (body.fingerprint !== planFingerprint(c, wsId, planId)) throw conflict("stale", "The plan's budget changed after you opened it. Look at the latest numbers.");
  const separation: SeparationOutcome = separationOutcome(c, wsId, plan.budget_changed_by, by, "plan budget");
  c.db.transaction(() => {
    c.db.prepare("UPDATE marketing_plans SET budget_reviewed_fingerprint = ?, budget_reviewed_by = ?, budget_reviewed_at = ?, budget_separation = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(body.fingerprint, by.decidedBy, iso(c), separation, iso(c), planId, wsId);
    audit(c, wsId, by.decidedBy, "plan.budget_reviewed", "plan", planId, { totalDailyCents: plan.total_daily_budget_cents, campaignsAddUpToCents: sum, separation, separationEnforced: separation === "enforced", note: body.note ?? null });
  })();
  return planView(c, wsId, planId);
}

/** What a campaign in a plan needs to show next to its proposal: the plan, its total, and where this campaign sits in it. */
export function planContextFor(c: Core, wsId: string, campaignId: string) {
  const camp = c.db.prepare("SELECT plan_id FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as { plan_id: string | null } | undefined;
  if (!camp?.plan_id) return null;
  const v = planView(c, wsId, camp.plan_id);
  const opp = v.opportunities.find((o) => o.campaign?.id === campaignId);
  return { id: v.id, name: v.name, totalDailyCents: v.budget.totalDailyCents, campaignsAddUpToCents: v.budget.campaignsAddUpToCents, plannedShareCents: opp?.allocationCents ?? null, reviewDone: v.budget.review.done, gaps: v.gaps, notice: v.notice };
}


