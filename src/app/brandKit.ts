import { z } from "zod";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict } from "./errors.js";
import { separationOutcome, type SeparationOutcome } from "./workspacePolicy.js";

/**
 * The Brand Kit: how a business wants to SOUND and LOOK. It is a separate document from the Business Brain on purpose. A brand preference ("friendly", "use
 * deep blue") is not evidence that a business claim is true, so nothing in a Brand Kit can make a claim usable in an ad: claims still come only from reviewed
 * Business Brain facts. Disclaimer wording is stored here as wording the owner wants shown, not as a fact about the business.
 *
 * Lifecycle: every save is a new immutable version and returns the kit to "draft". A person submits a version for review; a different person (when separation
 * of duties is on) approves or rejects exactly that version. Editing after approval creates a newer draft, so an approval never covers text it did not see.
 */

const line = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const note = (max: number) => z.string().trim().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");

export const COLOR_ROLES = ["primary", "secondary", "accent", "neutral", "background", "text"] as const;

export const BrandKitSchema = z.object({
  voice: z.object({
    descriptors: z.array(line(40)).max(10).default([]),
    preferredTerms: z.array(line(60)).max(30).default([]),
    avoidTerms: z.array(line(60)).max(30).default([]),
    ctaStyle: note(200).default(""),
  }).strict().default({}),
  visual: z.object({
    colors: z.array(z.object({ name: line(40), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #1A4D8F"), role: z.enum(COLOR_ROLES) }).strict()).max(12).default([]),
    typography: note(500).default(""),
    imageStyle: note(500).default(""),
    logoRules: note(500).default(""),
    referenceAssetIds: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(20).default([]),
  }).strict().default({}),
  /** The owner's own description of who they want to reach. A hypothesis for planning, not evidence about real customers. */
  audiences: z.array(z.object({ name: line(60), description: note(300).default("") }).strict()).max(8).default([]),
  channels: z.array(z.object({ channel: line(40), notes: note(300).default("") }).strict()).max(10).default([]),
  disclaimers: z.array(z.object({ text: line(300), appliesTo: note(100).default("") }).strict()).max(10).default([]),
  notes: note(1000).default(""),
}).strict();
export type BrandKit = z.infer<typeof BrandKitSchema>;
export const EMPTY_BRAND_KIT: BrandKit = BrandKitSchema.parse({});

export const BrandKitDecisionSchema = z.object({ version: z.number().int().min(1), reason: note(300).optional() }).strict();

const SECTIONS = ["voice", "visual", "audiences", "channels", "disclaimers", "notes"] as const;
const SECTION_LABEL: Record<(typeof SECTIONS)[number], string> = { voice: "Voice", visual: "Look", audiences: "Audiences", channels: "Channels", disclaimers: "Disclaimers", notes: "Notes" };

interface KitRow {
  current_version: number; status: "draft" | "needs_review" | "approved" | "rejected"; submitted_by: string | null; submitted_at: string | null; decided_by: string | null;
  decided_at: string | null; decision_reason: string | null; approved_version: number | null; separation: string | null; updated_at: string;
}
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

function dataOf(c: Core, wsId: string, version: number): BrandKit {
  const r = c.db.prepare("SELECT data FROM brand_kit_versions WHERE workspace_id = ? AND version = ?").get(wsId, version) as { data: string } | undefined;
  return r ? BrandKitSchema.parse(JSON.parse(r.data)) : EMPTY_BRAND_KIT;
}

export function brandKitView(c: Core, wsId: string) {
  const row = c.db.prepare("SELECT * FROM brand_kits WHERE workspace_id = ?").get(wsId) as KitRow | undefined;
  if (!row) return { exists: false as const, version: 0, status: "draft" as const, kit: EMPTY_BRAND_KIT, approvedVersion: null, approved: null, decision: null, submittedAt: null, submittedByKind: null, updatedAt: null };
  return {
    exists: true as const,
    version: row.current_version,
    status: row.status,
    kit: dataOf(c, wsId, row.current_version),
    /** The version the last approval covered, and its content: what later work may rely on. NULL until a version has been approved. */
    approvedVersion: row.approved_version,
    approved: row.approved_version ? dataOf(c, wsId, row.approved_version) : null,
    submittedAt: row.submitted_at,
    submittedByKind: kindOf(row.submitted_by),
    decision: row.decided_at ? { at: row.decided_at, byKind: kindOf(row.decided_by), reason: row.decision_reason, separation: row.separation } : null,
    updatedAt: row.updated_at,
  };
}

/** A saved kit may only point at reference assets that belong to THIS workspace. */
function checkReferences(c: Core, wsId: string, kit: BrandKit): void {
  for (const id of kit.visual.referenceAssetIds) {
    if (!c.db.prepare("SELECT 1 FROM assets WHERE id = ? AND workspace_id = ?").get(id, wsId)) throw new AppError(400, "unknown_reference_asset", "A reference asset is not in this workspace's library");
  }
}

const changedSections = (a: BrandKit, b: BrandKit) => SECTIONS.filter((s) => JSON.stringify(a[s]) !== JSON.stringify(b[s]));

/** Saves the kit as a new version (a no-op if nothing changed) and returns it to draft. Never touches the approved version's content. */
export function saveBrandKit(c: Core, wsId: string, actor: string, input: unknown) {
  const kit = BrandKitSchema.parse(input);
  checkReferences(c, wsId, kit);
  const row = c.db.prepare("SELECT * FROM brand_kits WHERE workspace_id = ?").get(wsId) as KitRow | undefined;
  const at = iso(c);
  if (row && JSON.stringify(dataOf(c, wsId, row.current_version)) === JSON.stringify(kit)) return brandKitView(c, wsId); // nothing changed: no new version, no withdrawn approval
  const version = (row?.current_version ?? 0) + 1;
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO brand_kit_versions (workspace_id, version, data, created_at, created_by) VALUES (?,?,?,?,?)").run(wsId, version, JSON.stringify(kit), at, actor);
    if (row) c.db.prepare("UPDATE brand_kits SET current_version = ?, status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = ? WHERE workspace_id = ?").run(version, at, wsId);
    else c.db.prepare("INSERT INTO brand_kits (workspace_id, current_version, status, updated_at) VALUES (?,?,'draft',?)").run(wsId, version, at);
    const changed = changedSections(row ? dataOf(c, wsId, row.current_version) : EMPTY_BRAND_KIT, kit);
    audit(c, wsId, actor, "brandkit.saved", "brand_kit", wsId, { version, changed, approvalWithdrawn: row?.status === "approved" });
  })();
  return brandKitView(c, wsId);
}

export function submitBrandKit(c: Core, wsId: string, actor: string) {
  const row = c.db.prepare("SELECT * FROM brand_kits WHERE workspace_id = ?").get(wsId) as KitRow | undefined;
  if (!row) throw conflict("no_brand_kit", "Save the Brand Kit before submitting it for review");
  if (row.status === "needs_review") throw conflict("already_submitted", "This version is already waiting for review");
  if (row.status === "approved") throw conflict("already_approved", "This version is already approved. Edit it to make a new version.");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("UPDATE brand_kits SET status = 'needs_review', submitted_by = ?, submitted_at = ?, decided_by = NULL, decided_at = NULL, decision_reason = NULL, updated_at = ? WHERE workspace_id = ?").run(actor, at, at, wsId);
    audit(c, wsId, actor, "brandkit.submitted", "brand_kit", wsId, { version: row.current_version });
  })();
  return brandKitView(c, wsId);
}

