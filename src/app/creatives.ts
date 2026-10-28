import { z } from "zod";
import { runCreativeQa, type Concept, type QaResult, type QaVariant } from "../creative/qa.js";
import { checkPng } from "../creative/png.js";
import { ProviderError, RATIO_SIZE } from "../creative/image.js";
import { isRatioId, matchesRatio, RATIOS, RATIO_IDS, type RatioId } from "../creative/ratios.js";
import { readImageInfo } from "../storage/imageInfo.js";
import { approveGeneratedVersionInTx, assetVersionFacts, readAssetFile, storeGeneratedAsset, type Deps as AssetDeps } from "./assets.js";
import { brandKitView } from "./brandKit.js";
import { getCampaignRecord, getCampaignRow } from "./campaigns.js";
import type { AppContext } from "./context.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { enqueueJob, RetryableError, type Job } from "./jobs.js";
import { closeWorkItemsFor, notify, ownershipOf, reviewerFor } from "./teamOps.js";
import { newId, safeError } from "./util.js";
import { separationOutcome, type SeparationOutcome } from "./workspacePolicy.js";
import { getBrain } from "./workspaces.js";

/**
 * Creative Studio, images first. A creative belongs to a campaign. Each save is an immutable VERSION (structured brief, concept, editable copy, alt text, the
 * formats it needs). Pictures are made by persisted render jobs and stored as ordinary assets, so storage, rights, provenance and quotas are shared with the
 * asset library. Rules this file enforces:
 *   - a render is "succeeded" only after its bytes were checked (structure, type, size, ratio), stored, and recorded; nothing is marked complete before that;
 *   - a version in review or approved is never changed: editing makes a new version, so an approval always covers exactly what the reviewer saw;
 *   - approval re-runs the automatic checks against the CURRENT Business Brain and Brand Kit, needs every format to have a stored image, and (when on)
 *     a second person; approving a creative approves its own generated pictures, while an imported picture must already be approved on its own;
 *   - everything here is mock: the only image provider is the offline placeholder, no vendor is contacted, and no render costs anything.
 */
export interface CreativeLimits { maxRendersPerDay: number }
export const DEFAULT_CREATIVE_LIMITS: CreativeLimits = { maxRendersPerDay: 40 };
export const MAX_MANUAL_RENDER_RETRIES = 2;
const RENDER_ACTOR = "system:creative-render";

const line = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const note = (max: number) => z.string().trim().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour such as #1A4D8F");

export const CreativeBriefSchema = z.object({ objective: line(200), keyMessage: line(200), audienceNote: note(200).default(""), visualDirection: note(400).default("") }).strict();
export const ConceptSchema = z.object({
  headline: line(40), subline: note(125).default(""), callToAction: z.enum(["SIGN_UP", "LEARN_MORE", "GET_QUOTE"]),
  visualDescription: line(400), palette: z.object({ background: HEX, foreground: HEX, accent: HEX }).strict(),
}).strict();
const RatiosSchema = z.array(z.enum(RATIO_IDS)).min(1).max(RATIO_IDS.length).transform((r) => [...new Set(r)]);
const VersionBody = { brief: CreativeBriefSchema, concept: ConceptSchema, altText: note(300), ratios: RatiosSchema };
export const CreativeCreateSchema = z.object({ name: line(80), ...VersionBody }).strict();
export const CreativeReviseSchema = z.object({ ...VersionBody }).strict();
export const RenderRequestSchema = z.object({ ratios: RatiosSchema.optional() }).strict();
export const ImportVariantSchema = z.object({ ratio: z.enum(RATIO_IDS), assetId: z.string().regex(/^[a-z0-9_]{1,64}$/), assetVersion: z.number().int().min(1).max(99999) }).strict();
export const CreativeDecisionSchema = z.object({ reason: note(300).optional() }).strict();

const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

interface CreativeRow { id: string; workspace_id: string; campaign_id: string; kind: string; name: string; current_version: number; created_at: string; created_by: string; archived_at: string | null }
interface VersionRow {
  creative_id: string; version: number; workspace_id: string; status: string; campaign_version: number; brief: string; concept: string; alt_text: string; ratios: string; qa: string | null; parent_version: number | null;
  created_at: string; created_by: string; submitted_by: string | null; submitted_at: string | null; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; separation: string | null;
}
interface RenderRow {
  id: string; workspace_id: string; creative_id: string; creative_version: number; ratio: string; status: string; stage: string; provider: string; model: string; attempts: number; manual_retries: number;
  cancel_requested: number; error_code: string | null; error_message: string | null; asset_id: string | null; asset_version: number | null; sha256: string | null; simulated_cost_cents: number;
  created_at: string; created_by: string; started_at: string | null; finished_at: string | null;
}
interface VariantRow { creative_id: string; creative_version: number; ratio: string; source: "generated" | "imported"; asset_id: string; asset_version: number; render_id: string | null; created_at: string }

