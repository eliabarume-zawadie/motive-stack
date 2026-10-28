import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { newId } from "./util.js";
import { separationOutcome, type SeparationOutcome } from "./workspacePolicy.js";
import { assetKey, type AssetStore } from "../storage/assetStore.js";
import { readImageInfo } from "../storage/imageInfo.js";

/**
 * The workspace asset library: logos, images and posters with immutable versions, provenance, rights and review status. The database holds metadata only;
 * the bytes go to the AssetStore. In this phase assets arrive by upload or import (there is no live generation), and nothing here claims production storage.
 *
 * Safety rules enforced here:
 *  - every query is scoped to the verified workspace; a file is read only after its row is found in that workspace;
 *  - the file's type, size and dimensions come from its own bytes, never from the declared type or the name; the name is never used in a path;
 *  - per-file and per-workspace size limits, and a per-workspace asset count limit;
 *  - a version is never modified: replacing an asset adds a version, so a previously approved version stays reproducible;
 *  - approval needs stated rights (and an unexpired licence), and, when separation of duties is on, someone other than the submitter.
 */

export interface AssetLimits { maxFileBytes: number; maxWorkspaceBytes: number; maxAssets: number }
export const DEFAULT_ASSET_LIMITS: AssetLimits = { maxFileBytes: 5 * 1024 * 1024, maxWorkspaceBytes: 200 * 1024 * 1024, maxAssets: 500 };
/** The JSON upload carries the file as base64, so the request body must be a little larger than the largest file. */
export const assetBodyLimit = (l: AssetLimits): number => Math.ceil((l.maxFileBytes * 4) / 3) + 16 * 1024;

export const ASSET_KINDS = ["logo", "image", "poster", "template", "reference"] as const;
export const RIGHTS_BASES = ["owned", "licensed", "stock", "client_supplied", "unknown"] as const;
const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
const text = (max: number) => z.string().trim().max(max).refine(noControl, "No control characters");

const RightsFields = {
  source: z.enum(["uploaded", "imported"]),
  rightsBasis: z.enum(RIGHTS_BASES),
  licenseNote: text(300).optional(),
  usageRestrictions: text(300).optional(),
  /** For an imported file: where it came from (a person, a site, a supplier). Required so the origin is never lost. */
  sourceNote: text(300).optional(),
  rightsExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  data: z.string().min(8),
};
const needSource = (b: { source: string; sourceNote?: string | undefined }) => b.source !== "imported" || !!b.sourceNote;
const needSourceMsg = { message: "An imported file needs a note saying where it came from", path: ["sourceNote"] };

export const AssetUploadSchema = z.object({ name: text(120).pipe(z.string().min(1)), kind: z.enum(ASSET_KINDS), ...RightsFields }).strict().refine(needSource, needSourceMsg);
export const AssetVersionSchema = z.object({ ...RightsFields }).strict().refine(needSource, needSourceMsg);
export const AssetDecisionSchema = z.object({ reason: text(300).optional() }).strict();

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
function decode(data: string, limits: AssetLimits): Buffer {
  if (!B64.test(data)) throw new AppError(400, "invalid_file", "The file could not be read");
  if (data.length > Math.ceil((limits.maxFileBytes * 4) / 3) + 4) throw new AppError(400, "file_too_large", `Files can be at most ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB`); // checked BEFORE decoding, so a huge body is never expanded
  const b = Buffer.from(data, "base64");
  if (b.length === 0 || b.length > limits.maxFileBytes) throw new AppError(400, "file_too_large", `Files can be at most ${Math.max(1, Math.floor(limits.maxFileBytes / 1024 / 1024))} MB`);
  return b;
}

const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

interface VerRow {
  asset_id: string; version: number; status: string; mime: string; size_bytes: number; sha256: string; width: number; height: number; source: string; provider: string | null; model: string | null;
  rights_basis: string; license_note: string | null; usage_restrictions: string | null; source_note: string | null; rights_expires_at: string | null; parent_version: number | null;
  created_at: string; created_by: string; submitted_by: string | null; submitted_at: string | null; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; separation: string | null;
}
const versionView = (v: VerRow) => ({
  version: v.version, status: v.status, mime: v.mime, sizeBytes: v.size_bytes, sha256: v.sha256, width: v.width, height: v.height, source: v.source, provider: v.provider, model: v.model,
  rights: { basis: v.rights_basis, licenseNote: v.license_note, usageRestrictions: v.usage_restrictions, sourceNote: v.source_note, expiresAt: v.rights_expires_at },
  parentVersion: v.parent_version, createdAt: v.created_at, createdByKind: kindOf(v.created_by),
  submittedAt: v.submitted_at, submittedByKind: kindOf(v.submitted_by),
  review: v.reviewed_at ? { at: v.reviewed_at, byKind: kindOf(v.reviewed_by), note: v.review_note, separation: v.separation } : null,
});

