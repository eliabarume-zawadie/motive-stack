import type { Core } from "./core.js";
import { budgetPosition } from "./budgetCommitments.js";

/**
 * Truthful reporting. This view only counts records that exist in this database, and keeps every number labelled with WHERE it comes from. The rules:
 *  - synthetic, imported, real and unknown leads are counted SEPARATELY and are never added into one unlabelled total;
 *  - a metric this app cannot measure is listed as "not measured", with the reason: it is never shown as zero, never estimated and never charted;
 *  - there is no cost per lead, click-through rate, return on ad spend or conversion rate, because no verified spend, impression or click data exists;
 *  - a lead arriving after a campaign is not evidence the campaign caused it. Attribution coverage is shown next to every count.
 */
export type SourceType = "actual" | "imported" | "user_entered" | "simulated" | "estimated" | "unknown";
const ORIGINS = ["synthetic", "imported", "real", "unknown"] as const;
const STATUSES = ["new", "contacted", "qualified", "won", "lost"] as const;
const ORIGIN_TEXT: Record<(typeof ORIGINS)[number], { label: string; source: SourceType; note: string }> = {
  synthetic: { label: "Synthetic test leads", source: "simulated", note: "Made by this app's simulator or a form test. They are not real people and say nothing about performance." },
  imported: { label: "Imported leads", source: "imported", note: "Brought in by a person from somewhere else. Their source is the importer's word, not a verified integration." },
  real: { label: "Real leads from a verified integration", source: "actual", note: "None. No integration that delivers verified lead events exists in this release." },
  unknown: { label: "Unclassified (older records)", source: "unknown", note: "Records from before origin was tracked that cannot be classified." },
};

interface LeadAgg { origin: string; campaign_id: string; status: string; attribution_status: string; n: number }

export function analyticsView(c: Core, wsId: string) {
  const rows = c.db.prepare("SELECT origin, campaign_id, status, attribution_status, COUNT(*) n FROM leads WHERE workspace_id = ? GROUP BY origin, campaign_id, status, attribution_status").all(wsId) as LeadAgg[];
  const names = new Map((c.db.prepare("SELECT id, name FROM campaigns WHERE workspace_id = ?").all(wsId) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));

  const origins = ORIGINS.map((o) => {
    const mine = rows.filter((r) => r.origin === o);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, mine.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0)])) as Record<(typeof STATUSES)[number], number>;
    const attribution = { observed: 0, inferred: 0, unknown: 0 } as Record<string, number>;
    for (const r of mine) attribution[r.attribution_status] = (attribution[r.attribution_status] ?? 0) + r.n;
    const leads = mine.reduce((a, r) => a + r.n, 0);
    return { origin: o, ...ORIGIN_TEXT[o], leads, byStatus, attribution };
  });

  // Closed loop, per campaign and per origin: campaign -> lead -> status. Counts of what the team recorded; never a claim of causation.
  const campaigns = [...new Set(rows.map((r) => r.campaign_id))].map((id) => ({
    campaignId: id, campaignName: names.get(id) ?? "Unknown campaign",
    byOrigin: ORIGINS.map((o) => {
      const mine = rows.filter((r) => r.campaign_id === id && r.origin === o);
      const n = (s: string) => mine.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0);
      return { origin: o, leads: mine.reduce((a, r) => a + r.n, 0), contacted: n("contacted"), qualified: n("qualified"), won: n("won"), lost: n("lost"), new: n("new") };
    }).filter((x) => x.leads > 0),
  }));

  const today = c.now().toISOString().slice(0, 10);
  const fu = c.db.prepare(`SELECT COUNT(*) FILTER (WHERE follow_up_due IS NOT NULL AND follow_up_done_at IS NULL) open, COUNT(*) FILTER (WHERE follow_up_due IS NOT NULL AND follow_up_done_at IS NULL AND follow_up_due < ?) overdue,
                           COUNT(*) FILTER (WHERE follow_up_done_at IS NOT NULL) done FROM leads WHERE workspace_id = ?`).get(today, wsId) as { open: number; overdue: number; done: number };
  const consent = c.db.prepare("SELECT consent_status s, COUNT(*) n FROM leads WHERE workspace_id = ? AND origin = 'imported' GROUP BY consent_status").all(wsId) as Array<{ s: string; n: number }>;
  const budget = budgetPosition(c, wsId);

  const NOT_MEASURED = (id: string, label: string, why: string) => ({ id, label, available: false, sourceType: "unknown" as SourceType, value: null, why });
  const noPerf = "No verified performance data exists: the ad platform is simulated in this release and nothing imports performance numbers. It is not zero; it is not known.";
  return {
    principle: "Only records in this workspace are counted, each labelled with where it comes from. Synthetic, imported and real data are never added together, and anything that cannot be measured is shown as not measured, not as zero.",
    origins, campaigns,
    followUps: { open: fu.open, overdue: fu.overdue, done: fu.done, note: "Reminders for the team. This app sends nothing to leads." },
    consent: { imported: Object.fromEntries(consent.map((r) => [r.s, r.n])), note: "Consent is recorded as stated by whoever imported the lead; it is not verified here." },
    attributionNote: "Attribution says how sure the link between a lead and a campaign is. “Observed” needs a verified integration (none exists); synthetic leads are marked observed only because this app generated them. A lead arriving after a campaign is not proof the campaign caused it.",
    metrics: [
      { id: "leads_synthetic", label: "Synthetic leads", available: true, sourceType: "simulated" as SourceType, value: origins[0]!.leads, why: "Counted from this workspace's lead records." },
      { id: "leads_imported", label: "Imported leads", available: true, sourceType: "imported" as SourceType, value: origins[1]!.leads, why: "Counted from this workspace's lead records." },
      { id: "lead_status", label: "Lead status (new, contacted, qualified, won, lost)", available: true, sourceType: "user_entered" as SourceType, value: null, why: "Set by the team by hand; shown per origin." },
      { id: "planned_daily_commitment", label: "Planned daily budget committed (cents)", available: true, sourceType: "estimated" as SourceType, value: budget.committedCents, why: "What the owner has approved to spend per day. It is intent, not spend." },
      NOT_MEASURED("leads_real", "Real leads from a verified integration", "No integration that delivers verified lead events exists in this release."),
      NOT_MEASURED("impressions", "Impressions", noPerf), NOT_MEASURED("clicks", "Clicks", noPerf), NOT_MEASURED("spend", "Actual ad spend", noPerf),
      NOT_MEASURED("cost_per_lead", "Cost per lead", "Needs verified spend and real leads. Neither exists, so no figure is shown."),
      NOT_MEASURED("click_through_rate", "Click-through rate", noPerf), NOT_MEASURED("conversion_rate", "Conversion rate", noPerf), NOT_MEASURED("roas", "Return on ad spend", noPerf),
    ],
    measurability: { measurable: ["Leads this app holds, by origin", "Lead status set by the team", "Planned (intended) daily budget"], notMeasurable: ["Impressions, clicks and spend", "Cost per lead, click-through rate, conversion rate, return on ad spend", "Whether any campaign caused a lead or a sale"] },
  };
}