function getCreative(c: Core, wsId: string, id: string): CreativeRow {
  const r = c.db.prepare("SELECT * FROM creatives WHERE id = ? AND workspace_id = ?").get(id, wsId) as CreativeRow | undefined;
  if (!r) throw notFound("Creative");
  return r;
}
function getVersion(c: Core, wsId: string, id: string, version: number): VersionRow {
  const r = c.db.prepare("SELECT * FROM creative_versions WHERE creative_id = ? AND version = ? AND workspace_id = ?").get(id, version, wsId) as VersionRow | undefined;
  if (!r) throw notFound("Creative version");
  return r;
}
const getRender = (c: Core, wsId: string, id: string): RenderRow => {
  const r = c.db.prepare("SELECT * FROM creative_renders WHERE id = ? AND workspace_id = ?").get(id, wsId) as RenderRow | undefined;
  if (!r) throw notFound("Render");
  return r;
};
const ratiosOf = (v: VersionRow): RatioId[] => (JSON.parse(v.ratios) as unknown[]).filter(isRatioId);
const conceptOf = (v: VersionRow): Concept => JSON.parse(v.concept) as Concept;
const editable = (v: VersionRow) => v.status === "draft" || v.status === "rejected";

/* ------------------------------------------------------------------------------------------------ views */

const renderView = (r: RenderRow) => ({
  id: r.id, ratio: r.ratio, status: r.status, stage: r.stage, provider: r.provider, model: r.model, attempts: r.attempts, manualRetries: r.manual_retries,
  canRetry: r.status === "failed" && r.manual_retries < MAX_MANUAL_RENDER_RETRIES, cancelRequested: r.cancel_requested === 1,
  error: r.error_code ? { code: r.error_code, message: r.error_message, repair: REPAIR[r.error_code] ?? "Try again, or attach an approved image instead." } : null,
  assetId: r.asset_id, assetVersion: r.asset_version, sha256: r.sha256, simulatedCostCents: r.simulated_cost_cents, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  createdByKind: kindOf(r.created_by),
});
const REPAIR: Record<string, string> = {
  output_invalid: "The picture that came back was damaged, so it was thrown away. Try again.",
  wrong_ratio: "The picture came back in the wrong shape and was thrown away. Try again, or attach an approved image of the right shape.",
  provider_refused: "The image provider declined this request. Reword the visual description, or attach an approved image instead.",
  provider_unavailable: "The image provider did not answer after several tries. Try again later.",
  storage_failed: "The picture could not be saved. Check the asset storage limit, then try again.",
  render_failed: "The render failed. Try again, or attach an approved image instead.",
};

function variantsOf(c: Core, wsId: string, creativeId: string, version: number) {
  const rows = c.db.prepare("SELECT * FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND workspace_id = ?").all(creativeId, version, wsId) as VariantRow[];
  return rows.map((r) => {
    const f = assetVersionFacts(c, wsId, r.asset_id, r.asset_version);
    return { ratio: r.ratio, source: r.source, assetId: r.asset_id, assetVersion: r.asset_version, renderId: r.render_id, width: f?.width ?? null, height: f?.height ?? null, mime: f?.mime ?? null, sizeBytes: f?.size_bytes ?? null, sha256: f?.sha256 ?? null,
      assetStatus: f?.status ?? null, provider: f?.provider ?? null, model: f?.model ?? null, rights: f?.rights_basis ?? null };
  });
}

function versionView(c: Core, wsId: string, v: VersionRow) {
  const camp = c.db.prepare("SELECT current_version FROM campaigns WHERE id = (SELECT campaign_id FROM creatives WHERE id = ?)").get(v.creative_id) as { current_version: number } | undefined;
  const renders = (c.db.prepare("SELECT * FROM creative_renders WHERE creative_id = ? AND creative_version = ? AND workspace_id = ? ORDER BY created_at, id").all(v.creative_id, v.version, wsId) as RenderRow[]).map(renderView);
  return {
    version: v.version, status: v.status, campaignVersion: v.campaign_version, campaignMovedOn: camp ? camp.current_version !== v.campaign_version : false,
    brief: JSON.parse(v.brief) as unknown, concept: conceptOf(v), altText: v.alt_text, ratios: ratiosOf(v), parentVersion: v.parent_version,
    qa: v.qa ? (JSON.parse(v.qa) as QaResult) : null, variants: variantsOf(c, wsId, v.creative_id, v.version), renders,
    createdAt: v.created_at, createdByKind: kindOf(v.created_by), submittedAt: v.submitted_at, submittedByKind: kindOf(v.submitted_by),
    review: v.reviewed_at ? { at: v.reviewed_at, byKind: kindOf(v.reviewed_by), note: v.review_note, separation: v.separation } : null,
  };
}

export function creativeDetail(c: Core, wsId: string, creativeId: string) {
  const cr = getCreative(c, wsId, creativeId);
  const versions = (c.db.prepare("SELECT * FROM creative_versions WHERE creative_id = ? AND workspace_id = ? ORDER BY version").all(creativeId, wsId) as VersionRow[]).map((v) => versionView(c, wsId, v));
  const approved = [...versions].reverse().find((v) => v.status === "approved") ?? null;
  return { id: cr.id, campaignId: cr.campaign_id, kind: cr.kind, name: cr.name, currentVersion: cr.current_version, approvedVersion: approved?.version ?? null, status: versions[versions.length - 1]!.status, archived: cr.archived_at !== null, createdAt: cr.created_at, createdByKind: kindOf(cr.created_by), versions };
}