interface AssetRow { id: string; workspace_id: string; kind: string; name: string; current_version: number; created_at: string; created_by: string; archived_at: string | null }
function getAsset(c: Core, wsId: string, assetId: string): AssetRow {
  const a = c.db.prepare("SELECT * FROM assets WHERE id = ? AND workspace_id = ?").get(assetId, wsId) as AssetRow | undefined;
  if (!a) throw notFound("Asset");
  return a;
}
function getVersion(c: Core, wsId: string, assetId: string, version: number): VerRow {
  const v = c.db.prepare("SELECT * FROM asset_versions WHERE asset_id = ? AND version = ? AND workspace_id = ?").get(assetId, version, wsId) as VerRow | undefined;
  if (!v) throw notFound("Asset version");
  return v;
}

/** Other versions in this workspace with the same bytes (any asset). Reported, never blocked: the same logo may legitimately be used twice. */
function duplicatesOf(c: Core, wsId: string, sha: string, exceptAsset?: string): string[] {
  return (c.db.prepare("SELECT DISTINCT asset_id FROM asset_versions WHERE workspace_id = ? AND sha256 = ?").all(wsId, sha) as Array<{ asset_id: string }>).map((r) => r.asset_id).filter((id) => id !== exceptAsset);
}

export function assetDetail(c: Core, wsId: string, assetId: string) {
  const a = getAsset(c, wsId, assetId);
  const versions = (c.db.prepare("SELECT * FROM asset_versions WHERE asset_id = ? AND workspace_id = ? ORDER BY version").all(assetId, wsId) as VerRow[]).map(versionView);
  const approved = [...versions].reverse().find((v) => v.status === "approved") ?? null;
  const latest = versions[versions.length - 1]!;
  return {
    id: a.id, kind: a.kind, name: a.name, createdAt: a.created_at, createdByKind: kindOf(a.created_by), archived: a.archived_at !== null,
    currentVersion: a.current_version,
    /** The version later work may rely on: the newest APPROVED one. A newer draft never replaces it until it is approved. */
    approvedVersion: approved?.version ?? null,
    status: latest.status,
    duplicateOf: duplicatesOf(c, wsId, latest.sha256, assetId),
    versions,
  };
}

export function listAssets(c: Core, wsId: string, includeArchived = false) {
  const rows = c.db.prepare(`SELECT id FROM assets WHERE workspace_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY created_at DESC, id`).all(wsId) as Array<{ id: string }>;
  const bytes = (c.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) n FROM asset_versions WHERE workspace_id = ?").get(wsId) as { n: number }).n;
  return { assets: rows.map((r) => assetDetail(c, wsId, r.id)), usage: { bytes, assets: (c.db.prepare("SELECT COUNT(*) n FROM assets WHERE workspace_id = ? AND archived_at IS NULL").get(wsId) as { n: number }).n } };
}

export interface Deps { c: Core; store: AssetStore; limits: AssetLimits }

function checkQuota(d: Deps, wsId: string, addBytes: number, newAsset: boolean): void {
  const used = (d.c.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) n FROM asset_versions WHERE workspace_id = ?").get(wsId) as { n: number }).n;
  if (used + addBytes > d.limits.maxWorkspaceBytes) throw new AppError(413, "workspace_storage_full", "This workspace has used its asset storage. Archive nothing: files are kept. Ask an owner to raise the limit.");
  if (newAsset && (d.c.db.prepare("SELECT COUNT(*) n FROM assets WHERE workspace_id = ? AND archived_at IS NULL").get(wsId) as { n: number }).n >= d.limits.maxAssets) throw new AppError(413, "too_many_assets", "This workspace has reached its limit on assets");
}

