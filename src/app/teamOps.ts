import { z } from "zod";
import type { Permission } from "../auth/authz.js";
import { getCampaignRow } from "./campaigns.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { activeMembership, listMembers } from "./memberships.js";
import { newId } from "./util.js";

/**
 * Team operations: who owns and reviews what, dated work, an inbox of what needs a person, a calendar, and in-app notifications.
 *
 * Honest limits, stated here because the screens repeat them:
 *  - owner and reviewer are COORDINATION. They never grant a permission, never replace approval, and never bypass separation of duties;
 *  - a due date is a plain calendar date (no time zone is modelled yet) and "overdue" compares it with today's UTC date;
 *  - a "proposed schedule" is a date the team intends to act on. Nothing is scheduled on any ad platform;
 *  - notifications are in-app only for signed-in people. Email, SMS and push do not exist and nothing is sent anywhere;
 *  - the shared workspace token is not a person: it can have no assignments, no inbox of its own and no notifications.
 */

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, "That is not a real date");
const USER = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const WORK_KINDS = ["draft", "review", "approval", "run", "schedule_proposal", "other"] as const;
export const KIND_LABEL: Record<(typeof WORK_KINDS)[number], string> = { draft: "Finish the draft", review: "Review", approval: "Approve or reject", run: "Run (simulated)", schedule_proposal: "Proposed date", other: "Other" };

export const OwnershipSchema = z.object({ subjectType: z.enum(["campaign", "creative"]), subjectId: z.string().regex(/^[a-z0-9_]{1,64}$/), ownerUserId: USER.nullable().optional(), reviewerUserId: USER.nullable().optional() }).strict();
export const WorkItemSchema = z.object({
  campaignId: z.string().regex(/^[a-z0-9_]{1,64}$/), creativeId: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(), creativeVersion: z.number().int().min(1).optional(),
  proposalId: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(), kind: z.enum(WORK_KINDS), title: text(120), dueDate: DATE.optional(), ownerUserId: USER.optional(), reviewerUserId: USER.optional(),
}).strict();
export const WorkItemPatchSchema = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(), title: text(120).optional(), dueDate: DATE.nullable().optional(), ownerUserId: USER.nullable().optional(), reviewerUserId: USER.nullable().optional(),
}).strict();

const today = (c: Core) => iso(c).slice(0, 10);
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");
const userIdOf = (actorLabel: string): string | null => (actorLabel.startsWith("user:") ? actorLabel.slice(5) : null);
const nameOf = (c: Core, userId: string | null): string | null => {
  if (!userId) return null;
  const r = c.db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string | null } | undefined;
  return r ? r.display_name ?? "Team member" : null;
};
function requireMember(c: Core, wsId: string, userId: string, what: string): void {
  if (!activeMembership(c, userId, wsId)) throw new AppError(400, "not_a_member", `${what} must be an active member of this workspace`);
}

/** People who can be assigned. Display name and role only: no e-mail address. */
export function assignees(c: Core, wsId: string) {
  return { assignees: listMembers(c, wsId).filter((m) => m.status === "active").map((m) => ({ userId: m.userId as string, name: (m.displayName as string | null) ?? "Team member", role: m.role as string })) };
}

/* ------------------------------------------------------------------------------------------------ notifications (in-app only) */