export function listCampaignCreatives(c: Core, wsId: string, campaignId: string) {
  getCampaignRow(c, wsId, campaignId);
  const rows = c.db.prepare("SELECT id FROM creatives WHERE workspace_id = ? AND campaign_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id").all(wsId, campaignId) as Array<{ id: string }>;
  return { creatives: rows.map((r) => creativeDetail(c, wsId, r.id)) };
}

/* ------------------------------------------------------------------------------------------------ concepts (rule-based suggestions, not AI) */

export function suggestConcepts(c: Core, wsId: string, campaignId: string) {
  const rec = getCampaignRecord(c, wsId, campaignId);
  const kit = brandKitView(c, wsId);
  const colours = kit.approved?.visual.colors ?? [];
  const pick = (roles: string[], fallback: string) => colours.find((x) => roles.includes(x.role))?.hex ?? fallback;
  const palette = { background: pick(["background", "neutral"], "#FFFFFF"), foreground: pick(["text"], "#1B1B1B"), accent: pick(["accent", "primary"], "#1A4D8F") };
  const style = kit.approved?.visual.imageStyle?.trim();
  const first = (t: string) => (t.split(/(?<=[.!?])\s/)[0] ?? t).slice(0, 125);
  const heads = rec.brief.headlines.slice(0, 3);
  const seeds = heads.length ? heads : [rec.name.slice(0, 40)];
  return {
    source: "rule_based" as const,
    note: "Suggestions built from your campaign's own headlines and primary text, and your approved Brand Kit colours. They are not generated by AI. Edit anything before saving.",
    concepts: seeds.map((h, i) => ({
      title: `Idea ${i + 1}`,
      brief: { objective: rec.brief.objective.slice(0, 200), keyMessage: h.slice(0, 200), audienceNote: "", visualDirection: style ? style.slice(0, 400) : "" },
      concept: { headline: h.slice(0, 40), subline: first(rec.brief.primaryTexts[i % Math.max(1, rec.brief.primaryTexts.length)] ?? ""), callToAction: rec.brief.callToAction as "SIGN_UP" | "LEARN_MORE" | "GET_QUOTE",
        visualDescription: (style && style.length >= 3 ? style : `A clean, simple layout that supports the message: ${h}`).slice(0, 400), palette },
      altText: `Advertisement for ${rec.name}: ${h}`.slice(0, 300),
      ratios: ["1:1", "4:5"] as RatioId[],
    })),
    brandKitApproved: kit.approved !== null,
  };
}

/* ------------------------------------------------------------------------------------------------ create / revise */

const visualKey = (k: Concept) => JSON.stringify([k.visualDescription, k.palette.background, k.palette.foreground, k.palette.accent]);

export function createCreative(c: Core, wsId: string, actor: string, campaignId: string, input: unknown) {
  const body = CreativeCreateSchema.parse(input);
  const camp = getCampaignRow(c, wsId, campaignId);
  const id = newId("crt");
  const at = iso(c);
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO creatives (id, workspace_id, campaign_id, kind, name, current_version, created_at, created_by) VALUES (?,?,?,'static_image',?,1,?,?)").run(id, wsId, campaignId, body.name, at, actor);
    c.db.prepare(`INSERT INTO creative_versions (creative_id, version, workspace_id, status, campaign_version, brief, concept, alt_text, ratios, parent_version, created_at, created_by) VALUES (?,1,?,'draft',?,?,?,?,?,NULL,?,?)`)
      .run(id, wsId, camp.current_version, JSON.stringify(body.brief), JSON.stringify(body.concept), body.altText, JSON.stringify(body.ratios), at, actor);
    audit(c, wsId, actor, "creative.created", "creative", id, { campaignId, name: body.name, ratios: body.ratios });
  })();
  return creativeDetail(c, wsId, id);
}

/** Editing never changes a saved version: it adds a new draft. Pictures whose visual inputs did not change are carried over, so fixing a word does not remake them. */
export function reviseCreative(c: Core, wsId: string, actor: string, creativeId: string, input: unknown) {
  const body = CreativeReviseSchema.parse(input);
  const cr = getCreative(c, wsId, creativeId);
  if (cr.archived_at) throw conflict("creative_archived", "This creative is archived");
  const cur = getVersion(c, wsId, creativeId, cr.current_version);
  const camp = getCampaignRow(c, wsId, cr.campaign_id);
  const version = cr.current_version + 1;
  const at = iso(c);
  const same = visualKey(conceptOf(cur)) === visualKey(body.concept as Concept);
  c.db.transaction(() => {
    if (cur.status === "draft" || cur.status === "needs_review") c.db.prepare("UPDATE creative_versions SET status = 'superseded' WHERE creative_id = ? AND version = ? AND workspace_id = ?").run(creativeId, cur.version, wsId);
    c.db.prepare(`INSERT INTO creative_versions (creative_id, version, workspace_id, status, campaign_version, brief, concept, alt_text, ratios, parent_version, created_at, created_by) VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?)`)
      .run(creativeId, version, wsId, camp.current_version, JSON.stringify(body.brief), JSON.stringify(body.concept), body.altText, JSON.stringify(body.ratios), cur.version, at, actor);
    if (same) c.db.prepare(`INSERT INTO creative_variants (creative_id, creative_version, ratio, workspace_id, source, asset_id, asset_version, render_id, created_at)
                            SELECT creative_id, ?, ratio, workspace_id, source, asset_id, asset_version, render_id, ? FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND workspace_id = ? AND ratio IN (${body.ratios.map(() => "?").join(",")})`)
      .run(version, at, creativeId, cur.version, wsId, ...body.ratios);
    c.db.prepare("UPDATE creatives SET current_version = ? WHERE id = ? AND workspace_id = ?").run(version, creativeId, wsId);
    audit(c, wsId, actor, "creative.revised", "creative", creativeId, { version, parentVersion: cur.version, picturesKept: same });
  })();
  return creativeDetail(c, wsId, creativeId);
}

