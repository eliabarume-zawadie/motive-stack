import { createHash } from "node:crypto";
import { z } from "zod";
import { experimentAnalysis } from "./experiments.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { newId } from "./util.js";
import { assertQuota } from "./quotas.js";
import type { AppContext } from "./context.js";
import { separationOutcome } from "./workspacePolicy.js";

/**
 * The Marketing Brain: reviewed, traceable learnings, and recommendations derived from records.
 *  - A learning says where it came from, when, how confident it is, what it does NOT show, and whether a person confirmed it or a rule only suggested it. It is never
 *    a Business Brain fact and nothing here can make an ad claim usable: the claim checks read the Business Brain and nothing in this file;
 *  - suggestions are made by plain rules from records that exist (a concluded experiment, an approved or rejected creative); no model writes them;
 *  - a recommendation is derived on every read from records, names its evidence and its uncertainty, and needs a person's decision. Accepting one records that decision
 *    and changes nothing else: no budget moves, no campaign is edited, nothing is published.
 */
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, "That is not a real date");
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

export const LEARNING_KINDS = ["message", "creative", "audience", "timing", "constraint", "unknown", "other"] as const;
export const LEARNING_SOURCES = ["experiment", "approved_creative", "rejected_creative", "campaign_history", "human_note", "imported"] as const;
export const LearningCreateSchema = z.object({
  statement: text(300), kind: z.enum(LEARNING_KINDS), sourceType: z.enum(LEARNING_SOURCES), sourceRef: z.string().regex(/^[a-z0-9_]{1,64}(:\d{1,5})?$/).optional(), observedOn: DATE,
  confidence: z.enum(["low", "medium", "high"]), limitations: text(300),
}).strict();
export const LearningDecisionSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
const SYSTEM = "system:learning-suggest";

interface LRow {
  id: string; statement: string; kind: string; source_type: string; source_ref: string | null; observed_on: string; confidence: string; limitations: string; origin: string; status: string;
  created_at: string; created_by: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; separation: string | null;
}
const view = (r: LRow) => ({
  id: r.id, statement: r.statement, kind: r.kind, sourceType: r.source_type, sourceRef: r.source_ref, observedOn: r.observed_on, confidence: r.confidence, limitations: r.limitations,
  origin: r.origin, originLabel: r.origin === "machine_suggested" ? "Suggested by a rule" : "Written by a person", status: r.status,
  humanConfirmed: r.status === "confirmed", createdAt: r.created_at, createdByKind: kindOf(r.created_by), decidedAt: r.decided_at, decidedByKind: kindOf(r.decided_by), decisionNote: r.decision_note, separation: r.separation,
  usableAsClaim: false,
});
const NOTE = "A learning is a note about what the team has seen. It is not a verified fact about the business and it never makes an ad claim usable: claims still come only from reviewed Business Brain facts.";

