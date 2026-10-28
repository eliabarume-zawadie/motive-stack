import { z } from "zod";
import type { AppContext } from "./context.js";
import type { Core } from "./core.js";
import { AppError } from "./errors.js";
import type { BusinessBrain } from "../domain/schemas.js";

/**
 * The owner's marketing goal for a campaign, stored beside it (the campaign brief schema is unchanged and the Meta objective stays lead generation in
 * this version). The goal, focus service and run length are the owner's own words: they are shown with the draft and passed to a real model as DATA.
 * They are never a forecast, and a rule-based mock draft does not change with them (the screen says so).
 */
export const GOALS = {
  lead_generation: "Get more leads (people asking about your services)",
  promote_service: "Promote one service or offer",
  local_awareness: "Be known in your service area",
} as const;
export type Goal = keyof typeof GOALS;

export const PlanSchema = z.object({
  goal: z.enum(["lead_generation", "promote_service", "local_awareness"]).default("lead_generation"),
  focusService: z.string().trim().min(1).max(120).optional(),
  durationDays: z.number().int().min(1).max(90).optional(),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;

const bad = (message: string) => new AppError(400, "invalid_plan", message);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Splits the optional plan out of a generate request body; everything else is left for the existing request schema. */
export function splitPlan(body: unknown): { rest: Record<string, unknown>; plan: Plan | null } {
  const raw = (body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const has = ["goal", "focusService", "durationDays"].some((k) => k in raw);
  const planInput = { goal: raw.goal, focusService: raw.focusService, durationDays: raw.durationDays };
  delete raw.goal; delete raw.focusService; delete raw.durationDays;
  if (!has) return { rest: raw, plan: null };
  const parsed = PlanSchema.safeParse(Object.fromEntries(Object.entries(planInput).filter(([, v]) => v !== undefined && v !== null && v !== "")));
  if (!parsed.success) throw bad("The goal must be one of the listed goals, the run length 1 to 90 days, and the focus service short text.");
  return { rest: raw, plan: parsed.data };
}

/** A focus service must be one the Business Brain lists, and "promote one service" needs one. */
export function checkPlan(plan: Plan, brain: BusinessBrain): void {
  if (plan.goal === "promote_service" && !plan.focusService) throw bad("Choose which service or offer to promote.");
  if (plan.focusService && !brain.services.some((s) => norm(s) === norm(plan.focusService!))) throw bad("The focus service must be one of the services in your Business Brain.");
}

/** Extra prompt text, labelled as the owner's note. It adds no fact about the business. */
export function planNote(plan: Plan, allocationCents: number | null = null): string {
  const lines = [`Goal chosen by the owner: ${GOALS[plan.goal]}. The platform objective stays lead generation.`];
  // angle brackets are removed so a service name can never close the <owner_goal> block and pose as instructions
  if (plan.focusService) lines.push(`Focus this campaign on this listed service: ${plan.focusService.replace(/[<>]/g, "")}.`);
  if (plan.durationDays) lines.push(`The owner expects to run it for about ${plan.durationDays} days. Do not predict results.`);
  if (allocationCents) lines.push(`This campaign's planned share of the plan's daily budget is ${allocationCents} cents. Propose a starting budget at or below it.`);
  return ["<owner_goal>", ...lines, "</owner_goal>"].join("\n");
}

export function savePlan(c: Core, wsId: string, campaignId: string, plan: Plan): void {
  c.db.prepare("INSERT OR REPLACE INTO campaign_plans (campaign_id, workspace_id, goal, focus_service, duration_days, created_at) VALUES (?,?,?,?,?,?)")
    .run(campaignId, wsId, plan.goal, plan.focusService ?? null, plan.durationDays ?? null, c.now().toISOString());
}

export function getPlan(c: Pick<AppContext, "db">, wsId: string, campaignId: string): (Plan & { goalLabel: string }) | null {
  const r = c.db.prepare("SELECT goal, focus_service, duration_days FROM campaign_plans WHERE campaign_id = ? AND workspace_id = ?").get(campaignId, wsId) as
    { goal: Goal; focus_service: string | null; duration_days: number | null } | undefined;
  if (!r) return null;
  return { goal: r.goal, goalLabel: GOALS[r.goal], ...(r.focus_service ? { focusService: r.focus_service } : {}), ...(r.duration_days ? { durationDays: r.duration_days } : {}) };
}

export interface VersionChange { field: string; label: string; from: string; to: string }
export interface VersionHistoryItem { version: number; source: "ai" | "human"; createdAt: string; changes: VersionChange[] }

const LABELS: Record<string, string> = {
  name: "Name", dailyBudgetCents: "Daily budget (cents)", headlines: "Headlines", primaryTexts: "Primary texts", callToAction: "Call to action", objective: "Objective",
  budgetRationale: "Why this budget", rationale: "Overall rationale", audience: "Audience settings", targeting: "Targeting recommendation",
  assumptions: "Assumptions", openQuestions: "Open questions", reviewFlags: "Needs review", variations: "Creative variations", differentiatorDecisions: "Differentiator decisions",
};
const show = (v: unknown): string => {
  const s = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" | ") : JSON.stringify(v ?? null);
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
};

/** What changed from each version to the next, computed from the stored briefs. Version 1 has no earlier version to compare with. */
export function versionHistory(c: Pick<AppContext, "db">, wsId: string, campaignId: string): VersionHistoryItem[] {
  const rows = c.db.prepare("SELECT version, source, created_at, brief FROM campaign_versions WHERE campaign_id = ? AND workspace_id = ? ORDER BY version").all(campaignId, wsId) as
    Array<{ version: number; source: "ai" | "human"; created_at: string; brief: string }>;
  let prev: Record<string, unknown> | null = null;
  return rows.map((r) => {
    const brief = JSON.parse(r.brief) as Record<string, unknown>;
    const changes: VersionChange[] = [];
    if (prev) {
      for (const k of new Set([...Object.keys(prev), ...Object.keys(brief)])) {
        if (JSON.stringify(prev[k]) !== JSON.stringify(brief[k])) changes.push({ field: k, label: LABELS[k] ?? k, from: show(prev[k]), to: show(brief[k]) });
      }
    }
    prev = brief;
    return { version: r.version, source: r.source, createdAt: r.created_at, changes };
  });
}
