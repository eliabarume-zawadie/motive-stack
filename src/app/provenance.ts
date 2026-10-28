import type { AppContext } from "./context.js";
import { getBrain } from "./workspaces.js";

/**
 * Where each part of the SAVED Business Brain came from, for the owner to review.
 *
 * Only what the server itself recorded counts as website-derived: the fill ledger holds the values a website analysis offered and the form took (see
 * websiteAnalysis.recordFillApplied), and it is reconciled with the saved Brain every time the Brain is saved, so a value that is not really in the
 * Brain cannot stay recorded as coming from a website. Everything else is the owner's own, including what the no-website questionnaire wrote. A value
 * that is only the fictional demo is labelled as such, and the unchanged default tone is labelled as a default, never as something the owner chose.
 */

export type Source = "website" | "owner" | "demo" | "default";

const SCALARS: Array<[string, string]> = [
  ["businessName", "Business name"], ["industry", "Industry"], ["serviceArea", "Service area"], ["targetCustomer", "Target customer"], ["offer", "Offer"],
  ["tone", "Tone"], ["approvedPricing", "Approved pricing statement"], ["description", "Business summary"],
];
const LISTS: Array<[string, string]> = [
  ["services", "Services"], ["differentiators", "Strengths ads may use"], ["verifiedFacts", "Credentials and verified facts"],
  ["unverifiedClaims", "Claims not verified (kept out of ads)"], ["prohibitedClaims", "Things ads must never say"],
];
const DEMO = /\(DEMO\b|DEMO DATA|DEMO claim|DEMO fact|\(fictional\)/i;
const DEFAULT_TONE = "friendly and professional";
export const keyOf = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();

interface LedgerRow { field: string; value: string; value_key: string; site: string; created_at: string }

const ledgerOf = (c: AppContext, wsId: string): Map<string, LedgerRow> => {
  const rows = c.db.prepare("SELECT field, value, value_key, site, created_at FROM website_fill_ledger WHERE workspace_id = ?").all(wsId) as LedgerRow[];
  return new Map(rows.map((r) => [`${r.field}|${r.value_key}`, r]));
};

export interface ProvenanceItem { value: string; source: Source; site?: string; at?: string }
export interface Provenance {
  saved: boolean;
  version: number;
  scalars: Array<{ field: string; label: string } & ProvenanceItem>;
  lists: Array<{ field: string; label: string; items: ProvenanceItem[] }>;
  /** Records kept as evidence of where a website statement came from. They are NOT approved for use in ads. */
  records: Array<{ text: string; status: string; source: string; approvedForMarketing: boolean }>;
  counts: { website: number; owner: number; demo: number; default: number };
}

export function brainProvenance(c: AppContext, wsId: string): Provenance {
  const stored = getBrain(c, wsId);
  const empty: Provenance = { saved: false, version: 0, scalars: [], lists: [], records: [], counts: { website: 0, owner: 0, demo: 0, default: 0 } };
  if (!stored) return empty;
  const ledger = ledgerOf(c, wsId);
  const brain = stored.brain as unknown as Record<string, unknown>;
  const counts = { website: 0, owner: 0, demo: 0, default: 0 };
  const classify = (field: string, value: string): ProvenanceItem => {
    const hit = ledger.get(`${field}|${keyOf(value)}`);
    let item: ProvenanceItem;
    if (hit) item = { value, source: "website", site: hit.site, at: hit.created_at };
    else if (DEMO.test(value)) item = { value, source: "demo" };
    else if (field === "tone" && value === DEFAULT_TONE) item = { value, source: "default" };
    else item = { value, source: "owner" };
    counts[item.source]++;
    return item;
  };
  const scalars = SCALARS.flatMap(([field, label]) => { const v = brain[field]; return typeof v === "string" && v.trim() ? [{ field, label, ...classify(field, v) }] : []; });
  const lists = LISTS.flatMap(([field, label]) => { const v = brain[field]; return Array.isArray(v) && v.length ? [{ field, label, items: (v as string[]).map((x) => classify(field, x)) }] : []; });
  const facts = ((brain.facts as Array<{ text: string; status: string; source: string; approvedForMarketing: boolean }> | undefined) ?? []).map((f) => ({ text: f.text, status: f.status, source: f.source, approvedForMarketing: f.approvedForMarketing }));
  return { saved: true, version: stored.version, scalars, lists, records: facts, counts };
}

/**
 * Called whenever the Business Brain is saved: a ledger entry whose value is not in the saved Brain is forgotten, so the record always matches what is
 * really stored (a browser cannot leave phantom "website" entries behind, and text the owner later changed is no longer treated as the website's).
 */
export function reconcileLedger(c: AppContext, wsId: string): number {
  const stored = getBrain(c, wsId);
  const brain = (stored?.brain ?? {}) as unknown as Record<string, unknown>;
  const present = new Set<string>();
  for (const [f] of SCALARS) { const v = brain[f]; if (typeof v === "string" && v.trim()) present.add(`${f}|${keyOf(v)}`); }
  for (const [f] of LISTS) { const v = brain[f]; if (Array.isArray(v)) for (const x of v as string[]) present.add(`${f}|${keyOf(x)}`); }
  const rows = c.db.prepare("SELECT id, field, value_key FROM website_fill_ledger WHERE workspace_id = ?").all(wsId) as Array<{ id: string; field: string; value_key: string }>;
  const stale = rows.filter((r) => !present.has(`${r.field}|${r.value_key}`));
  const del = c.db.prepare("DELETE FROM website_fill_ledger WHERE id = ?");
  c.db.transaction(() => stale.forEach((r) => del.run(r.id)))();
  return stale.length;
}