export function notify(c: Core, wsId: string, userId: string | null, kind: string, message: string, subject?: { type: string; id: string }): void {
  if (!userId || !activeMembership(c, userId, wsId)) return;
  c.db.prepare("INSERT INTO notifications (id, workspace_id, user_id, kind, text, subject_type, subject_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(newId("ntf"), wsId, userId, kind, message.slice(0, 300), subject?.type ?? null, subject?.id ?? null, iso(c));
}
export function listNotifications(c: Core, wsId: string, userId: string | null) {
  if (!userId) return { available: false as const, reason: "Notifications are for signed-in people. The shared workspace token is not a person.", unread: 0, notifications: [] };
  const rows = c.db.prepare("SELECT id, kind, text, subject_type, subject_id, created_at, read_at FROM notifications WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC, id LIMIT 50").all(wsId, userId) as Array<Record<string, string | null>>;
  return { available: true as const, reason: null, unread: rows.filter((r) => !r.read_at).length, notifications: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, subjectType: r.subject_type, subjectId: r.subject_id, createdAt: r.created_at, read: !!r.read_at })) };
}
export function markNotificationsRead(c: Core, wsId: string, userId: string | null, id?: string) {
  if (!userId) throw new AppError(403, "not_a_person", "Notifications are for signed-in people");
  if (id) { if (c.db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND workspace_id = ? AND user_id = ?").run(iso(c), id, wsId, userId).changes !== 1) throw notFound("Notification"); }
  else c.db.prepare("UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL").run(iso(c), wsId, userId);
  return listNotifications(c, wsId, userId);
}

/* ------------------------------------------------------------------------------------------------ ownership */

interface OwnRow { owner_user_id: string | null; reviewer_user_id: string | null }
export function ownershipOf(c: Core, wsId: string, type: "campaign" | "creative", id: string) {
  const r = c.db.prepare("SELECT owner_user_id, reviewer_user_id FROM ownerships WHERE workspace_id = ? AND subject_type = ? AND subject_id = ?").get(wsId, type, id) as OwnRow | undefined;
  return { ownerUserId: r?.owner_user_id ?? null, ownerName: nameOf(c, r?.owner_user_id ?? null), reviewerUserId: r?.reviewer_user_id ?? null, reviewerName: nameOf(c, r?.reviewer_user_id ?? null) };
}
/** A creative's reviewer, falling back to its campaign's reviewer. */
export function reviewerFor(c: Core, wsId: string, creativeId: string | null, campaignId: string): string | null {
  return (creativeId ? ownershipOf(c, wsId, "creative", creativeId).reviewerUserId : null) ?? ownershipOf(c, wsId, "campaign", campaignId).reviewerUserId;
}

function subjectName(c: Core, wsId: string, type: "campaign" | "creative", id: string): string {
  const r = (type === "campaign" ? c.db.prepare("SELECT name FROM campaigns WHERE id = ? AND workspace_id = ?") : c.db.prepare("SELECT name FROM creatives WHERE id = ? AND workspace_id = ?")).get(id, wsId) as { name: string } | undefined;
  if (!r) throw notFound(type === "campaign" ? "Campaign" : "Creative");
  return r.name;
}

export function setOwnership(c: Core, wsId: string, actor: string, input: unknown) {
  const b = OwnershipSchema.parse(input);
  const name = subjectName(c, wsId, b.subjectType, b.subjectId);
  const cur = ownershipOf(c, wsId, b.subjectType, b.subjectId);
  const owner = b.ownerUserId === undefined ? cur.ownerUserId : b.ownerUserId;
  const reviewer = b.reviewerUserId === undefined ? cur.reviewerUserId : b.reviewerUserId;
  if (owner) requireMember(c, wsId, owner, "The owner");
  if (reviewer) requireMember(c, wsId, reviewer, "The reviewer");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO ownerships (workspace_id, subject_type, subject_id, owner_user_id, reviewer_user_id, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)
                  ON CONFLICT (workspace_id, subject_type, subject_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, reviewer_user_id = excluded.reviewer_user_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(wsId, b.subjectType, b.subjectId, owner, reviewer, iso(c), actor);
    audit(c, wsId, actor, "ownership.set", b.subjectType, b.subjectId, { owner, reviewer });
    const me = userIdOf(actor);
    if (owner && owner !== cur.ownerUserId && owner !== me) notify(c, wsId, owner, "assigned_owner", `You are now the owner of ${b.subjectType} “${name}”.`, { type: b.subjectType, id: b.subjectId });
    if (reviewer && reviewer !== cur.reviewerUserId && reviewer !== me) notify(c, wsId, reviewer, "assigned_reviewer", `You are now the reviewer of ${b.subjectType} “${name}”.`, { type: b.subjectType, id: b.subjectId });
  })();
  return ownershipOf(c, wsId, b.subjectType, b.subjectId);
}

/* ------------------------------------------------------------------------------------------------ work items */

interface WorkRow {
  id: string; campaign_id: string; campaign_version: number; creative_id: string | null; creative_version: number | null; proposal_id: string | null; kind: (typeof WORK_KINDS)[number]; title: string; required_action: string;
  owner_user_id: string | null; reviewer_user_id: string | null; due_date: string | null; status: "open" | "done" | "cancelled"; closed_reason: string | null; created_at: string; created_by: string; completed_at: string | null;
  campaign_name: string; campaign_current: number; creative_name: string | null; creative_current_version: number | null; creative_approved_version: number | null; proposal_status: string | null;
}
const WORK_SQL = `SELECT w.*, c.name AS campaign_name, c.current_version AS campaign_current, cr.name AS creative_name, cr.current_version AS creative_current_version,
    (SELECT MAX(version) FROM creative_versions v WHERE v.creative_id = w.creative_id AND v.status = 'approved') AS creative_approved_version, p.status AS proposal_status
  FROM work_items w JOIN campaigns c ON c.id = w.campaign_id LEFT JOIN creatives cr ON cr.id = w.creative_id LEFT JOIN action_proposals p ON p.id = w.proposal_id`;

function workView(c: Core, w: WorkRow) {
  const open = w.status === "open";
  // Is the exact thing this item points at still the thing to act on? Said plainly, never hidden.
  const notes: string[] = [];
  if (open && w.campaign_current !== w.campaign_version) notes.push(`The campaign has moved from version ${w.campaign_version} to ${w.campaign_current} since this was set up.`);
  if (open && w.creative_id && w.creative_version !== null && w.creative_current_version !== null && w.creative_current_version > w.creative_version) notes.push(`Creative version ${w.creative_version} has been replaced by version ${w.creative_current_version}.`);
  const overdue = open && !!w.due_date && w.due_date < today(c);
  return {
    id: w.id, kind: w.kind, kindLabel: KIND_LABEL[w.kind], title: w.title, requiredAction: w.required_action, status: w.status, closedReason: w.closed_reason, dueDate: w.due_date, overdue,
    campaign: { id: w.campaign_id, name: w.campaign_name, version: w.campaign_version },
    creative: w.creative_id ? { id: w.creative_id, name: w.creative_name, version: w.creative_version } : null,
    proposal: w.proposal_id ? { id: w.proposal_id, status: w.proposal_status } : null,
    owner: w.owner_user_id ? { userId: w.owner_user_id, name: nameOf(c, w.owner_user_id) } : null, reviewer: w.reviewer_user_id ? { userId: w.reviewer_user_id, name: nameOf(c, w.reviewer_user_id) } : null,
    proposedOnly: w.kind === "schedule_proposal", notes, createdAt: w.created_at, createdByKind: kindOf(w.created_by), completedAt: w.completed_at,
  };
}
const getWork = (c: Core, wsId: string, id: string): WorkRow => {
  const r = c.db.prepare(`${WORK_SQL} WHERE w.id = ? AND w.workspace_id = ?`).get(id, wsId) as WorkRow | undefined;
  if (!r) throw notFound("Work item");
  return r;
};

export function listWorkItems(c: Core, wsId: string, status?: string) {
  const rows = c.db.prepare(`${WORK_SQL} WHERE w.workspace_id = ? ${status && ["open", "done", "cancelled"].includes(status) ? "AND w.status = ?" : ""} ORDER BY (w.due_date IS NULL), w.due_date, w.created_at DESC, w.id LIMIT 200`)
    .all(...(status && ["open", "done", "cancelled"].includes(status) ? [wsId, status] : [wsId])) as WorkRow[];
  return { workItems: rows.map((r) => workView(c, r)) };
}

export function createWorkItem(c: Core, wsId: string, actor: string, input: unknown) {
  const b = WorkItemSchema.parse(input);
  const camp = getCampaignRow(c, wsId, b.campaignId);
  let creativeName: string | null = null;
  if (b.creativeId) {
    const cr = c.db.prepare("SELECT name, campaign_id FROM creatives WHERE id = ? AND workspace_id = ?").get(b.creativeId, wsId) as { name: string; campaign_id: string } | undefined;
    if (!cr) throw notFound("Creative");
    if (cr.campaign_id !== b.campaignId) throw new AppError(400, "creative_not_in_campaign", "That creative belongs to a different campaign");
    creativeName = cr.name;
    const ver = b.creativeVersion ?? (c.db.prepare("SELECT current_version FROM creatives WHERE id = ?").get(b.creativeId) as { current_version: number }).current_version;
    if (!c.db.prepare("SELECT 1 FROM creative_versions WHERE creative_id = ? AND version = ? AND workspace_id = ?").get(b.creativeId, ver, wsId)) throw notFound("Creative version");
    b.creativeVersion = ver;
  } else if (b.creativeVersion !== undefined) throw new AppError(400, "creative_required", "A creative version needs a creative");
  if (b.proposalId) {
    const p = c.db.prepare("SELECT campaign_id FROM action_proposals WHERE id = ? AND workspace_id = ?").get(b.proposalId, wsId) as { campaign_id: string } | undefined;
    if (!p) throw notFound("Proposal");
    if (p.campaign_id !== b.campaignId) throw new AppError(400, "proposal_not_in_campaign", "That proposal belongs to a different campaign");
  }
  if (b.kind === "review" && !b.creativeId) throw new AppError(400, "creative_required", "A review task needs the creative (and version) to review");
  if ((b.kind === "approval" || b.kind === "run") && !b.proposalId) throw new AppError(400, "proposal_required", `A ${b.kind} task needs the proposal it is about`);
  if (b.ownerUserId) requireMember(c, wsId, b.ownerUserId, "The owner");
  if (b.reviewerUserId) requireMember(c, wsId, b.reviewerUserId, "The reviewer");
  const action = {
    draft: `Finish and check the draft of “${camp.name}” (version ${camp.current_version})`,
    review: `Review creative “${creativeName}” version ${b.creativeVersion}`,
    approval: `Approve or reject the proposal for “${camp.name}” (campaign version ${camp.current_version})`,
    run: `Run the approved proposal for “${camp.name}” (simulated)`,
    schedule_proposal: `Decide whether to act on “${camp.name}” on this date. Proposed only: nothing is scheduled on any ad platform`,
    other: b.title,
  }[b.kind];
  const id = newId("wrk");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO work_items (id, workspace_id, campaign_id, campaign_version, creative_id, creative_version, proposal_id, kind, title, required_action, owner_user_id, reviewer_user_id, due_date, status, created_at, created_by, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`)
      .run(id, wsId, b.campaignId, camp.current_version, b.creativeId ?? null, b.creativeVersion ?? null, b.proposalId ?? null, b.kind, b.title, action, b.ownerUserId ?? null, b.reviewerUserId ?? null, b.dueDate ?? null, iso(c), actor, iso(c));
    audit(c, wsId, actor, "work_item.created", "work_item", id, { kind: b.kind, campaignId: b.campaignId, creativeId: b.creativeId ?? null, creativeVersion: b.creativeVersion ?? null, dueDate: b.dueDate ?? null });
    const me = userIdOf(actor);
    for (const [u, role] of [[b.ownerUserId, "owner"], [b.reviewerUserId, "reviewer"]] as const) if (u && u !== me) notify(c, wsId, u, "assigned_task", `You are the ${role} of the task “${b.title}”${b.dueDate ? `, due ${b.dueDate}` : ""}.`, { type: "work_item", id });
  })();
  return workView(c, getWork(c, wsId, id));
}

export function updateWorkItem(c: Core, wsId: string, actor: string, id: string, input: unknown) {
  const b = WorkItemPatchSchema.parse(input);
  const w = getWork(c, wsId, id);
  if (b.ownerUserId) requireMember(c, wsId, b.ownerUserId, "The owner");
  if (b.reviewerUserId) requireMember(c, wsId, b.reviewerUserId, "The reviewer");
  const status = b.status ?? w.status;
  if (w.status !== "open" && b.status === undefined) throw conflict("work_item_closed", `This item is ${w.status}. Reopen it first.`);
  const owner = b.ownerUserId === undefined ? w.owner_user_id : b.ownerUserId;
  const reviewer = b.reviewerUserId === undefined ? w.reviewer_user_id : b.reviewerUserId;
  const closing = status !== "open" && w.status === "open";
  c.db.transaction(() => {
    c.db.prepare(`UPDATE work_items SET title = ?, due_date = ?, owner_user_id = ?, reviewer_user_id = ?, status = ?, closed_reason = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(b.title ?? w.title, b.dueDate === undefined ? w.due_date : b.dueDate, owner, reviewer, status, closing ? (status === "done" ? "done_by_person" : "cancelled_by_person") : status === "open" ? null : w.closed_reason,
        closing ? iso(c) : status === "open" ? null : w.completed_at, closing ? actor : null, iso(c), id, wsId);
    audit(c, wsId, actor, "work_item.updated", "work_item", id, { status, dueDate: b.dueDate === undefined ? w.due_date : b.dueDate, owner, reviewer });
    const me = userIdOf(actor);
    if (owner && owner !== w.owner_user_id && owner !== me) notify(c, wsId, owner, "assigned_task", `You are now the owner of the task “${b.title ?? w.title}”.`, { type: "work_item", id });
    if (reviewer && reviewer !== w.reviewer_user_id && reviewer !== me) notify(c, wsId, reviewer, "assigned_task", `You are now the reviewer of the task “${b.title ?? w.title}”.`, { type: "work_item", id });
  })();
  return workView(c, getWork(c, wsId, id));
}