/** Turns an upload into verified bytes plus what the bytes really are. */
function inspect(input: { data: string }, limits: AssetLimits) {
  const bytes = decode(input.data, limits);
  const info = readImageInfo(bytes);
  if (!info) throw new AppError(415, "unsupported_file", "Only PNG, JPEG and WebP images are accepted (checked from the file itself, not its name)");
  return { bytes, info, sha: createHash("sha256").update(bytes).digest("hex") };
}

type Rights = z.infer<typeof AssetVersionSchema>;
function insertVersion(d: Deps, wsId: string, assetId: string, version: number, key: string, f: ReturnType<typeof inspect>, r: Rights, actor: string, parent: number | null): void {
  d.c.db.prepare(`INSERT INTO asset_versions (asset_id, version, workspace_id, status, storage_key, mime, size_bytes, sha256, width, height, source, rights_basis, license_note, usage_restrictions, source_note, rights_expires_at, parent_version, created_at, created_by)
                  VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(assetId, version, wsId, key, f.info.mime, f.bytes.length, f.sha, f.info.width, f.info.height, r.source, r.rightsBasis, r.licenseNote ?? null, r.usageRestrictions ?? null, r.sourceNote ?? null, r.rightsExpiresAt ?? null, parent, iso(d.c), actor);
}

export async function createAsset(d: Deps, wsId: string, actor: string, input: unknown) {
  const body = AssetUploadSchema.parse(input);
  const f = inspect(body, d.limits);
  checkQuota(d, wsId, f.bytes.length, true);
  const id = newId("asset");
  const key = assetKey(wsId, id, 1, f.info.ext);
  await d.store.put(key, f.bytes);
  try {
    d.c.db.transaction(() => {
      d.c.db.prepare("INSERT INTO assets (id, workspace_id, kind, name, current_version, created_at, created_by) VALUES (?,?,?,?,1,?,?)").run(id, wsId, body.kind, body.name, iso(d.c), actor);
      insertVersion(d, wsId, id, 1, key, f, body, actor, null);
      audit(d.c, wsId, actor, "asset.uploaded", "asset", id, { kind: body.kind, name: body.name, version: 1, source: body.source, rights: body.rightsBasis, sizeBytes: f.bytes.length, mime: f.info.mime });
    })();
  } catch (e) { await d.store.remove(key); throw e; }
  return assetDetail(d.c, wsId, id);
}

/** A replacement is a NEW version. The previous versions, including an approved one, are untouched. The new version starts as a draft and needs review. */
export async function addAssetVersion(d: Deps, wsId: string, assetId: string, actor: string, input: unknown) {
  const body = AssetVersionSchema.parse(input);
  const a = getAsset(d.c, wsId, assetId);
  if (a.archived_at) throw conflict("asset_archived", "This asset is archived");
  const f = inspect(body, d.limits);
  checkQuota(d, wsId, f.bytes.length, false);
  const version = a.current_version + 1;
  const key = assetKey(wsId, assetId, version, f.info.ext);
  await d.store.put(key, f.bytes);
  try {
    d.c.db.transaction(() => {
      insertVersion(d, wsId, assetId, version, key, f, body, actor, a.current_version);
      d.c.db.prepare("UPDATE assets SET current_version = ? WHERE id = ? AND workspace_id = ?").run(version, assetId, wsId);
      audit(d.c, wsId, actor, "asset.version_added", "asset", assetId, { version, parentVersion: a.current_version, source: body.source, rights: body.rightsBasis, sizeBytes: f.bytes.length });
    })();
  } catch (e) { await d.store.remove(key); throw e; }
  return assetDetail(d.c, wsId, assetId);
}

export function submitAssetVersion(c: Core, wsId: string, assetId: string, version: number, actor: string) {
  const a = getAsset(c, wsId, assetId);
  if (a.archived_at) throw conflict("asset_archived", "This asset is archived");
  const v = getVersion(c, wsId, assetId, version);
  if (v.status !== "draft" && v.status !== "rejected") throw conflict("not_submittable", `This version is ${v.status}, so it cannot be submitted`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE asset_versions SET status = 'needs_review', submitted_by = ?, submitted_at = ?, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE asset_id = ? AND version = ? AND workspace_id = ?").run(actor, iso(c), assetId, version, wsId);
    audit(c, wsId, actor, "asset.submitted", "asset", assetId, { version });
  })();
  return assetDetail(c, wsId, assetId);
}

/** Approve or reject exactly one version. Approval needs stated rights, an unexpired licence and (when on) a second person; it supersedes the previously approved version. */
export function decideAssetVersion(c: Core, wsId: string, assetId: string, version: number, decision: "approve" | "reject", input: unknown, by: { decidedBy: string; approver?: { kind: string } }) {
  const body = AssetDecisionSchema.parse(input ?? {});
  const a = getAsset(c, wsId, assetId);
  if (a.archived_at) throw conflict("asset_archived", "This asset is archived");
  const v = getVersion(c, wsId, assetId, version);
  if (v.status !== "needs_review") throw conflict("not_submitted", `This version is ${v.status}, so it cannot be reviewed`);
  if (decision === "reject" && !body.reason) throw new AppError(400, "reason_required", "Say why it is being rejected so it can be corrected");
  let separation: SeparationOutcome | null = null;
  if (decision === "approve") {
    if (v.rights_basis === "unknown") throw conflict("rights_unknown", "State where this file came from and the right to use it before approving it");
    if (v.rights_expires_at && v.rights_expires_at < iso(c).slice(0, 10)) throw conflict("rights_expired", "The licence for this file has expired");
    const newer = c.db.prepare("SELECT 1 FROM asset_versions WHERE asset_id = ? AND workspace_id = ? AND version > ? AND status = 'approved'").get(assetId, wsId, version);
    if (newer) throw conflict("newer_version_approved", "A newer version of this asset is already approved");
    separation = separationOutcome(c, wsId, v.submitted_by, by, "asset version");
  }
  const at = iso(c);
  c.db.transaction(() => {
    if (decision === "approve") c.db.prepare("UPDATE asset_versions SET status = 'superseded' WHERE asset_id = ? AND workspace_id = ? AND status = 'approved' AND version < ?").run(assetId, wsId, version);
    c.db.prepare("UPDATE asset_versions SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, separation = ? WHERE asset_id = ? AND version = ? AND workspace_id = ?")
      .run(decision === "approve" ? "approved" : "rejected", by.decidedBy, at, body.reason ?? null, separation, assetId, version, wsId);
    audit(c, wsId, by.decidedBy, decision === "approve" ? "asset.approved" : "asset.rejected", "asset", assetId, { version, reason: body.reason ?? null, ...(separation ? { separation, separationEnforced: separation === "enforced" } : {}) });
  })();
  return assetDetail(c, wsId, assetId);
}

export function archiveAsset(c: Core, wsId: string, assetId: string, actor: string) {
  const a = getAsset(c, wsId, assetId);
  if (a.archived_at) return assetDetail(c, wsId, assetId);
  c.db.transaction(() => {
    c.db.prepare("UPDATE assets SET archived_at = ?, archived_by = ? WHERE id = ? AND workspace_id = ?").run(iso(c), actor, assetId, wsId);
    audit(c, wsId, actor, "asset.archived", "asset", assetId, { name: a.name });
  })();
  return assetDetail(c, wsId, assetId);
}

/** The bytes of one version. The row must be in THIS workspace, and the stored bytes must still match their recorded hash. */
export async function readAssetFile(d: Deps, wsId: string, assetId: string, version: number) {
  getAsset(d.c, wsId, assetId);
  const v = d.c.db.prepare("SELECT storage_key, mime, sha256 FROM asset_versions WHERE asset_id = ? AND version = ? AND workspace_id = ?").get(assetId, version, wsId) as { storage_key: string; mime: string; sha256: string } | undefined;
  if (!v) throw notFound("Asset version");
  const bytes = await d.store.get(v.storage_key);
  if (!bytes) throw new AppError(410, "asset_file_missing", "The file for this version is not available");
  if (createHash("sha256").update(bytes).digest("hex") !== v.sha256) throw new AppError(500, "asset_integrity", "The stored file does not match its record");
  return { bytes, mime: v.mime, ext: v.mime === "image/png" ? "png" : v.mime === "image/jpeg" ? "jpg" : "webp" };
}

/**
 * Stores bytes that THIS application produced and validated (a generated creative image). Not reachable from any route: the Creative Studio calls it after its
 * own checks, so the upload schema (which describes a person's upload) does not apply. The version starts as a draft, with rights "generated", and the provider
 * and model recorded. A first call creates the asset; a later call with `assetId` adds a version, never changing an earlier one.
 */
export async function storeGeneratedAsset(d: Deps, wsId: string, actor: string, input: { assetId?: string; name: string; bytes: Buffer; provider: string; model: string; note: string }): Promise<{ assetId: string; version: number; sha256: string }> {
  const info = readImageInfo(input.bytes);
  if (!info) throw new AppError(415, "unsupported_file", "The generated file is not a supported image");
  if (input.bytes.length > d.limits.maxFileBytes) throw new AppError(400, "file_too_large", "The generated image is larger than the file limit");
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const existing = input.assetId ? getAsset(d.c, wsId, input.assetId) : null;
  if (existing?.archived_at) throw conflict("asset_archived", "This asset is archived");
  checkQuota(d, wsId, input.bytes.length, !existing);
  const assetId = existing?.id ?? newId("asset");
  const version = existing ? existing.current_version + 1 : 1;
  const key = assetKey(wsId, assetId, version, info.ext);
  await d.store.put(key, input.bytes);
  try {
    d.c.db.transaction(() => {
      if (!existing) d.c.db.prepare("INSERT INTO assets (id, workspace_id, kind, name, current_version, created_at, created_by) VALUES (?,?,'image',?,1,?,?)").run(assetId, wsId, input.name, iso(d.c), actor);
      else d.c.db.prepare("UPDATE assets SET current_version = ? WHERE id = ? AND workspace_id = ?").run(version, assetId, wsId);
      d.c.db.prepare(`INSERT INTO asset_versions (asset_id, version, workspace_id, status, storage_key, mime, size_bytes, sha256, width, height, source, provider, model, rights_basis, source_note, parent_version, created_at, created_by)
                      VALUES (?,?,?,'draft',?,?,?,?,?,?,'generated',?,?,'generated',?,?,?,?)`)
        .run(assetId, version, wsId, key, info.mime, input.bytes.length, sha, info.width, info.height, input.provider, input.model, input.note, existing ? existing.current_version : null, iso(d.c), actor);
      audit(d.c, wsId, actor, existing ? "asset.version_added" : "asset.generated", "asset", assetId, { version, source: "generated", provider: input.provider, model: input.model, sizeBytes: input.bytes.length });
    })();
  } catch (e) { await d.store.remove(key); throw e; }
  return { assetId, version, sha256: sha };
}

/**
 * Approves a GENERATED version as part of approving the creative that uses it, inside the caller's transaction. The creative's reviewer is the reviewer of the
 * file; the creative approval already applied separation of duties, so it is recorded on the asset rather than checked a second time.
 */
export function approveGeneratedVersionInTx(c: Core, wsId: string, assetId: string, version: number, by: string, note: string, separation: SeparationOutcome | null): void {
  const v = getVersion(c, wsId, assetId, version);
  if (v.source !== "generated") throw new AppError(500, "not_generated", "Only a generated version is approved with its creative");
  if (v.status === "approved") return;
  if (v.status !== "draft" && v.status !== "needs_review") throw conflict("not_approvable", `This image is ${v.status}`);
  c.db.prepare("UPDATE asset_versions SET status = 'superseded' WHERE asset_id = ? AND workspace_id = ? AND status = 'approved' AND version < ?").run(assetId, wsId, version);
  c.db.prepare("UPDATE asset_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, separation = ? WHERE asset_id = ? AND version = ? AND workspace_id = ?")
    .run(by, iso(c), note, separation, assetId, version, wsId);
  audit(c, wsId, by, "asset.approved", "asset", assetId, { version, via: "creative", ...(separation ? { separation, separationEnforced: separation === "enforced" } : {}) });
}

/** What the Creative Studio needs to know about one asset version, or null when it is not in this workspace. */
export function assetVersionFacts(c: Core, wsId: string, assetId: string, version: number) {
  const a = c.db.prepare("SELECT archived_at FROM assets WHERE id = ? AND workspace_id = ?").get(assetId, wsId) as { archived_at: string | null } | undefined;
  const v = c.db.prepare("SELECT status, mime, size_bytes, width, height, source, provider, model, rights_basis, rights_expires_at, sha256 FROM asset_versions WHERE asset_id = ? AND version = ? AND workspace_id = ?").get(assetId, version, wsId) as
    { status: string; mime: string; size_bytes: number; width: number; height: number; source: string; provider: string | null; model: string | null; rights_basis: string; rights_expires_at: string | null; sha256: string } | undefined;
  return a && v ? { archived: a.archived_at !== null, ...v } : null;
}
