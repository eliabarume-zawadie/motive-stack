import { currentGenerationIdentity, type GenerationIdentity, type GenerationParams } from "./versions.js";
import { runAiTask } from "./aiService.js";
import { buildCampaignPrompt } from "./campaignPrompt.js";
import { makeGeneratedBriefSchema } from "../domain/briefRules.js";
import type { AppContext } from "./context.js";
import { audit, iso, type Core } from "./core.js";
import { conflict, notFound } from "./errors.js";
import { getBrain } from "./workspaces.js";
import { newId } from "./util.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../domain/campaignJsonSchema.js";
import { CampaignBriefSchema, type CampaignBrief } from "../domain/schemas.js";

export interface CampaignVersionInfo {
  version: number;
  source: "ai" | "human";
  aiProvider: string | null;
  aiModel: string | null;
  createdAt: string;
  /** What produced this version. Null for human edits and for versions created before this was recorded. */
  generation: { identity: GenerationIdentity; params: GenerationParams | null } | null;
}

export interface CampaignRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: "draft" | "launched_paused";
  currentVersion: number;
  createdAt: string;
  brief: CampaignBrief;
  versions: CampaignVersionInfo[];
  assets: Array<{ kind: string; position: number; content: string }>;
}

interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  status: "draft" | "launched_paused";
  current_version: number;
  created_at: string;
}