/**
 * Closes the open tasks that were waiting for a decision that has just been made, so the inbox never keeps asking for something already done.
 * Called inside the decision's own transaction by the creative and proposal services.
 */
export function closeWorkItemsFor(c: Core, wsId: string, match: { kind: "review" | "approval" | "run"; creativeId?: string; creativeVersion?: number; proposalId?: string }, reason: string): number {
  const r = match.kind === "review"
    ? c.db.prepare("UPDATE work_items SET status = 'done', closed_reason = ?, completed_at = ?, updated_at = ? WHERE workspace_id = ? AND kind = 'review' AND status = 'open' AND creative_id = ? AND creative_version = ?").run(reason, iso(c), iso(c), wsId, match.creativeId ?? "", match.creativeVersion ?? -1)
    : c.db.prepare("UPDATE work_items SET status = 'done', closed_reason = ?, completed_at = ?, updated_at = ? WHERE workspace_id = ? AND kind = ? AND status = 'open' AND proposal_id = ?").run(reason, iso(c), iso(c), wsId, match.kind, match.proposalId ?? "");
  return r.changes;
}

/* ------------------------------------------------------------------------------------------------ inbox */

export interface Viewer { userId: string | null; can: (p: Permission) => boolean }
interface InboxItem {
  kind: string; title: string; action: string; why: string; subject: { type: string; id: string; version?: number | null; name: string }; campaignId: string | null;
  dueDate?: string | null; overdue?: boolean; assignedToYou: boolean; reviewer: string | null; canAct: boolean; actionPermission?: string | null; go: string;
}