export function archiveCreative(c: Core, wsId: string, actor: string, creativeId: string) {
  const cr = getCreative(c, wsId, creativeId);
  if (!cr.archived_at) c.db.transaction(() => {
    c.db.prepare("UPDATE creatives SET archived_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), creativeId, wsId);
    audit(c, wsId, actor, "creative.archived", "creative", creativeId, { name: cr.name });
  })();
  return creativeDetail(c, wsId, creativeId);
}

/* ------------------------------------------------------------------------------------------------ renders (persisted jobs) */

function rendersToday(c: Core, wsId: string): number {
  const dayStart = `${iso(c).slice(0, 10)}T00:00:00.000Z`;
  return (c.db.prepare("SELECT COUNT(*) n FROM creative_renders WHERE workspace_id = ? AND created_at >= ?").get(wsId, dayStart) as { n: number }).n;
}

export function requestRenders(c: AppContext, wsId: string, actor: string, creativeId: string, version: number, input: unknown) {
  const body = RenderRequestSchema.parse(input ?? {});
  const cr = getCreative(c, wsId, creativeId);
  if (cr.archived_at) throw conflict("creative_archived", "This creative is archived");
  const v = getVersion(c, wsId, creativeId, version);
  if (!editable(v)) throw conflict("version_locked", `This version is ${v.status}. Edit it to make a new version, then make the pictures.`);
  const wanted = body.ratios ?? ratiosOf(v);
  const caps = c.imageProvider.capabilities;
  for (const r of wanted) {
    if (!ratiosOf(v).includes(r)) throw new AppError(400, "ratio_not_in_version", `${r} is not one of this version's formats`);
    if (!caps.ratios.includes(r)) throw conflict("ratio_unsupported", `${caps.label} cannot make ${r} pictures`);
  }
  const inFlight = new Set((c.db.prepare("SELECT ratio FROM creative_renders WHERE creative_id = ? AND creative_version = ? AND workspace_id = ? AND status IN ('queued','running')").all(creativeId, version, wsId) as Array<{ ratio: string }>).map((r) => r.ratio));
  const todo = wanted.filter((r) => !inFlight.has(r));
  const cap = c.creativeLimits.maxRendersPerDay;
  if (todo.length && rendersToday(c, wsId) + todo.length > cap) throw new AppError(429, "daily_render_limit", `This workspace can make ${cap} pictures a day. ${Math.max(0, cap - rendersToday(c, wsId))} left today.`);
  const at = iso(c);
  const ids: string[] = [];
  c.db.transaction(() => {
    for (const ratio of todo) {
      const id = newId("rnd");
      ids.push(id);
      c.db.prepare(`INSERT INTO creative_renders (id, workspace_id, creative_id, creative_version, ratio, status, stage, provider, model, created_at, created_by) VALUES (?,?,?,?,?,'queued','queued',?,?,?,?)`)
        .run(id, wsId, creativeId, version, ratio, caps.id, caps.model, at, actor);
      enqueueJob(c, wsId, "render_image", { renderId: id }, `render:${id}:0`);
    }
    if (ids.length) audit(c, wsId, actor, "creative.render_requested", "creative", creativeId, { version, ratios: todo, provider: caps.id, mock: caps.mock });
  })();
  return { ...creativeDetail(c, wsId, creativeId), requested: todo, alreadyRunning: wanted.filter((r) => inFlight.has(r)) };
}

export function cancelRender(c: Core, wsId: string, actor: string, renderId: string) {
  const r = getRender(c, wsId, renderId);
  if (r.status === "queued") c.db.transaction(() => {
    c.db.prepare("UPDATE creative_renders SET status = 'cancelled', stage = 'done', finished_at = ? WHERE id = ? AND workspace_id = ? AND status = 'queued'").run(iso(c), renderId, wsId);
    audit(c, wsId, actor, "creative.render_cancelled", "creative", r.creative_id, { renderId, ratio: r.ratio });
  })();
  else if (r.status === "running") c.db.transaction(() => {
    c.db.prepare("UPDATE creative_renders SET cancel_requested = 1 WHERE id = ? AND workspace_id = ? AND status = 'running'").run(renderId, wsId);
    audit(c, wsId, actor, "creative.render_cancel_requested", "creative", r.creative_id, { renderId, ratio: r.ratio });
  })();
  else throw conflict("render_finished", `This render is already ${r.status}`);
  return creativeDetail(c, wsId, r.creative_id);
}

export function retryRender(c: AppContext, wsId: string, actor: string, renderId: string) {
  const r = getRender(c, wsId, renderId);
  if (r.status !== "failed") throw conflict("not_failed", `Only a failed render can be retried; this one is ${r.status}`);
  if (r.manual_retries >= MAX_MANUAL_RENDER_RETRIES) throw conflict("retry_limit", `This render was already retried ${MAX_MANUAL_RENDER_RETRIES} times. Change the visual description or attach an approved image instead.`);
  const v = getVersion(c, wsId, r.creative_id, r.creative_version);
  if (!editable(v)) throw conflict("version_locked", `This version is ${v.status}`);
  const n = r.manual_retries + 1;
  c.db.transaction(() => {
    c.db.prepare("UPDATE creative_renders SET status = 'queued', stage = 'queued', manual_retries = ?, attempts = 0, cancel_requested = 0, error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = ? AND workspace_id = ? AND status = 'failed'").run(n, renderId, wsId);
    enqueueJob(c, wsId, "render_image", { renderId }, `render:${renderId}:m${n}`);
    audit(c, wsId, actor, "creative.render_retried", "creative", r.creative_id, { renderId, ratio: r.ratio, manualRetries: n });
  })();
  return creativeDetail(c, wsId, r.creative_id);
}

const RenderPayload = z.object({ renderId: z.string().regex(/^[a-z0-9_]{1,64}$/) });

/** The job handler. Idempotent: a finished render is left alone, and a render is recorded as succeeded only after its bytes were checked and stored. */
export async function processRender(c: AppContext, job: Job): Promise<void> {
  const { renderId } = RenderPayload.parse(job.payload);
  const wsId = job.workspaceId;
  const row = c.db.prepare("SELECT * FROM creative_renders WHERE id = ? AND workspace_id = ?").get(renderId, wsId) as RenderRow | undefined;
  if (!row || row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") return;
  const finish = (status: "cancelled" | "failed", code: string | null, message: string | null) => {
    c.db.prepare("UPDATE creative_renders SET status = ?, stage = 'done', error_code = ?, error_message = ?, finished_at = ?, attempts = ? WHERE id = ? AND workspace_id = ?").run(status, code, message, iso(c), job.attempts, renderId, wsId);
    audit(c, wsId, RENDER_ACTOR, status === "failed" ? "creative.render_failed" : "creative.render_cancelled", "creative", row.creative_id, { renderId, ratio: row.ratio, ...(code ? { code } : {}) });
  };
  const cancelled = () => (c.db.prepare("SELECT cancel_requested FROM creative_renders WHERE id = ? AND workspace_id = ?").get(renderId, wsId) as { cancel_requested: number }).cancel_requested === 1;
  if (cancelled()) { finish("cancelled", null, null); return; }
  c.db.prepare("UPDATE creative_renders SET status = 'running', stage = 'generating', attempts = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND workspace_id = ?").run(job.attempts, iso(c), renderId, wsId);

  const ver = getVersion(c, wsId, row.creative_id, row.creative_version);
  const concept = conceptOf(ver);
  const ratio = row.ratio as RatioId;
  const size = RATIO_SIZE(ratio);
  const ctl = new AbortController();
  const watcher = setInterval(() => { if (cancelled()) ctl.abort(); }, 100);
  try {
    let bytes: Buffer;
    try {
      const res = await c.imageProvider.generate({ ratio, ...size, seed: `${row.creative_id}:${row.creative_version}:${ratio}:${row.manual_retries}`, prompt: concept.visualDescription, palette: concept.palette, signal: ctl.signal });
      bytes = res.bytes;
    } catch (e) {
      if (cancelled()) { finish("cancelled", null, null); return; }
      if (e instanceof ProviderError && e.retryable && job.attempts < job.maxAttempts) {
        c.db.prepare("UPDATE creative_renders SET status = 'queued', stage = 'queued', error_code = ?, error_message = ?, attempts = ? WHERE id = ? AND workspace_id = ?").run(e.code, safeError(e.message), job.attempts, renderId, wsId);
        throw new RetryableError(e.message);
      }
      finish("failed", e instanceof ProviderError ? (e.retryable ? "provider_unavailable" : e.code) : "render_failed", safeError(e));
      return;
    }
    if (cancelled()) { finish("cancelled", null, null); return; }

    // Nothing below marks the render complete until the bytes are known good AND stored.
    c.db.prepare("UPDATE creative_renders SET stage = 'validating' WHERE id = ? AND workspace_id = ?").run(renderId, wsId);
    const png = checkPng(bytes);
    const info = readImageInfo(bytes);
    if (!png.ok || !info || info.mime !== "image/png") { finish("failed", "output_invalid", `The returned picture failed its checks (${png.ok ? "not a PNG" : png.reason})`); return; }
    if (!matchesRatio(png.width, png.height, ratio)) { finish("failed", "wrong_ratio", `The picture is ${png.width}×${png.height}, not ${ratio}`); return; }

    c.db.prepare("UPDATE creative_renders SET stage = 'storing' WHERE id = ? AND workspace_id = ?").run(renderId, wsId);
    const prior = c.db.prepare("SELECT asset_id FROM creative_renders WHERE creative_id = ? AND ratio = ? AND workspace_id = ? AND status = 'succeeded' AND asset_id IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get(row.creative_id, ratio, wsId) as { asset_id: string } | undefined;
    const cr = getCreative(c, wsId, row.creative_id);
    const deps: AssetDeps = { c, store: c.assetStore, limits: c.assetLimits };
    let stored: { assetId: string; version: number; sha256: string };
    try {
      stored = await storeGeneratedAsset(deps, wsId, RENDER_ACTOR, { ...(prior ? { assetId: prior.asset_id } : {}), name: `${cr.name} (${ratio})`.slice(0, 120), bytes, provider: c.imageProvider.capabilities.id, model: c.imageProvider.capabilities.model, note: `Generated for creative ${cr.id}` });
    } catch (e) { finish("failed", "storage_failed", safeError(e)); return; }
    c.db.transaction(() => {
      const ok = c.db.prepare("UPDATE creative_renders SET status = 'succeeded', stage = 'done', asset_id = ?, asset_version = ?, sha256 = ?, finished_at = ?, attempts = ?, error_code = NULL, error_message = NULL WHERE id = ? AND workspace_id = ? AND status = 'running'")
        .run(stored.assetId, stored.version, stored.sha256, iso(c), job.attempts, renderId, wsId).changes === 1;
      const stillEditable = editable(getVersion(c, wsId, row.creative_id, row.creative_version));
      if (ok && stillEditable) c.db.prepare(`INSERT INTO creative_variants (creative_id, creative_version, ratio, workspace_id, source, asset_id, asset_version, render_id, created_at) VALUES (?,?,?,?, 'generated', ?,?,?,?)
                                              ON CONFLICT (creative_id, creative_version, ratio) DO UPDATE SET source = 'generated', asset_id = excluded.asset_id, asset_version = excluded.asset_version, render_id = excluded.render_id, created_at = excluded.created_at`)
        .run(row.creative_id, row.creative_version, ratio, wsId, stored.assetId, stored.version, renderId, iso(c));
      audit(c, wsId, RENDER_ACTOR, "creative.render_succeeded", "creative", row.creative_id, { renderId, ratio, assetId: stored.assetId, assetVersion: stored.version, attached: ok && stillEditable });
    })();
  } finally { clearInterval(watcher); }
}

/* ------------------------------------------------------------------------------------------------ imported pictures */

export function attachImportedVariant(c: Core, wsId: string, actor: string, creativeId: string, version: number, input: unknown) {
  const body = ImportVariantSchema.parse(input);
  const v = getVersion(c, wsId, creativeId, version);
  if (!editable(v)) throw conflict("version_locked", `This version is ${v.status}. Edit it to make a new version first.`);
  if (!ratiosOf(v).includes(body.ratio)) throw new AppError(400, "ratio_not_in_version", `${body.ratio} is not one of this version's formats`);
  const f = assetVersionFacts(c, wsId, body.assetId, body.assetVersion);
  if (!f) throw notFound("Asset version");
  if (f.archived) throw conflict("asset_archived", "This asset is archived");
  if (f.status !== "approved") throw conflict("asset_not_approved", "Only an approved image can be attached. Get it approved in Brand → Assets first.");
  if (!matchesRatio(f.width, f.height, body.ratio)) throw conflict("wrong_ratio", `That image is ${f.width}×${f.height}, which is not the ${body.ratio} shape. Attach an image of that shape (cropping is not built).`);
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO creative_variants (creative_id, creative_version, ratio, workspace_id, source, asset_id, asset_version, render_id, created_at) VALUES (?,?,?,?, 'imported', ?,?,NULL,?)
                  ON CONFLICT (creative_id, creative_version, ratio) DO UPDATE SET source = 'imported', asset_id = excluded.asset_id, asset_version = excluded.asset_version, render_id = NULL, created_at = excluded.created_at`)
      .run(creativeId, version, body.ratio, wsId, body.assetId, body.assetVersion, iso(c));
    audit(c, wsId, actor, "creative.image_attached", "creative", creativeId, { version, ratio: body.ratio, assetId: body.assetId, assetVersion: body.assetVersion });
  })();
  return creativeDetail(c, wsId, creativeId);
}

/* ------------------------------------------------------------------------------------------------ checks, review */

/** Runs the automatic checks now, against the CURRENT Business Brain and approved Brand Kit, reading each stored picture back and verifying its hash. */
export async function checkCreative(c: AppContext, wsId: string, creativeId: string, version: number): Promise<QaResult> {
  const v = getVersion(c, wsId, creativeId, version);
  const brain = getBrain(c, wsId);
  if (!brain) throw conflict("brain_required", "Business Brain is required");
  const kit = brandKitView(c, wsId);
  const deps: AssetDeps = { c, store: c.assetStore, limits: c.assetLimits };
  const variants: QaVariant[] = [];
  for (const r of c.db.prepare("SELECT * FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND workspace_id = ?").all(creativeId, version, wsId) as VariantRow[]) {
    const f = assetVersionFacts(c, wsId, r.asset_id, r.asset_version);
    if (!f || !isRatioId(r.ratio)) continue;
    let file: QaVariant["file"] = "ok";
    try { await readAssetFile(deps, wsId, r.asset_id, r.asset_version); } catch (e) { file = e instanceof AppError && e.code === "asset_file_missing" ? "missing" : "corrupt"; }
    variants.push({ ratio: r.ratio, source: r.source, mock: r.source === "generated" && (f.provider ?? "").startsWith("mock"), file, mime: f.mime, width: f.width, height: f.height, sizeBytes: f.size_bytes,
      rightsBasis: f.rights_basis, rightsExpiresAt: f.rights_expires_at, assetStatus: r.source === "generated" ? "generated" : f.status, assetArchived: f.archived });
  }
  const res = runCreativeQa({ concept: conceptOf(v), altText: v.alt_text, ratios: ratiosOf(v), variants, brandKit: kit.approved, brandKitApproved: kit.approved !== null, brain: brain.brain, asOf: c.now(), today: iso(c).slice(0, 10), maxFileBytes: c.assetLimits.maxFileBytes });
  return { ...res, ranAt: iso(c) };
}

export async function submitCreative(c: AppContext, wsId: string, actor: string, creativeId: string, version: number) {
  const cr = getCreative(c, wsId, creativeId);
  if (cr.archived_at) throw conflict("creative_archived", "This creative is archived");
  const v = getVersion(c, wsId, creativeId, version);
  if (!editable(v)) throw conflict("not_submittable", `This version is ${v.status}, so it cannot be submitted`);
  if (c.db.prepare("SELECT 1 FROM creative_renders WHERE creative_id = ? AND creative_version = ? AND workspace_id = ? AND status IN ('queued','running')").get(creativeId, version, wsId)) throw conflict("render_in_progress", "A picture is still being made. Wait for it to finish or cancel it.");
  const qa = await checkCreative(c, wsId, creativeId, version);
  const fails = qa.checks.filter((x) => x.status === "fail");
  if (fails.length) {
    c.db.prepare("UPDATE creative_versions SET qa = ? WHERE creative_id = ? AND version = ? AND workspace_id = ?").run(JSON.stringify(qa), creativeId, version, wsId);
    throw new AppError(409, "qa_failed", `Fix these before sending it for review: ${fails.map((f) => `${f.message}${f.repair ? ` ${f.repair}` : ""}`).join(" | ")}`);
  }
  c.db.transaction(() => {
    const n = c.db.prepare("UPDATE creative_versions SET status = 'needs_review', qa = ?, submitted_by = ?, submitted_at = ?, reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, separation = NULL WHERE creative_id = ? AND version = ? AND workspace_id = ? AND status IN ('draft','rejected')")
      .run(JSON.stringify(qa), actor, iso(c), creativeId, version, wsId).changes;
    if (n !== 1) throw conflict("not_submittable", "This version changed while it was being checked");
    audit(c, wsId, actor, "creative.submitted", "creative", creativeId, { version, passed: qa.passed, warnings: qa.counts.warn });
    const rv = reviewerFor(c, wsId, creativeId, cr.campaign_id);
    if (rv && `user:${rv}` !== actor) notify(c, wsId, rv, "review_requested", `Creative “${cr.name}” version ${version} is waiting for your review.`, { type: "creative", id: creativeId });
  })();
  return creativeDetail(c, wsId, creativeId);
}

export async function decideCreative(c: AppContext, wsId: string, creativeId: string, version: number, decision: "approve" | "reject", input: unknown, by: { decidedBy: string; approver?: { kind: string } }) {
  const body = CreativeDecisionSchema.parse(input ?? {});
  const cr = getCreative(c, wsId, creativeId);
  if (cr.archived_at) throw conflict("creative_archived", "This creative is archived");
  const v = getVersion(c, wsId, creativeId, version);
  if (v.status !== "needs_review") throw conflict("not_submitted", `This version is ${v.status}, so it cannot be reviewed`);
  if (decision === "reject" && !body.reason) throw new AppError(400, "reason_required", "Say why it is being rejected so it can be corrected");
  let qa: QaResult | null = null;
  if (decision === "approve") {
    qa = await checkCreative(c, wsId, creativeId, version); // against what is true NOW, not what was true when it was submitted
    const fails = qa.checks.filter((x) => x.status === "fail");
    if (fails.length) throw new AppError(409, "qa_failed", `It no longer passes the automatic checks: ${fails.map((f) => `${f.message}${f.repair ? ` ${f.repair}` : ""}`).join(" | ")}`);
  }
  c.db.transaction(() => {
    const cur = getVersion(c, wsId, creativeId, version);
    if (cur.status !== "needs_review") throw conflict("not_submitted", `This version is ${cur.status}, so it cannot be reviewed`);
    let separation: SeparationOutcome | null = null;
    if (decision === "approve") {
      separation = separationOutcome(c, wsId, cur.submitted_by, by, "creative");
      c.db.prepare("UPDATE creative_versions SET status = 'superseded' WHERE creative_id = ? AND workspace_id = ? AND status = 'approved' AND version < ?").run(creativeId, wsId, version);
      for (const r of c.db.prepare("SELECT * FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND workspace_id = ?").all(creativeId, version, wsId) as VariantRow[])
        if (r.source === "generated") approveGeneratedVersionInTx(c, wsId, r.asset_id, r.asset_version, by.decidedBy, `Approved with creative ${creativeId} v${version}`, separation);
    }
    c.db.prepare("UPDATE creative_versions SET status = ?, qa = COALESCE(?, qa), reviewed_by = ?, reviewed_at = ?, review_note = ?, separation = ? WHERE creative_id = ? AND version = ? AND workspace_id = ?")
      .run(decision === "approve" ? "approved" : "rejected", qa ? JSON.stringify(qa) : null, by.decidedBy, iso(c), body.reason ?? null, separation, creativeId, version, wsId);
    audit(c, wsId, by.decidedBy, decision === "approve" ? "creative.approved" : "creative.rejected", "creative", creativeId, { version, reason: body.reason ?? null, ...(separation ? { separation, separationEnforced: separation === "enforced" } : {}) });
    closeWorkItemsFor(c, wsId, { kind: "review", creativeId, creativeVersion: version }, decision === "approve" ? "closed_by_approval" : "closed_by_rejection");
    const submitter = cur.submitted_by && cur.submitted_by.startsWith("user:") ? cur.submitted_by.slice(5) : null;
    for (const u of new Set([submitter, ownershipOf(c, wsId, "creative", creativeId).ownerUserId, ownershipOf(c, wsId, "campaign", cr.campaign_id).ownerUserId])) {
      if (u && `user:${u}` !== by.decidedBy) notify(c, wsId, u, decision === "approve" ? "creative_approved" : "creative_rejected", `Creative “${cr.name}” version ${version} was ${decision === "approve" ? "approved" : "rejected"}${body.reason ? `: ${body.reason}` : ""}.`, { type: "creative", id: creativeId });
    }
  })();
  return creativeDetail(c, wsId, creativeId);
}

/* ------------------------------------------------------------------------------------------------ files, and the link to a campaign's proposal */

export async function readVariantFile(c: AppContext, wsId: string, creativeId: string, version: number, ratio: string) {
  getCreative(c, wsId, creativeId);
  const r = c.db.prepare("SELECT asset_id, asset_version FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND ratio = ? AND workspace_id = ?").get(creativeId, version, ratio, wsId) as { asset_id: string; asset_version: number } | undefined;
  if (!r) throw notFound("Picture");
  return readAssetFile({ c, store: c.assetStore, limits: c.assetLimits }, wsId, r.asset_id, r.asset_version);
}

export interface CreativeRef { creativeId: string; version: number; pictures: Array<{ ratio: string; assetId: string; assetVersion: number; sha256: string }> }

/** The approved creatives of a campaign, pinned to exact versions and file hashes. A proposal records this list, so its approval covers exactly these pictures. */
export function approvedCreativesFor(c: Core, wsId: string, campaignId: string): CreativeRef[] {
  const out: CreativeRef[] = [];
  for (const cr of c.db.prepare("SELECT id FROM creatives WHERE workspace_id = ? AND campaign_id = ? AND archived_at IS NULL ORDER BY created_at, id").all(wsId, campaignId) as Array<{ id: string }>) {
    const v = c.db.prepare("SELECT version FROM creative_versions WHERE creative_id = ? AND workspace_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1").get(cr.id, wsId) as { version: number } | undefined;
    if (!v) continue;
    const pictures = (c.db.prepare("SELECT ratio, asset_id, asset_version FROM creative_variants WHERE creative_id = ? AND creative_version = ? AND workspace_id = ? ORDER BY ratio").all(cr.id, v.version, wsId) as Array<{ ratio: string; asset_id: string; asset_version: number }>)
      .map((p) => ({ ratio: p.ratio, assetId: p.asset_id, assetVersion: p.asset_version, sha256: assetVersionFacts(c, wsId, p.asset_id, p.asset_version)?.sha256 ?? "" }));
    out.push({ creativeId: cr.id, version: v.version, pictures });
  }
  return out;
}

/** A proposal that lists creatives is only valid while each is still approved, unarchived, and its pictures are unchanged. */
export function assertCreativesStillApproved(c: Core, wsId: string, refs: CreativeRef[] | undefined): void {
  for (const ref of refs ?? []) {
    const cr = c.db.prepare("SELECT archived_at FROM creatives WHERE id = ? AND workspace_id = ?").get(ref.creativeId, wsId) as { archived_at: string | null } | undefined;
    const v = c.db.prepare("SELECT status FROM creative_versions WHERE creative_id = ? AND version = ? AND workspace_id = ?").get(ref.creativeId, ref.version, wsId) as { status: string } | undefined;
    if (!cr || cr.archived_at || !v || v.status !== "approved") throw conflict("creative_changed", "A creative in this proposal is no longer approved. Propose again so the approval covers what is approved now.");
    for (const p of ref.pictures) {
      const f = assetVersionFacts(c, wsId, p.assetId, p.assetVersion);
      if (!f || f.archived || f.sha256 !== p.sha256) throw conflict("creative_changed", "A picture in this proposal changed or was archived. Propose again.");
    }
  }
}

export { RATIOS };