/** Approve or reject EXACTLY the version named in the request. If the kit changed since the reviewer looked, the decision is refused as stale. */
export function decideBrandKit(c: Core, wsId: string, decision: "approve" | "reject", input: unknown, by: { decidedBy: string; approver?: { kind: string } }) {
  const body = BrandKitDecisionSchema.parse(input);
  const row = c.db.prepare("SELECT * FROM brand_kits WHERE workspace_id = ?").get(wsId) as KitRow | undefined;
  if (!row) throw conflict("no_brand_kit", "There is no Brand Kit to review");
  if (row.status !== "needs_review") throw conflict("not_submitted", "This version has not been submitted for review");
  if (body.version !== row.current_version) throw conflict("stale", "The Brand Kit changed after you opened it; review the latest version");
  if (decision === "reject" && !body.reason) throw new AppError(400, "reason_required", "Say why it is being rejected so it can be corrected");
  let separation: SeparationOutcome | null = null;
  if (decision === "approve") separation = separationOutcome(c, wsId, row.submitted_by, by, "Brand Kit version");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("UPDATE brand_kits SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, approved_version = ?, separation = ?, updated_at = ? WHERE workspace_id = ?")
      .run(decision === "approve" ? "approved" : "rejected", by.decidedBy, at, body.reason ?? null, decision === "approve" ? row.current_version : row.approved_version, separation, at, wsId);
    audit(c, wsId, by.decidedBy, decision === "approve" ? "brandkit.approved" : "brandkit.rejected", "brand_kit", wsId, { version: row.current_version, reason: body.reason ?? null, ...(separation ? { separation, separationEnforced: separation === "enforced" } : {}) });
  })();
  return brandKitView(c, wsId);
}

/** Every version with the sections that changed from the one before (plain labels, never the content of other versions). */
export function brandKitVersions(c: Core, wsId: string) {
  const rows = c.db.prepare("SELECT version, data, created_at, created_by FROM brand_kit_versions WHERE workspace_id = ? ORDER BY version").all(wsId) as Array<{ version: number; data: string; created_at: string; created_by: string }>;
  const kit = c.db.prepare("SELECT approved_version FROM brand_kits WHERE workspace_id = ?").get(wsId) as { approved_version: number | null } | undefined;
  let prev: BrandKit = EMPTY_BRAND_KIT;
  return rows.map((r) => {
    const cur = BrandKitSchema.parse(JSON.parse(r.data));
    const changed = changedSections(prev, cur).map((s) => SECTION_LABEL[s]);
    prev = cur;
    return { version: r.version, createdAt: r.created_at, byKind: kindOf(r.created_by), changed, approved: kit?.approved_version === r.version };
  });
}