export function inbox(c: Core, wsId: string, v: Viewer) {
  const me = v.userId;
  const nameCache = new Map<string, string | null>();
  const nm = (u: string | null) => { if (!u) return null; if (!nameCache.has(u)) nameCache.set(u, nameOf(c, u)); return nameCache.get(u) ?? null; };

  // ---- 1. tasks assigned to this person (a signed-in person only)
  const mine: ReturnType<typeof workView>[] = me
    ? (c.db.prepare(`${WORK_SQL} WHERE w.workspace_id = ? AND w.status = 'open' AND (w.owner_user_id = ? OR w.reviewer_user_id = ?) ORDER BY (w.due_date IS NULL), w.due_date, w.created_at LIMIT 100`).all(wsId, me, me) as WorkRow[]).map((r) => workView(c, r))
    : [];

  // ---- 2. decisions waiting for a person, derived from the real records, each pointing at the exact version
  const waiting: InboxItem[] = [];
  for (const p of c.db.prepare(`SELECT p.id, p.campaign_id, p.campaign_version, c.name FROM action_proposals p JOIN campaigns c ON c.id = p.campaign_id WHERE p.workspace_id = ? AND p.status = 'proposed' ORDER BY p.created_at`).all(wsId) as Array<{ id: string; campaign_id: string; campaign_version: number; name: string }>) {
    const rev = ownershipOf(c, wsId, "campaign", p.campaign_id).reviewerUserId;
    waiting.push({ kind: "proposal_approval", title: p.name, action: `Approve or reject the proposal (campaign version ${p.campaign_version})`, why: "Nothing runs until a person approves it. Approving does not run it.", subject: { type: "proposal", id: p.id, version: p.campaign_version, name: p.name }, campaignId: p.campaign_id, assignedToYou: !!me && rev === me, reviewer: nm(rev), canAct: v.can("proposals.decide"), actionPermission: "proposals.decide", go: "review" });
  }
  for (const r of c.db.prepare(`SELECT v.creative_id, v.version, cr.name, cr.campaign_id FROM creative_versions v JOIN creatives cr ON cr.id = v.creative_id WHERE v.workspace_id = ? AND v.status = 'needs_review' AND cr.archived_at IS NULL ORDER BY v.submitted_at`).all(wsId) as Array<{ creative_id: string; version: number; name: string; campaign_id: string }>) {
    const rev = reviewerFor(c, wsId, r.creative_id, r.campaign_id);
    waiting.push({ kind: "creative_review", title: r.name, action: `Review creative version ${r.version}`, why: "The pictures and copy were sent for review. Approval covers exactly this version.", subject: { type: "creative", id: r.creative_id, version: r.version, name: r.name }, campaignId: r.campaign_id, assignedToYou: !!me && rev === me, reviewer: nm(rev), canAct: v.can("creatives.review"), actionPermission: "creatives.review", go: "creative" });
  }
  const kit = c.db.prepare("SELECT current_version, status FROM brand_kits WHERE workspace_id = ?").get(wsId) as { current_version: number; status: string } | undefined;
  if (kit?.status === "needs_review") waiting.push({ kind: "brand_kit_review", title: "Brand Kit", action: `Approve or reject Brand Kit version ${kit.current_version}`, why: "Creative checks use the approved Brand Kit.", subject: { type: "brand_kit", id: wsId, version: kit.current_version, name: "Brand Kit" }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("brandkit.approve"), actionPermission: "brandkit.approve", go: "brand" });
  for (const a of c.db.prepare(`SELECT av.asset_id, av.version, a.name FROM asset_versions av JOIN assets a ON a.id = av.asset_id WHERE av.workspace_id = ? AND av.status = 'needs_review' AND a.archived_at IS NULL ORDER BY av.submitted_at`).all(wsId) as Array<{ asset_id: string; version: number; name: string }>)
    waiting.push({ kind: "asset_review", title: a.name, action: `Review asset version ${a.version}`, why: "An asset cannot be relied on until a version is approved.", subject: { type: "asset", id: a.asset_id, version: a.version, name: a.name }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("assets.review"), actionPermission: "assets.review", go: "brand" });
  for (const p of c.db.prepare(`SELECT p.id, p.campaign_id, p.campaign_version, c.name FROM action_proposals p JOIN campaigns c ON c.id = p.campaign_id WHERE p.workspace_id = ? AND p.status = 'approved' ORDER BY p.updated_at`).all(wsId) as Array<{ id: string; campaign_id: string; campaign_version: number; name: string }>)
    waiting.push({ kind: "approved_not_run", title: p.name, action: `Run the approved proposal (campaign version ${p.campaign_version}), simulated`, why: "Approving did not run it. Someone allowed to run approved actions has to.", subject: { type: "proposal", id: p.id, version: p.campaign_version, name: p.name }, campaignId: p.campaign_id, assignedToYou: false, reviewer: null, canAct: v.can("proposals.execute"), actionPermission: "proposals.execute", go: "review" });

  const sug = (c.db.prepare("SELECT COUNT(*) n FROM learnings WHERE workspace_id = ? AND status = 'suggested'").get(wsId) as { n: number }).n;
  if (sug) waiting.push({ kind: "learning_review", title: "Marketing Brain", action: `Confirm or reject ${sug} suggested learning${sug === 1 ? "" : "s"}`, why: "A suggestion is not part of the Marketing Brain until a person confirms it.", subject: { type: "learnings", id: wsId, name: "Learnings" }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("learnings.confirm"), actionPermission: "learnings.confirm", go: "learning" });
  for (const e of c.db.prepare("SELECT id, name, started_at, duration_days FROM experiments WHERE workspace_id = ? AND status = 'running'").all(wsId) as Array<{ id: string; name: string; started_at: string; duration_days: number }>)
    if (Date.parse(e.started_at) + e.duration_days * 86400000 <= c.now().getTime()) waiting.push({ kind: "experiment_review", title: e.name, action: "Review the results and conclude, or note why not", why: "The planned duration has passed. Whether the data is enough is a person's judgement.", subject: { type: "experiment", id: e.id, name: e.name }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("experiments.decide"), actionPermission: "experiments.decide", go: "learning" });

  // ---- 3. problems: failed or blocked work, with the action that exists for it
  const problems: InboxItem[] = [];
  for (const j of c.db.prepare("SELECT id, type, last_error FROM jobs WHERE workspace_id = ? AND status = 'dead' ORDER BY updated_at DESC LIMIT 20").all(wsId) as Array<{ id: string; type: string; last_error: string | null }>)
    problems.push({ kind: "job_failed", title: `A background job failed (${j.type})`, action: "See Problems & retries", why: j.last_error ? `It stopped with: ${j.last_error.split("\n")[0]!.slice(0, 160)}` : "It used all its attempts.", subject: { type: "job", id: j.id, name: j.type }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("jobs.retry"), actionPermission: "jobs.retry", go: "ops" });
  for (const r of c.db.prepare(`SELECT r.id, r.creative_id, r.creative_version, r.ratio, r.error_code, r.error_message, cr.name, cr.campaign_id FROM creative_renders r JOIN creatives cr ON cr.id = r.creative_id
                                WHERE r.workspace_id = ? AND r.status = 'failed' AND cr.archived_at IS NULL ORDER BY r.finished_at DESC LIMIT 20`).all(wsId) as Array<{ id: string; creative_id: string; creative_version: number; ratio: string; error_code: string | null; error_message: string | null; name: string; campaign_id: string }>)
    problems.push({ kind: "render_failed", title: `${r.name}: the ${r.ratio} picture failed`, action: `Try the ${r.ratio} picture again, or attach an approved image (creative version ${r.creative_version})`, why: r.error_message ?? r.error_code ?? "It failed.", subject: { type: "creative", id: r.creative_id, version: r.creative_version, name: r.name }, campaignId: r.campaign_id, assignedToYou: false, reviewer: null, canAct: v.can("creatives.write"), actionPermission: "creatives.write", go: "creative" });
  const brain = c.db.prepare("SELECT 1 FROM business_brains WHERE workspace_id = ?").get(wsId);
  if (!brain) problems.push({ kind: "brain_missing", title: "Your Business Brain is not saved", action: "Fill in and save My business", why: "Campaigns are written from it, so nothing can be drafted until it is saved.", subject: { type: "business_brain", id: wsId, name: "Business Brain" }, campaignId: null, assignedToYou: false, reviewer: null, canAct: v.can("brain.write"), actionPermission: "brain.write", go: "brain" });
  for (const r of c.db.prepare(`SELECT c.id, c.name, c.current_version, ve.brief FROM campaigns c JOIN campaign_versions ve ON ve.campaign_id = c.id AND ve.workspace_id = c.workspace_id AND ve.version = c.current_version WHERE c.workspace_id = ? AND c.status = 'draft' AND c.lifecycle_state != 'archived' ORDER BY c.created_at DESC`).all(wsId) as Array<{ id: string; name: string; current_version: number; brief: string }>) {
    let n = 0;
    try { n = ((JSON.parse(r.brief) as { openQuestions?: Array<{ blocking?: boolean }> }).openQuestions ?? []).filter((q) => q && q.blocking === true).length; } catch { n = 0; }
    if (n) problems.push({ kind: "blocking_questions", title: r.name, action: `Answer ${n} blocking question${n === 1 ? "" : "s"} (campaign version ${r.current_version})`, why: "The campaign cannot be proposed until these are answered.", subject: { type: "campaign", id: r.id, version: r.current_version, name: r.name }, campaignId: r.id, assignedToYou: false, reviewer: null, canAct: v.can("campaigns.edit"), actionPermission: "campaigns.edit", go: "campaigns" });
  }

  // ---- 4. dated work: overdue and the next two weeks
  const t = today(c);
  const horizon = new Date(new Date(`${t}T00:00:00Z`).getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const dates = (c.db.prepare(`${WORK_SQL} WHERE w.workspace_id = ? AND w.status = 'open' AND w.due_date IS NOT NULL AND w.due_date <= ? ORDER BY w.due_date, w.created_at LIMIT 100`).all(wsId, horizon) as WorkRow[]).map((r) => workView(c, r));

  return {
    viewer: { isPerson: me !== null, note: me ? null : "You are using the shared workspace token, which is not a person: tasks cannot be assigned to it, so “Assigned to you” stays empty. Everything else is shown." },
    assignedToYou: mine, waiting, problems, dates, today: t,
    counts: { assignedToYou: mine.length, waiting: waiting.length, waitingYouCanAct: waiting.filter((w) => w.canAct).length, problems: problems.length, overdue: dates.filter((d) => d.overdue).length, dueSoon: dates.filter((d) => !d.overdue).length },
  };
}

/* ------------------------------------------------------------------------------------------------ calendar */

const MAX_RANGE_DAYS = 62;
export function calendar(c: Core, wsId: string, from?: string, to?: string) {
  const t = today(c);
  const f = from ? DATE.parse(from) : t;
  const e = to ? DATE.parse(to) : new Date(new Date(`${f}T00:00:00Z`).getTime() + 27 * 86400000).toISOString().slice(0, 10);
  if (e < f) throw new AppError(400, "bad_range", "The end of the range is before its start");
  if ((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000 > MAX_RANGE_DAYS) throw new AppError(400, "range_too_long", `Pick at most ${MAX_RANGE_DAYS} days at a time`);
  const entries: Array<Record<string, unknown>> = [];
  for (const r of c.db.prepare(`${WORK_SQL} WHERE w.workspace_id = ? AND w.status != 'cancelled' AND w.due_date BETWEEN ? AND ? ORDER BY w.due_date, w.created_at`).all(wsId, f, e) as WorkRow[]) {
    const w = workView(c, r);
    const job = r.proposal_id ? (c.db.prepare("SELECT status, attempts, max_attempts FROM jobs WHERE workspace_id = ? AND dedupe_key = ?").get(wsId, `exec:${r.proposal_id}`) as { status: string; attempts: number; max_attempts: number } | undefined) ?? null : null;
    entries.push({ date: r.due_date, source: "work_item", type: r.kind, label: r.kind === "schedule_proposal" ? "Proposed date (not a platform schedule)" : KIND_LABEL[r.kind], title: r.title, requiredAction: r.required_action, status: r.status, overdue: w.overdue,
      campaign: w.campaign, creative: w.creative, proposal: w.proposal, owner: w.owner, reviewer: w.reviewer, job, notes: w.notes, id: r.id });
  }
  // real dates that already exist in the records: an approval stops counting after 24 hours
  for (const r of c.db.prepare(`SELECT p.id, p.campaign_id, p.campaign_version, c.name, a.expires_at FROM action_proposals p JOIN campaigns c ON c.id = p.campaign_id
                                JOIN approvals a ON a.proposal_id = p.id AND a.decision = 'approve' WHERE p.workspace_id = ? AND p.status = 'approved' AND substr(a.expires_at, 1, 10) BETWEEN ? AND ? ORDER BY a.expires_at`).all(wsId, f, e) as Array<{ id: string; campaign_id: string; campaign_version: number; name: string; expires_at: string }>)
    entries.push({ date: r.expires_at.slice(0, 10), source: "record", type: "approval_expires", label: "Approval expires", title: r.name, requiredAction: `Run the approved proposal (campaign version ${r.campaign_version}) before ${r.expires_at.replace("T", " ").slice(0, 16)} UTC, or it must be approved again`, status: "open",
      overdue: false, campaign: { id: r.campaign_id, name: r.name, version: r.campaign_version }, creative: null, proposal: { id: r.id, status: "approved" }, owner: null, reviewer: null, job: null, notes: [], id: null });
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    from: f, to: e, today: t, entries,
    notes: ["Dates are plain calendar dates; no time zone is modelled yet and “overdue” compares with today's UTC date.", "Every date here is internal coordination. Nothing is scheduled on any ad platform: in this release nothing runs outside this computer."],
    platformSchedule: false,
  };
}