export function listLearnings(c: Core, wsId: string, status?: string) {
  const ok = status && ["suggested", "confirmed", "rejected", "retired"].includes(status);
  const rows = c.db.prepare(`SELECT * FROM learnings WHERE workspace_id = ? ${ok ? "AND status = ?" : ""} ORDER BY created_at DESC, id LIMIT 200`).all(...(ok ? [wsId, status] : [wsId])) as LRow[];
  const counts = Object.fromEntries((c.db.prepare("SELECT status, COUNT(*) n FROM learnings WHERE workspace_id = ? GROUP BY status").all(wsId) as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  return { learnings: rows.map(view), counts, note: NOTE };
}
function getLearning(c: Core, wsId: string, id: string): LRow {
  const r = c.db.prepare("SELECT * FROM learnings WHERE id = ? AND workspace_id = ?").get(id, wsId) as LRow | undefined;
  if (!r) throw notFound("Learning");
  return r;
}

/** The source must exist in this workspace, so a learning can always be traced back. */
function checkSource(c: Core, wsId: string, type: string, ref: string | undefined): void {
  if (["human_note", "imported"].includes(type)) return;
  if (!ref) throw new AppError(400, "source_ref_required", "Say which experiment, creative or campaign this came from so it can be traced");
  const id = ref.split(":")[0]!;
  const table = type === "experiment" ? "experiments" : type === "campaign_history" ? "campaigns" : "creatives";
  if (!c.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, wsId)) throw notFound(type === "experiment" ? "Experiment" : type === "campaign_history" ? "Campaign" : "Creative");
}

/** A person writes a learning down. It starts as a suggestion: another person confirms it. */
export function createLearning(c: AppContext, wsId: string, actor: string, input: unknown) {
  const b = LearningCreateSchema.parse(input);
  checkSource(c, wsId, b.sourceType, b.sourceRef);
  assertQuota(c, wsId, "learnings");
  const id = newId("lrn");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO learnings (id, workspace_id, statement, kind, source_type, source_ref, observed_on, confidence, limitations, origin, status, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,'human_entered','suggested',?,?)`)
      .run(id, wsId, b.statement, b.kind, b.sourceType, b.sourceRef ?? null, b.observedOn, b.confidence, b.limitations, iso(c), actor);
    audit(c, wsId, actor, "learning.created", "learning", id, { kind: b.kind, sourceType: b.sourceType });
  })();
  return view(getLearning(c, wsId, id));
}

export function decideLearning(c: Core, wsId: string, id: string, decision: "confirm" | "reject" | "retire", input: unknown, by: { decidedBy: string; approver?: { kind: string } }) {
  const b = LearningDecisionSchema.parse(input ?? {});
  const l = getLearning(c, wsId, id);
  if (decision === "retire") {
    if (l.status !== "confirmed") throw conflict("not_confirmed", `This learning is ${l.status}; only a confirmed one can be retired`);
  } else if (l.status !== "suggested") throw conflict("not_suggested", `This learning is ${l.status}, so it cannot be ${decision}ed`);
  if (decision !== "confirm" && !b.note) throw new AppError(400, "note_required", "Say why, so the reason is kept with the learning");
  c.db.transaction(() => {
    const separation = decision === "confirm" ? (l.origin === "human_entered" ? separationOutcome(c, wsId, l.created_by, by, "learning") : "machine_suggested") : null;
    c.db.prepare("UPDATE learnings SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, separation = ? WHERE id = ? AND workspace_id = ?")
      .run(decision === "confirm" ? "confirmed" : decision === "reject" ? "rejected" : "retired", by.decidedBy, iso(c), b.note ?? null, separation, id, wsId);
    audit(c, wsId, by.decidedBy, `learning.${decision === "confirm" ? "confirmed" : decision === "reject" ? "rejected" : "retired"}`, "learning", id, { note: b.note ?? null, ...(separation ? { separation } : {}) });
  })();
  return view(getLearning(c, wsId, id));
}

/**
 * Plain rules, no model: turns records into SUGGESTED learnings, once each (a repeat run adds nothing). Every suggestion is low confidence, carries the limits of its
 * evidence, and waits for a person. Approval of a creative is a judgement about fit, not evidence that it performs; an experiment's outcome is a person's judgement.
 */
export function suggestLearnings(c: AppContext, wsId: string, actor: string) {
  assertQuota(c, wsId, "learnings"); // suggestions stop at the limit too
  let added = 0;
  const today = iso(c).slice(0, 10);
  const add = (dedupe: string, s: { statement: string; kind: string; sourceType: string; sourceRef: string; observedOn: string; limitations: string }) => {
    const r = c.db.prepare(`INSERT OR IGNORE INTO learnings (id, workspace_id, statement, kind, source_type, source_ref, observed_on, confidence, limitations, origin, status, dedupe_key, created_at, created_by) VALUES (?,?,?,?,?,?,?, 'low', ?, 'machine_suggested','suggested',?,?,?)`)
      .run(newId("lrn"), wsId, s.statement.slice(0, 300), s.kind, s.sourceType, s.sourceRef, s.observedOn, s.limitations.slice(0, 300), dedupe, iso(c), SYSTEM);
    added += r.changes;
  };
  c.db.transaction(() => {
    for (const e of c.db.prepare("SELECT * FROM experiments WHERE workspace_id = ? AND status = 'concluded' ORDER BY concluded_at").all(wsId) as Array<Record<string, any>>) {
      const vars = c.db.prepare("SELECT label, role FROM experiment_variants WHERE experiment_id = ? AND workspace_id = ?").all(e.id, wsId) as Array<{ label: string; role: string }>;
      const control = vars.find((v) => v.role === "control")?.label ?? "the control", other = vars.find((v) => v.role !== "control")?.label ?? "the variant";
      const warnings = e.warnings_at_conclusion ? (JSON.parse(e.warnings_at_conclusion) as Array<{ code: string; message: string }>) : [];
      const lim = ["A person's judgement, not a proven effect.", ...warnings.filter((w) => w.code !== "mixed_sources").map((w) => w.message.split(".")[0]!)].join(" ");
      const kind = e.principal_variable === "creative_image" ? "creative" : e.principal_variable === "audience" ? "audience" : ["headline", "primary_text", "call_to_action", "offer"].includes(e.principal_variable) ? "message" : "other";
      const what = e.outcome === "variant_better" ? `“${other}” was judged better than “${control}”` : e.outcome === "control_better" ? `“${control}” was judged better than “${other}”` : `no clear difference was found between “${control}” and “${other}”`;
      add(`exp:${e.id}`, { statement: `In the experiment “${e.name}” (changing ${String(e.principal_variable).replace(/_/g, " ")}), ${what}.`, kind, sourceType: "experiment", sourceRef: e.id, observedOn: String(e.concluded_at).slice(0, 10), limitations: lim });
    }
    for (const r of c.db.prepare(`SELECT v.creative_id, v.version, v.review_note, v.reviewed_at, cr.name FROM creative_versions v JOIN creatives cr ON cr.id = v.creative_id WHERE v.workspace_id = ? AND v.status = 'rejected' AND v.review_note IS NOT NULL`).all(wsId) as Array<Record<string, any>>)
      add(`crej:${r.creative_id}:${r.version}`, { statement: `Creative “${r.name}” version ${r.version} was rejected in review: ${r.review_note}`, kind: "creative", sourceType: "rejected_creative", sourceRef: `${r.creative_id}:${r.version}`, observedOn: String(r.reviewed_at ?? today).slice(0, 10), limitations: "One reviewer's reason for one version. It shows what was objected to, not what an audience would think." });
    for (const r of c.db.prepare(`SELECT v.creative_id, v.version, v.concept, v.reviewed_at, cr.name FROM creative_versions v JOIN creatives cr ON cr.id = v.creative_id WHERE v.workspace_id = ? AND v.status = 'approved'`).all(wsId) as Array<Record<string, any>>) {
      let headline = ""; try { headline = (JSON.parse(r.concept) as { headline?: string }).headline ?? ""; } catch { headline = ""; }
      add(`capp:${r.creative_id}:${r.version}`, { statement: `Creative “${r.name}” version ${r.version} was approved${headline ? ` with the headline “${headline}”` : ""}.`, kind: "message", sourceType: "approved_creative", sourceRef: `${r.creative_id}:${r.version}`, observedOn: String(r.reviewed_at ?? today).slice(0, 10), limitations: "Approval is a judgement about fit with the brand and facts. It is not evidence that the creative performs." });
    }
    audit(c, wsId, actor, "learning.suggestions_generated", "learning", wsId, { added });
  })();
  return { added, ...listLearnings(c, wsId, "suggested") };
}

/* ------------------------------------------------------------------------------------------------ recommendations */

export interface Recommendation {
  key: string; kind: string; title: string; text: string;
  evidence: Array<{ type: string; id: string; label: string }>; uncertainty: string; evidenceKind: "records" | "records_and_inference";
  requiresApproval: true; approvalPermission: "recommendations.decide"; neverAutomatic: string;
  status: "open" | "accepted" | "dismissed"; decidedAt: string | null; decisionNote: string | null;
}
const NEVER = "Accepting this records your decision. It does not change any budget, campaign or creative, and nothing is published.";
const NO_PERF = "No performance data is measured by this app. Anything learned only comes from results a person enters or imports.";

/** Derived from records on every read. Each one names the records behind it and what is uncertain. */
export function recommendations(c: Core, wsId: string): { recommendations: Recommendation[]; note: string } {
  const out: Array<Omit<Recommendation, "status" | "decidedAt" | "decisionNote">> = [];
  const mk = (kind: string, subject: string, title: string, text: string, evidence: Recommendation["evidence"], uncertainty: string, inferred = false) =>
    out.push({ key: `${kind}:${subject}`, kind, title, text, evidence, uncertainty, evidenceKind: inferred ? "records_and_inference" : "records", requiresApproval: true, approvalPermission: "recommendations.decide", neverAutomatic: NEVER });

  for (const r of c.db.prepare(`SELECT k.id, k.name, COUNT(DISTINCT cr.id) n FROM campaigns k JOIN creatives cr ON cr.campaign_id = k.id AND cr.workspace_id = k.workspace_id AND cr.archived_at IS NULL
                                JOIN creative_versions v ON v.creative_id = cr.id AND v.status = 'approved'
                                WHERE k.workspace_id = ? AND k.lifecycle_state != 'archived' AND NOT EXISTS (SELECT 1 FROM experiment_variants ev WHERE ev.campaign_id = k.id AND ev.workspace_id = k.workspace_id)
                                GROUP BY k.id, k.name ORDER BY k.created_at`).all(wsId) as Array<{ id: string; name: string; n: number }>)
    mk("test_one_change", r.id, `Consider testing one change on “${r.name}”`, `This campaign has ${r.n} approved creative${r.n === 1 ? "" : "s"} and no experiment. Testing a single change (for example the headline) against the current version is the way to learn what works for this business.`,
      [{ type: "campaign", id: r.id, label: r.name }], `${NO_PERF} A test only produces something usable if real or imported results are entered, and it needs enough data to mean anything.`, true);

  for (const e of c.db.prepare("SELECT id, name FROM experiments WHERE workspace_id = ? AND status = 'running' ORDER BY created_at").all(wsId) as Array<{ id: string; name: string }>) {
    const a = experimentAnalysis(c, wsId, e.id);
    if (a.readiness === "enough_data_to_consider") mk("review_experiment", e.id, `“${e.name}” has met its planned time and data`, "The planned duration and minimum data are met. A person can now review the results against the decision rule written beforehand and conclude.",
      [{ type: "experiment", id: e.id, label: e.name }], `Meeting the plan does not make the result true: assignment to variants is unverified, and the decision rule is a human judgement. ${a.significance.assessed ? "The test shown is indicative only." : "No test was assessed."}`);
    else mk("needs_data", e.id, `“${e.name}” still needs data`, `Not ready to conclude: ${a.blocking.map((w) => w.message).join(" ")}`, [{ type: "experiment", id: e.id, label: e.name }, ...a.blocking.map((w) => ({ type: "warning", id: w.code, label: w.code.replace(/_/g, " ") }))], "Concluding now would rest on data the plan itself calls too thin.");
  }
  const withoutLearning = c.db.prepare(`SELECT e.id, e.name FROM experiments e WHERE e.workspace_id = ? AND e.status = 'concluded' AND e.outcome != 'abandoned' AND NOT EXISTS (SELECT 1 FROM learnings l WHERE l.workspace_id = e.workspace_id AND l.source_type = 'experiment' AND l.source_ref = e.id AND l.status IN ('suggested','confirmed'))`).all(wsId) as Array<{ id: string; name: string }>;
  for (const e of withoutLearning) mk("record_learning", e.id, `Record what “${e.name}” taught the team`, "This experiment is concluded but no learning from it is recorded or waiting for confirmation. Suggested learnings can be generated from it, then reviewed by a person.", [{ type: "experiment", id: e.id, label: e.name }], "A learning from one experiment, with unverified assignment, is a note to revisit, not a rule.");
  const waiting = (c.db.prepare("SELECT COUNT(*) n FROM learnings WHERE workspace_id = ? AND status = 'suggested'").get(wsId) as { n: number }).n;
  if (waiting) mk("confirm_learnings", wsId, `${waiting} learning${waiting === 1 ? "" : "s"} waiting for confirmation`, "Suggested learnings are not part of the Marketing Brain until a person confirms them.", [{ type: "learnings", id: wsId, label: `${waiting} suggested` }], "Suggestions come from plain rules over records and are low confidence by design.");
  for (const e of c.db.prepare("SELECT id, name FROM experiments WHERE workspace_id = ? AND status = 'running'").all(wsId) as Array<{ id: string; name: string }>) {
    const a = experimentAnalysis(c, wsId, e.id);
    if (a.warnings.some((w) => w.code === "only_synthetic_data")) mk("synthetic_only", e.id, `“${e.name}” has only synthetic data`, "The only data so far is synthetic. Do not use it to decide anything: it describes test records, not people.", [{ type: "experiment", id: e.id, label: e.name }], "Synthetic data cannot tell you anything about real customers.");
  }

  const decisions = new Map((c.db.prepare("SELECT rec_key, status, note, decided_at FROM recommendation_decisions WHERE workspace_id = ?").all(wsId) as Array<{ rec_key: string; status: "accepted" | "dismissed"; note: string | null; decided_at: string }>).map((r) => [r.rec_key, r]));
  return {
    recommendations: out.map((r) => { const d = decisions.get(r.key); return { ...r, status: d ? d.status : "open", decidedAt: d?.decided_at ?? null, decisionNote: d?.note ?? null }; }),
    note: "Every recommendation is derived from records in this workspace and lists them. None is a business fact, none acts by itself, and each needs a person's decision.",
  };
}

export function decideRecommendation(c: Core, wsId: string, key: string, decision: "accept" | "dismiss", input: unknown, by: string) {
  const b = LearningDecisionSchema.parse(input ?? {});
  const cur = recommendations(c, wsId).recommendations.find((r) => r.key === key);
  if (!cur) throw notFound("Recommendation");
  if (decision === "dismiss" && !b.note) throw new AppError(400, "note_required", "Say why it is being dismissed");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO recommendation_decisions (workspace_id, rec_key, status, note, decided_by, decided_at) VALUES (?,?,?,?,?,?)
                  ON CONFLICT (workspace_id, rec_key) DO UPDATE SET status = excluded.status, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at`)
      .run(wsId, key, decision === "accept" ? "accepted" : "dismissed", b.note ?? null, by, iso(c));
    audit(c, wsId, by, `recommendation.${decision === "accept" ? "accepted" : "dismissed"}`, "recommendation", createHash("sha256").update(key).digest("hex").slice(0, 16), { key, kind: cur.kind });
  })();
  return recommendations(c, wsId).recommendations.find((r) => r.key === key)!;
}