function insertVersion(
  c: Core,
  wsId: string,
  campaignId: string,
  version: number,
  brief: CampaignBrief,
  source: "ai" | "human",
  provider: string | null,
  model: string | null,
  generation: { identity: GenerationIdentity; params: GenerationParams } | null = null,
): void {
  c.db
    .prepare(
      "INSERT INTO campaign_versions (campaign_id, workspace_id, version, brief, source, ai_provider, ai_model, created_at, prompt_version, prompt_sha256, schema_version, schema_sha256, generation_params) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(campaignId, wsId, version, JSON.stringify(brief), source, provider, model, iso(c), generation?.identity.promptVersion ?? null, generation?.identity.promptSha256 ?? null, generation?.identity.schemaVersion ?? null, generation?.identity.schemaSha256 ?? null, generation ? JSON.stringify(generation.params) : null);
  const ins = c.db.prepare(
    "INSERT INTO campaign_assets (id, campaign_id, workspace_id, version, kind, position, content) VALUES (?,?,?,?,?,?,?)",
  );
  brief.headlines.forEach((h, i) => ins.run(newId("ast"), campaignId, wsId, version, "headline", i, h));
  brief.primaryTexts.forEach((t, i) => ins.run(newId("ast"), campaignId, wsId, version, "primary_text", i, t));
}

/**
 * Ask a model for a campaign brief through the AI gateway (routing, limits, retries and usage records included).
 * The model only returns data; the gateway has already validated it against CampaignBriefSchema, and this
 * function is the only thing that writes it. A failed or invalid generation stores nothing.
 * With no `req`, the workspace's AI settings choose the model; an explicit provider+model overrides them.
 */
export async function generateCampaign(
  c: AppContext,
  wsId: string,
  req: { providerId?: string; model?: string } = {},
  signal?: AbortSignal,
): Promise<CampaignRecord> {
  const stored = getBrain(c, wsId);
  if (!stored) throw conflict("brain_required", "Save the Business Brain before generating a campaign");

  const { system, prompt } = buildCampaignPrompt(stored.brain, { asOf: c.now() });
  const result = await runAiTask(c, wsId, {
    taskType: "campaign_brief",
    system,
    prompt,
    schemaHint: CAMPAIGN_BRIEF_HINT,
    jsonSchema: CAMPAIGN_BRIEF_JSON_SCHEMA as unknown as Record<string, unknown>,
    context: stored.brain,
    // Structure PLUS every hard rule (budget ceiling, grounding, targeting, differentiators, questions).
    // A brief that breaks a rule is rejected after one repair attempt and never stored as a campaign.
    schema: makeGeneratedBriefSchema(stored.brain, { asOf: c.now() }),
    override: req,
    signal,
  });
  const brief = result.structuredOutput as CampaignBrief;

  const id = newId("cmp");
  c.db.transaction(() => {
    c.db
      .prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, wsId, brief.name, "draft", 1, iso(c));
    const entry = c.registry.find(result.provider, result.model);
    const gs = c.ai.settings();
    const params: GenerationParams = {
      maxOutputTokens: c.maxOutputTokens, repairAttempts: gs.repairAttempts, maxRetries: gs.maxRetries, timeoutMs: entry?.timeoutMs ?? gs.timeoutMs,
      ...(entry?.temperature !== undefined ? { temperature: entry.temperature } : {}), ...(entry?.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      providerMode: c.integrations.aiMode,
    };
    insertVersion(c, wsId, id, 1, brief, "ai", result.provider, result.model, { identity: currentGenerationIdentity(), params });
    audit(c, wsId, `ai:${result.provider}`, "campaign.generated", "campaign", id, {
      model: result.model, version: 1, taskId: result.taskId, simulated: result.simulated, costStatus: result.costStatus,
      attempts: result.attempts.length, usedFallback: result.route.usedFallback,
    });
  })();
  return getCampaignRecord(c, wsId, id);
}

/** A human edit creates a NEW version. Open proposals for older versions become stale. */
export function updateBrief(c: Core, wsId: string, campaignId: string, input: unknown, actor = "owner"): CampaignRecord {
  const cur = getCampaignRow(c, wsId, campaignId);
  if (cur.status === "launched_paused") throw conflict("already_launched", "This campaign already has an external draft; create a new campaign instead");
  const brief = CampaignBriefSchema.parse(input);
  const version = cur.current_version + 1;
  c.db.transaction(() => {
    insertVersion(c, wsId, campaignId, version, brief, "human", null, null);
    c.db.prepare("UPDATE campaigns SET current_version = ?, name = ? WHERE id = ? AND workspace_id = ?").run(version, brief.name, campaignId, wsId);
    const stale = c.db
      .prepare("UPDATE action_proposals SET status = 'stale', updated_at = ? WHERE campaign_id = ? AND workspace_id = ? AND status IN ('proposed','approved')")
      .run(iso(c), campaignId, wsId);
    audit(c, wsId, actor, "campaign.edited", "campaign", campaignId, { version, proposalsMadeStale: stale.changes });
  })();
  return getCampaignRecord(c, wsId, campaignId);
}

export function getCampaignRow(c: Core, wsId: string, campaignId: string): CampaignRow {
  const r = c.db.prepare("SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as CampaignRow | undefined;
  if (!r) throw notFound("Campaign");
  return r;
}

export function getCampaignRecord(c: Core, wsId: string, campaignId: string): CampaignRecord {
  const r = getCampaignRow(c, wsId, campaignId);
  const v = c.db
    .prepare("SELECT brief FROM campaign_versions WHERE campaign_id = ? AND version = ? AND workspace_id = ?")
    .get(campaignId, r.current_version, wsId) as { brief: string };
  const versions = (
    c.db
      .prepare("SELECT version, source, ai_provider, ai_model, created_at, prompt_version, prompt_sha256, schema_version, schema_sha256, generation_params FROM campaign_versions WHERE campaign_id = ? AND workspace_id = ? ORDER BY version")
      .all(campaignId, wsId) as Array<{ version: number; source: "ai" | "human"; ai_provider: string | null; ai_model: string | null; created_at: string; prompt_version: string | null; prompt_sha256: string | null; schema_version: string | null; schema_sha256: string | null; generation_params: string | null }>
  ).map((x) => ({
    version: x.version, source: x.source, aiProvider: x.ai_provider, aiModel: x.ai_model, createdAt: x.created_at,
    generation: x.prompt_version && x.prompt_sha256 && x.schema_version && x.schema_sha256
      ? { identity: { promptVersion: x.prompt_version, promptSha256: x.prompt_sha256, schemaVersion: x.schema_version, schemaSha256: x.schema_sha256 }, params: x.generation_params ? (JSON.parse(x.generation_params) as GenerationParams) : null }
      : null,
  }));
  const assets = c.db
    .prepare("SELECT kind, position, content FROM campaign_assets WHERE campaign_id = ? AND version = ? AND workspace_id = ? ORDER BY kind, position")
    .all(campaignId, r.current_version, wsId) as Array<{ kind: string; position: number; content: string }>;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    status: r.status,
    currentVersion: r.current_version,
    createdAt: r.created_at,
    brief: CampaignBriefSchema.parse(JSON.parse(v.brief)),
    versions,
    assets,
  };
}

export function listCampaigns(c: Core, wsId: string): Array<Pick<CampaignRecord, "id" | "name" | "status" | "currentVersion" | "createdAt">> {
  return (
    c.db.prepare("SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC, id").all(wsId) as CampaignRow[]
  ).map((r) => ({ id: r.id, name: r.name, status: r.status, currentVersion: r.current_version, createdAt: r.created_at }));
}
