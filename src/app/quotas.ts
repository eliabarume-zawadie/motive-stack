import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import { usageSummary } from "./aiService.js";

/**
 * Per-workspace limits on how much a workspace can store, so one workspace cannot grow the shared database without bound. Files, daily pictures, import batch size and
 * AI spend already have their own limits; these cover the record types that did not. A limit is checked BEFORE the record is written and refuses with a plain message.
 * All limits are the app's own protection, not billing or plan entitlements (no commercial model has been decided).
 */
export interface Quotas { leads: number; workItems: number; learnings: number; experiments: number; creatives: number; campaigns: number; forms: number }
export const DEFAULT_QUOTAS: Quotas = { leads: 20_000, workItems: 5_000, learnings: 2_000, experiments: 200, creatives: 500, campaigns: 500, forms: 200 };
export type QuotaKind = keyof Quotas;

const COUNT: Record<QuotaKind, string> = {
  leads: "SELECT COUNT(*) n FROM leads WHERE workspace_id = ?",
  workItems: "SELECT COUNT(*) n FROM work_items WHERE workspace_id = ?",
  learnings: "SELECT COUNT(*) n FROM learnings WHERE workspace_id = ?",
  experiments: "SELECT COUNT(*) n FROM experiments WHERE workspace_id = ?",
  creatives: "SELECT COUNT(*) n FROM creatives WHERE workspace_id = ? AND archived_at IS NULL",
  campaigns: "SELECT COUNT(*) n FROM campaigns WHERE workspace_id = ? AND lifecycle_state != 'archived'",
  forms: "SELECT COUNT(*) n FROM lead_forms WHERE workspace_id = ? AND archived_at IS NULL",
};
const LABEL: Record<QuotaKind, string> = { leads: "leads", workItems: "tasks", learnings: "learnings", experiments: "experiments", creatives: "creatives", campaigns: "campaigns", forms: "forms" };

const used = (c: AppContext, wsId: string, kind: QuotaKind): number => (c.db.prepare(COUNT[kind]).get(wsId) as { n: number }).n;

/** Throws if adding `adding` more of this kind would pass the workspace's limit. */
export function assertQuota(c: AppContext, wsId: string, kind: QuotaKind, adding = 1): void {
  const limit = c.quotas[kind];
  const n = used(c, wsId, kind);
  if (n + adding > limit) throw new AppError(413, "quota_exceeded", `This workspace has reached its limit of ${limit} ${LABEL[kind]} (${n} in use). Archive or remove some, or ask an owner to raise the limit.`);
}

/** What this workspace uses, against its limits, and what its AI use cost, attributed to provider and model. Read-only. */
export function usageView(c: AppContext, wsId: string) {
  const quotas = (Object.keys(DEFAULT_QUOTAS) as QuotaKind[]).map((k) => ({ id: k, label: LABEL[k], used: used(c, wsId, k), limit: c.quotas[k] }));
  const bytes = (c.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) n FROM asset_versions WHERE workspace_id = ?").get(wsId) as { n: number }).n;
  const assets = (c.db.prepare("SELECT COUNT(*) n FROM assets WHERE workspace_id = ? AND archived_at IS NULL").get(wsId) as { n: number }).n;
  const dayStart = `${c.now().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const rendersToday = (c.db.prepare("SELECT COUNT(*) n FROM creative_renders WHERE workspace_id = ? AND created_at >= ?").get(wsId, dayStart) as { n: number }).n;
  const rendersTotal = (c.db.prepare("SELECT COUNT(*) n FROM creative_renders WHERE workspace_id = ?").get(wsId) as { n: number }).n;
  const byProvider = (c.db.prepare(`SELECT provider, model, mode, COUNT(*) attempts, SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) simulated, SUM(estimated_cost_micros) cost, SUM(CASE WHEN estimated_cost_micros IS NULL AND mode = 'live' THEN 1 ELSE 0 END) unknown_cost
                                    FROM ai_usage WHERE workspace_id = ? GROUP BY provider, model, mode ORDER BY attempts DESC`).all(wsId) as Array<Record<string, any>>)
    .map((r) => ({ provider: r.provider as string, model: r.model as string, mode: r.mode as string, attempts: r.attempts as number, simulated: r.simulated as number, knownCostMicros: (r.cost ?? 0) as number, requestsWithUnknownCost: r.unknown_cost as number }));
  const jobs = Object.fromEntries((c.db.prepare("SELECT status, COUNT(*) n FROM jobs WHERE workspace_id = ? GROUP BY status").all(wsId) as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  const leads = Object.fromEntries((c.db.prepare("SELECT origin, COUNT(*) n FROM leads WHERE workspace_id = ? GROUP BY origin").all(wsId) as Array<{ origin: string; n: number }>).map((r) => [r.origin, r.n]));
  return {
    workspaceId: wsId, quotas,
    storage: { bytes, maxBytes: c.assetLimits.maxWorkspaceBytes, assets, maxAssets: c.assetLimits.maxAssets, maxFileBytes: c.assetLimits.maxFileBytes },
    pictures: { today: rendersToday, dailyLimit: c.creativeLimits.maxRendersPerDay, total: rendersTotal, costCents: 0, note: "Pictures are made by an offline placeholder: they cost nothing." },
    ai: { ...usageSummary(c, wsId), byProvider, note: "Cost is attributed to this workspace by provider and model. A live request whose price is unknown is counted as unknown, never as zero." },
    jobs, leadsByOrigin: leads,
    notes: ["These are the app's own safety limits, not plan entitlements: no commercial model has been decided.", "Advertising spend is not measured by this app, so it is not part of this view."],
  };
}
