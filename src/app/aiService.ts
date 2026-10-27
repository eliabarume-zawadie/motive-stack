import { z } from "zod";
import { ineligibleReason, route, type Candidate, type RoutingMode, type RoutingSettings } from "../ai/router.js";
import { AiError, FALLBACK_ELIGIBLE, type AttemptRecord, type GatewayResult } from "../ai/types.js";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { getWorkspace } from "./workspaces.js";
import { newId } from "./util.js";

/* ------------------------------------------------------------------ settings */

export interface AiSettings extends RoutingSettings {
  maxRequestsPerDay: number | null;
  monthlyBudgetMicros: number | null;
  updatedAt: string | null;
}

interface SettingsRow {
  routing_mode: RoutingMode;
  provider: string | null;
  model: string | null;
  fallback_provider: string | null;
  fallback_model: string | null;
  allowed_providers: string | null;
  max_requests_per_day: number | null;
  monthly_budget_micros: number | null;
  updated_at: string;
}

/** Default for a workspace that has never saved settings: automatic routing, every provider allowed, no limits. */
const DEFAULTS: AiSettings = {
  routingMode: "automatic", provider: null, model: null, fallbackProvider: null, fallbackModel: null,
  allowedProviders: null, maxRequestsPerDay: null, monthlyBudgetMicros: null, updatedAt: null,
};

export function getAiSettings(c: AppContext, wsId: string): AiSettings {
  getWorkspace(c, wsId);
  const r = c.db.prepare("SELECT * FROM ai_settings WHERE workspace_id = ?").get(wsId) as SettingsRow | undefined;
  if (!r) return { ...DEFAULTS };
  return {
    routingMode: r.routing_mode, provider: r.provider, model: r.model,
    fallbackProvider: r.fallback_provider, fallbackModel: r.fallback_model,
    allowedProviders: r.allowed_providers ? (JSON.parse(r.allowed_providers) as string[]) : null,
    maxRequestsPerDay: r.max_requests_per_day, monthlyBudgetMicros: r.monthly_budget_micros, updatedAt: r.updated_at,
  };
}

export const AiSettingsInputSchema = z.object({
  routingMode: z.enum(["manual", "automatic", "preferred_with_fallback"]),
  provider: z.string().min(1).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  fallbackProvider: z.string().min(1).nullable().default(null),
  fallbackModel: z.string().min(1).nullable().default(null),
  allowedProviders: z.array(z.string().min(1)).min(1).nullable().default(null),
  maxRequestsPerDay: z.number().int().positive().nullable().default(null),
  monthlyBudgetMicros: z.number().int().positive().nullable().default(null),
}).strict();

export function putAiSettings(c: AppContext, wsId: string, input: unknown, actor = "owner"): AiSettings {
  getWorkspace(c, wsId);
  const s = AiSettingsInputSchema.parse(input);
  const bad = (m: string): never => { throw new AiError("invalid_request", m); };
  const known = new Set(c.registry.providers());

  if (s.allowedProviders) for (const p of s.allowedProviders) if (!known.has(p)) bad(`Unknown provider "${p}" in the allow-list`);
  const needsPrimary = s.routingMode !== "automatic";
  if (needsPrimary) {
    if (!s.provider || !s.model) bad(`Routing mode "${s.routingMode}" needs a provider and model`);
    if (!c.registry.find(s.provider as string, s.model as string)) bad(`Model "${s.provider}/${s.model}" is not in the registry`);
    if (s.allowedProviders && !s.allowedProviders.includes(s.provider as string)) bad("The selected provider is not in the data-policy allow-list");
  }
  if (s.routingMode === "preferred_with_fallback") {
    if ((s.fallbackProvider === null) !== (s.fallbackModel === null)) bad("Fallback needs both a provider and a model");
    if (s.fallbackProvider && s.fallbackModel) {
      if (!c.registry.find(s.fallbackProvider, s.fallbackModel)) bad(`Fallback "${s.fallbackProvider}/${s.fallbackModel}" is not in the registry`);
      if (s.fallbackProvider === s.provider && s.fallbackModel === s.model) bad("The fallback must differ from the preferred model");
      if (s.allowedProviders && !s.allowedProviders.includes(s.fallbackProvider)) bad("The fallback provider is not in the data-policy allow-list");
    }
  }
  const keep = (v: string | null) => (needsPrimary ? v : null);
  const fb = s.routingMode === "preferred_with_fallback";

  c.db.prepare(
    `INSERT INTO ai_settings (workspace_id, routing_mode, provider, model, fallback_provider, fallback_model, allowed_providers, max_requests_per_day, monthly_budget_micros, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(workspace_id) DO UPDATE SET routing_mode=excluded.routing_mode, provider=excluded.provider, model=excluded.model,
       fallback_provider=excluded.fallback_provider, fallback_model=excluded.fallback_model, allowed_providers=excluded.allowed_providers,
       max_requests_per_day=excluded.max_requests_per_day, monthly_budget_micros=excluded.monthly_budget_micros, updated_at=excluded.updated_at`,
  ).run(wsId, s.routingMode, keep(s.provider), keep(s.model), fb ? s.fallbackProvider : null, fb ? s.fallbackModel : null,
    s.allowedProviders ? JSON.stringify(s.allowedProviders) : null, s.maxRequestsPerDay, s.monthlyBudgetMicros, iso(c));
  audit(c, wsId, actor, "ai.settings_saved", "ai_settings", wsId, { routingMode: s.routingMode, provider: s.provider, model: s.model });
  return getAiSettings(c, wsId);
}

/* -------------------------------------------------------------- usage records */

export interface UsageRow {
  id: string; taskId: string; taskType: string; provider: string; model: string; mode: "mock" | "local" | "live"; simulated: boolean;
  attemptNo: number; attemptKind: string; outcome: string; startedAt: string; latencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; usageSource: string | null;
  estimatedCostMicros: number | null; currency: string | null; costStatus: string; requestId: string | null;
  fallbackFrom: string | null; errorMessage: string | null;
}

function recordUsage(
  c: AppContext, wsId: string, taskId: string, taskType: string, attemptNo: number, a: Partial<AttemptRecord> & Pick<AttemptRecord, "provider" | "model" | "simulated">,
  kind: string, outcome: string, startedAt: string, fallbackFrom: string | null, costStatus: string, message?: string,
): void {
  c.db.prepare(
    `INSERT INTO ai_usage (id, workspace_id, task_id, task_type, provider, model, mode, simulated, attempt_no, attempt_kind, outcome, started_at, latency_ms,
       input_tokens, output_tokens, usage_source, estimated_cost_micros, currency, cost_status, request_id, fallback_from, error_message)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId("use"), wsId, taskId, taskType, a.provider, a.model, a.simulated ? "mock" : c.ai.get(a.provider)?.local ? "local" : "live", a.simulated ? 1 : 0, attemptNo, kind, outcome, startedAt, a.latencyMs ?? null,
    a.usage?.inputTokens ?? null, a.usage?.outputTokens ?? null, a.usage?.source ?? null, a.estimatedCostMicros ?? null, c.ai.currency, costStatus, a.requestId ?? null,
    fallbackFrom, message ? message.slice(0, 300) : null,
  );
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export function listUsage(c: AppContext, wsId: string, limit = 50): UsageRow[] {
  return (c.db.prepare("SELECT * FROM ai_usage WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(wsId, limit) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string, taskId: r.task_id as string, taskType: r.task_type as string, provider: r.provider as string, model: r.model as string,
    mode: r.mode as "mock" | "local" | "live", simulated: r.simulated === 1, attemptNo: r.attempt_no as number, attemptKind: r.attempt_kind as string,
    outcome: r.outcome as string, startedAt: r.started_at as string, latencyMs: r.latency_ms as number | null,
    inputTokens: r.input_tokens as number | null, outputTokens: r.output_tokens as number | null, usageSource: r.usage_source as string | null,
    estimatedCostMicros: r.estimated_cost_micros as number | null, currency: r.currency as string | null, costStatus: r.cost_status as string,
    requestId: r.request_id as string | null, fallbackFrom: r.fallback_from as string | null, errorMessage: r.error_message as string | null,
  }));
}

export function usageSummary(c: AppContext, wsId: string) {
  const now = c.now();
  const q = (since: string) => c.db.prepare(
    `SELECT COUNT(*) attempts,
            SUM(CASE WHEN mode = 'live' AND attempt_kind != 'blocked' THEN 1 ELSE 0 END) live_requests,
            SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END) simulated_requests,
            SUM(CASE WHEN mode = 'local' THEN 1 ELSE 0 END) local_requests,
            SUM(estimated_cost_micros) known_cost,
            SUM(CASE WHEN mode = 'live' AND estimated_cost_micros IS NULL AND attempt_kind != 'blocked' THEN 1 ELSE 0 END) unknown_cost_requests
     FROM ai_usage WHERE workspace_id = ? AND started_at >= ?`,
  ).get(wsId, since) as Record<string, number | null>;
  const shape = (r: Record<string, number | null>) => ({
    attempts: r.attempts ?? 0, liveRequests: r.live_requests ?? 0, simulatedRequests: r.simulated_requests ?? 0, localRequests: r.local_requests ?? 0,
    knownCostMicros: r.known_cost ?? 0, requestsWithUnknownCost: r.unknown_cost_requests ?? 0,
  });
  return { currency: c.ai.currency, today: shape(q(dayStart(now))), thisMonth: shape(q(monthStart(now))) };
}

/* ------------------------------------------------------------------- limits */

/**
 * Enforced BEFORE any billable (live) request. Mock/simulated requests are never billable and never blocked.
 * A cost ceiling cannot be enforced for a model with no configured price, so such a request is refused rather than guessed.
 */
function checkLimits(c: AppContext, wsId: string, s: AiSettings, cand: Candidate, taskId: string, taskType: string, attemptNo: number, size?: { inputTokens: number; maxOutputTokens: number }): void {
  const p = c.ai.get(cand.provider);
  if (!p || p.simulated || p.local) return; // simulated and local requests have no per-token charge: nothing to limit
  const block = (kind: "budget_exhausted" | "budget_unverifiable", msg: string): never => {
    recordUsage(c, wsId, taskId, taskType, attemptNo, { provider: cand.provider, model: cand.model, simulated: false }, "blocked", kind, iso(c), null, "unknown_no_usage", msg);
    audit(c, wsId, "system", "ai.blocked", "ai_task", taskId, { kind, provider: cand.provider, model: cand.model });
    throw new AiError(kind, msg);
  };
  const now = c.now();
  checkLiveCeiling(c, cand, size, block);
  if (s.maxRequestsPerDay !== null) {
    const n = (c.db.prepare("SELECT COUNT(*) n FROM ai_usage WHERE workspace_id = ? AND mode = 'live' AND attempt_kind != 'blocked' AND started_at >= ?").get(wsId, dayStart(now)) as { n: number }).n;
    if (n >= s.maxRequestsPerDay) block("budget_exhausted", `Daily AI request limit reached (${n}/${s.maxRequestsPerDay})`);
  }
  if (s.monthlyBudgetMicros !== null) {
    if (!c.ai.hasPrice(cand.provider, cand.model)) block("budget_unverifiable", `A monthly AI budget is set but no price is configured for ${cand.provider}/${cand.model}, so its cost cannot be verified`);
    const spent = (c.db.prepare("SELECT COALESCE(SUM(estimated_cost_micros),0) n FROM ai_usage WHERE workspace_id = ? AND started_at >= ?").get(wsId, monthStart(now)) as { n: number }).n;
    if (spent >= s.monthlyBudgetMicros) block("budget_exhausted", `Monthly AI budget reached (${spent}/${s.monthlyBudgetMicros} micro-units)`);
  }
}

/* ---------------------------------------------------- server-side live ceiling */

/** What live AI requests have cost this UTC month, across ALL workspaces, from the usage records. An estimate from provider-reported tokens and the price list. */
export function liveSpend(c: AppContext) {
  const now = c.now();
  const r = c.db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_micros),0) spent,
            SUM(CASE WHEN estimated_cost_micros IS NULL AND outcome IN ('ok','invalid_output','response_rejected') THEN 1 ELSE 0 END) unpriced
     FROM ai_usage WHERE mode = 'live' AND attempt_kind != 'blocked' AND started_at >= ?`,
  ).get(monthStart(now)) as { spent: number; unpriced: number | null };
  const day = c.db.prepare("SELECT COUNT(*) n FROM ai_usage WHERE mode = 'live' AND attempt_kind != 'blocked' AND started_at >= ?").get(dayStart(now)) as { n: number };
  return { spentMicros: r.spent, requestsWithUnknownCost: r.unpriced ?? 0, requestsToday: day.n };
}

/**
 * The operator's ceiling for paid AI, enforced on the server before every live request. It cannot be raised from the browser or by a
 * workspace's own settings (those can only be stricter). The request must fit even in the worst case: every possible attempt (first
 * try, retries, a repair) using the full input and the full output cap at the configured price. If any of that cannot be established,
 * the request is refused rather than guessed. This is the application's own estimate; it is not the provider's billing limit.
 */
function checkLiveCeiling(c: AppContext, cand: Candidate, size: { inputTokens: number; maxOutputTokens: number } | undefined, block: (kind: "budget_exhausted" | "budget_unverifiable", msg: string) => never): void {
  const pol = c.aiPolicy;
  if (pol.liveBudgetMicros === null) block("budget_unverifiable", "Live AI is switched on, but no spending ceiling is set on the server, so no request was sent. Set AI_LIVE_BUDGET_MICROS (for example 50000 means 0.05 USD per month) and restart.");
  const ceiling = pol.liveBudgetMicros as number;
  if (!c.ai.hasPrice(cand.provider, cand.model)) block("budget_unverifiable", `No price is configured for ${cand.provider}/${cand.model}, so its cost cannot be limited and no request was sent.`);
  const spend = liveSpend(c);
  if (pol.liveMaxRequestsPerDay !== null && spend.requestsToday >= pol.liveMaxRequestsPerDay) block("budget_exhausted", `The server's daily limit of ${pol.liveMaxRequestsPerDay} live AI requests was reached.`);
  if (spend.requestsWithUnknownCost > 0) block("budget_unverifiable", `${spend.requestsWithUnknownCost} earlier live request(s) this month returned no usable token count, so the money spent cannot be verified and further live requests are paused.`);
  if (!size) return;
  const worst = c.pricing.estimate(cand.provider, cand.model, { inputTokens: size.inputTokens, outputTokens: size.maxOutputTokens, source: "provider" }, false);
  if (worst.micros === null) block("budget_unverifiable", `The worst-case cost of this request cannot be computed for ${cand.provider}/${cand.model} (the price list does not cover this size), so no request was sent.`);
  const reserve = (worst.micros as number) * pol.attemptsPerRequest;
  if (spend.spentMicros + reserve > ceiling) {
    block("budget_exhausted", `The server's live AI spending ceiling would be exceeded: about ${spend.spentMicros} used this month, up to ${reserve} reserved for this request, ceiling ${ceiling} (micro-units of ${c.ai.currency}). No request was sent.`);
  }
}

/* ------------------------------------------------------------------ context guard */

/** Rough, deliberately pessimistic token estimate (about 3 characters per token). */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3);

/**
 * Refuse a request that cannot fit the model's served context window. Ollama would otherwise silently drop the
 * start of an oversized prompt, producing a plausible but corrupted answer with no error.
 */
function checkContextFits(c: AppContext, cand: Candidate, system: string, prompt: string, maxOut: number): void {
  const ctxTokens = c.registry.find(cand.provider, cand.model)?.contextTokens;
  if (!ctxTokens) return;
  const need = estimateTokens(system) + estimateTokens(prompt) + maxOut;
  if (need > ctxTokens) {
    throw new AiError(
      "invalid_request",
      `The prompt is too large for ${cand.provider}/${cand.model}: about ${need} tokens (prompt plus output cap) against a ${ctxTokens}-token context window. ` +
        "Shorten the Business Brain, lower AI_MAX_OUTPUT_TOKENS, or raise the model's context in Ollama and the registry. Nothing was sent.",
    );
  }
}

/* ------------------------------------------------------------------ the task */

export interface AiTaskInput<T> {
  taskType: string;
  system: string;
  prompt: string;
  schemaHint: string;
  jsonSchema?: Record<string, unknown>;
  context: unknown;
  schema: z.ZodType<T>;
  /** Explicit per-request choice. Acts as manual routing: one candidate, no fallback. */
  override?: { providerId?: string; model?: string };
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export type AiTaskResult<T> = GatewayResult<T> & {
  taskId: string;
  route: { mode: RoutingMode | "override"; usedFallback: boolean; fallbackFrom: string | null };
};

function routeFor(c: AppContext, s: AiSettings, task: string, structured: boolean, override?: { providerId?: string; model?: string }): Candidate[] {
  const ov = override?.providerId && override.model ? { provider: override.providerId, model: override.model } : undefined;
  if (override && (override.providerId || override.model) && !ov) throw new AiError("invalid_request", "An explicit selection needs both a provider and a model");
  return route({ settings: s, task, needsStructuredOutput: structured, registry: c.registry, providers: c.ai.list(), aiMode: c.integrations.aiMode, override: ov });
}

/**
 * Run a generation task for a workspace: route -> enforce limits -> call the gateway -> record every attempt.
 * Falls back to the next candidate ONLY for rate limits, timeouts and provider outages. Authentication,
 * balance, budget and data-policy failures never fall back. This function generates; it never authorizes or executes anything.
 */
export async function runAiTask<T>(c: AppContext, wsId: string, input: AiTaskInput<T>): Promise<AiTaskResult<T>> {
  const settings = getAiSettings(c, wsId);
  const candidates = routeFor(c, settings, input.taskType, true, input.override);
  const taskId = newId("aitask");
  let attemptNo = 0;
  let prev: Candidate | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i] as Candidate;
    const p = c.ai.get(cand.provider);
    if (p && !p.simulated && !(p.local ? c.integrations.localAi : c.integrations.liveAi)) {
      throw new AiError("live_disabled", p.local ? "Local AI is not enabled (AI_PROVIDER_MODE=local)" : "Live AI provider calls are not enabled");
    }
    checkLimits(c, wsId, settings, cand, taskId, input.taskType, attemptNo + 1, { inputTokens: estimateTokens(input.system) + estimateTokens(input.prompt), maxOutputTokens: Math.min(input.maxOutputTokens ?? c.maxOutputTokens, c.maxOutputTokens) });
    checkContextFits(c, cand, input.system, input.prompt, Math.min(input.maxOutputTokens ?? c.maxOutputTokens, c.maxOutputTokens));

    const fromLabel = prev ? `${prev.provider}/${prev.model}` : null;
    let first = true;
    try {
      const res = await c.ai.generate(cand.provider, {
        task: input.taskType, system: input.system, prompt: input.prompt, schemaHint: input.schemaHint, jsonSchema: input.jsonSchema,
        context: input.context, schema: input.schema, model: cand.model, maxOutputTokens: Math.min(input.maxOutputTokens ?? c.maxOutputTokens, c.maxOutputTokens),
      }, {
        signal: input.signal,
        timeoutMs: c.registry.find(cand.provider, cand.model)?.timeoutMs,
        observer: (a) => {
          attemptNo++;
          const kind = first && fromLabel ? "fallback" : a.kind;
          first = false;
          recordUsage(c, wsId, taskId, input.taskType, attemptNo, a, kind, a.outcome, iso(c), fromLabel, a.costStatus, a.errorMessage);
        },
      });
      audit(c, wsId, `ai:${cand.provider}`, "ai.task_succeeded", "ai_task", taskId, { taskType: input.taskType, model: cand.model, simulated: res.simulated, attempts: res.attempts.length, costStatus: res.costStatus, usedFallback: !!fromLabel });
      return { ...res, taskId, route: { mode: input.override?.providerId ? "override" : settings.routingMode, usedFallback: !!fromLabel, fallbackFrom: fromLabel } };
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError("provider_unavailable", "Unexpected AI failure");
      audit(c, wsId, `ai:${cand.provider}`, "ai.task_failed", "ai_task", taskId, { taskType: input.taskType, kind: err.kind, model: cand.model });
      const next = candidates[i + 1];
      if (next && FALLBACK_ELIGIBLE.has(err.kind)) { prev = cand; continue; }
      throw err;
    }
  }
  throw new AiError("not_eligible", "No candidate model could be used");
}

/* -------------------------------------------------------- explicit connection test */

export interface ConnectionTestResult {
  simulated: boolean;
  /** true/false only for a REAL request. null for a simulated test: nothing was verified. */
  connected: boolean | null;
  provider: string;
  model: string;
  message: string;
  latencyMs?: number;
  requestId?: string;
  errorKind?: string;
}

/**
 * Explicit, user-initiated check. In mock mode it is clearly simulated and never reports a real connection.
 * In live mode it makes one tiny real request that counts toward limits and is recorded like any other.
 */
export async function connectionTest(c: AppContext, wsId: string, providerId: string, model: string): Promise<ConnectionTestResult> {
  const settings = getAiSettings(c, wsId);
  const p = c.ai.get(providerId);
  if (!p) throw new AiError("unknown_provider", `Unknown AI provider "${providerId}"`);
  if (p.simulated) {
    return { simulated: true, connected: null, provider: providerId, model, message: "Simulated test only. No real connection was made, so nothing was verified." };
  }
  if (p.local ? !c.integrations.localAi : !c.integrations.liveAi) {
    throw new AiError("live_disabled", p.local ? "Local AI is off (needs AI_PROVIDER_MODE=local). No request was made." : "Live AI is off (needs AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true). No request was made.");
  }
  const [cand] = routeFor(c, settings, "connection_test", false, { providerId, model });
  const taskId = newId("aitask");
  let attemptNo = 0;
  checkLimits(c, wsId, settings, cand as Candidate, taskId, "connection_test", 1, { inputTokens: 60, maxOutputTokens: Math.min(64, c.maxOutputTokens) });
  try {
    const res = await c.ai.generateText(providerId, { task: "connection_test", system: "You are a connectivity probe.", prompt: "Reply with the single word: pong", model, maxOutputTokens: Math.min(64, c.maxOutputTokens) }, {
      timeoutMs: c.registry.find(providerId, model)?.timeoutMs,
      observer: (a) => { attemptNo++; recordUsage(c, wsId, taskId, "connection_test", attemptNo, a, a.kind, a.outcome, iso(c), null, a.costStatus, a.errorMessage); },
    });
    audit(c, wsId, "owner", "ai.connection_test", "ai_task", taskId, { provider: providerId, model, ok: true });
    return { simulated: false, connected: true, provider: providerId, model, message: p.local ? "Real request to the local model server succeeded (no charge)." : "Real request succeeded.", latencyMs: res.latencyMs, requestId: res.requestId };
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("provider_unavailable", "Unexpected failure");
    audit(c, wsId, "owner", "ai.connection_test", "ai_task", taskId, { provider: providerId, model, ok: false, kind: err.kind });
    return { simulated: false, connected: false, provider: providerId, model, message: err.message, errorKind: err.kind, requestId: err.requestId };
  }
}

/* ------------------------------------------------------------ model listing */

export interface ModelView {
  provider: string;
  model: string;
  label: string;
  simulated: boolean;
  costTier: string;
  /** True if a price is configured, so cost can be estimated. */
  priced: boolean;
  notes: string | null;
  local: boolean;
  eligible: boolean;
  /** Why the model cannot be used right now (null when eligible). */
  reason: string | null;
}

/** Every registry model with whether this workspace may use it for campaign generation right now, and why not. */
export function listModels(c: AppContext, wsId: string, task = "campaign_brief"): ModelView[] {
  const settings = getAiSettings(c, wsId);
  const providers = c.ai.list();
  const input = { settings, task, needsStructuredOutput: true, registry: c.registry, providers, aiMode: c.integrations.aiMode };
  return c.registry.entries.map((e) => {
    const reason = ineligibleReason(e, input);
    return {
      provider: e.provider, model: e.model, label: e.label, simulated: providers.find((p) => p.id === e.provider)?.simulated ?? false, local: providers.find((p) => p.id === e.provider)?.local ?? false,
      costTier: e.costTier, priced: c.ai.hasPrice(e.provider, e.model), notes: e.notes ?? null, eligible: reason === null, reason,
    };
  });
}

/* ------------------------------------------------- local testing: status + one short request */

export interface AiProviderStatus {
  mode: "mock" | "local" | "live";
  liveCallsAllowed: boolean;
  providers: Array<{ id: string; label: string; simulated: boolean; local: boolean; available: boolean; keyConfigured: boolean | null; models: Array<{ model: string; label: string; priced: boolean }> }>;
  budget: {
    configured: boolean; ceilingMicros: number | null; spentMicros: number; remainingMicros: number | null; requestsToday: number; maxRequestsPerDay: number | null;
    requestsWithUnknownCost: number; currency: string; note: string;
  };
  openaiStoreFalse: boolean;
  nextStep: string;
}

/** Whether AI is set up, WITHOUT revealing any key: key presence is a yes/no taken from the server's environment at startup. */
export function aiProviderStatus(c: AppContext): AiProviderStatus {
  const pol = c.aiPolicy;
  const spend = liveSpend(c);
  const keyOf = (id: string): boolean | null => (id === "openai" ? pol.keyPresent.openai : id === "anthropic" ? pol.keyPresent.anthropic : null);
  const infos = c.ai.list();
  const mode = c.integrations.aiMode;
  const openaiKey = pol.keyPresent.openai;
  let nextStep: string;
  if (mode === "mock") nextStep = `AI is in mock mode: nothing is sent to any provider and nothing is charged.${openaiKey ? " An OpenAI key is present on the server but is ignored in mock mode." : " No OpenAI key is set on the server."} To try OpenAI, restart the server with AI_PROVIDER_MODE=live, ALLOW_LIVE_PROVIDER_CALLS=true and AI_LIVE_BUDGET_MICROS=50000 (a 0.05 USD monthly ceiling).`;
  else if (mode === "live" && !openaiKey) nextStep = "Live AI is on but no OpenAI key is set on the server (OPENAI_API_KEY). Add it to the server's environment file and restart. The key is never shown here.";
  else if (mode === "live" && pol.liveBudgetMicros === null) nextStep = "Live AI is on but no spending ceiling is set, so every live request will be refused. Set AI_LIVE_BUDGET_MICROS and restart.";
  else if (mode === "live") nextStep = "Ready for a live test. Each request is checked against the ceiling first and may be billed by the provider.";
  else nextStep = "Local AI mode: requests go to a model on this computer and are not billed.";
  return {
    mode, liveCallsAllowed: c.integrations.allowLiveProviderCalls,
    providers: infos.map((p) => ({
      id: p.id, label: p.label, simulated: p.simulated, local: !!p.local, available: p.available, keyConfigured: p.simulated || p.local ? null : keyOf(p.id),
      models: c.registry.entries.filter((e) => e.provider === p.id && e.enabled).map((e) => ({ model: e.model, label: e.label, priced: c.ai.hasPrice(e.provider, e.model) })),
    })),
    budget: {
      configured: pol.liveBudgetMicros !== null, ceilingMicros: pol.liveBudgetMicros, spentMicros: spend.spentMicros,
      remainingMicros: pol.liveBudgetMicros === null ? null : Math.max(0, pol.liveBudgetMicros - spend.spentMicros), requestsToday: spend.requestsToday,
      maxRequestsPerDay: pol.liveMaxRequestsPerDay, requestsWithUnknownCost: spend.requestsWithUnknownCost, currency: c.ai.currency,
      note: "This ceiling is enforced by this application from provider-reported token counts and the price list. It is an estimate and is not your provider's own billing limit; set a limit in the provider's dashboard too.",
    },
    openaiStoreFalse: pol.openaiStore === false,
    nextStep,
  };
}

export interface TestRequestResult {
  status: "ok" | "error";
  /** mock = simulated, no provider contacted. local = model on this computer. live = a paid provider. */
  mode: "mock" | "local" | "live";
  provider: string;
  model: string;
  text?: string;
  errorKind?: string;
  message?: string;
  usage: { inputTokens: number | null; outputTokens: number | null; source: string | null } | null;
  /** Estimated from provider-reported tokens and the price list. null = unknown (never shown as 0). */
  estimatedCostMicros: number | null;
  costStatus: string;
  currency: string;
  latencyMs?: number;
  requestId?: string;
}

const TEST_SYSTEM = "Answer in at most two short plain sentences.";
const TEST_MAX_OUTPUT = 200;

/** One short, explicit, user-started request. Counts against every limit and is recorded like any other. Nothing else uses the answer. */
export async function runTestRequest(c: AppContext, wsId: string, providerId: string, model: string, promptInput: string): Promise<TestRequestResult> {
  const prompt = String(promptInput ?? "").trim();
  if (!prompt) throw new AiError("invalid_request", "Type a short question first.");
  if (prompt.length > 500) throw new AiError("invalid_request", "Keep the test question under 500 characters.");
  const settings = getAiSettings(c, wsId);
  const p = c.ai.get(providerId);
  if (!p) throw new AiError("unknown_provider", `Unknown AI provider "${providerId}"`);
  const mode: "mock" | "local" | "live" = p.simulated ? "mock" : p.local ? "local" : "live";
  if (!p.simulated && (p.local ? !c.integrations.localAi : !c.integrations.liveAi)) {
    throw new AiError("live_disabled", p.local ? "Local AI is off (needs AI_PROVIDER_MODE=local). No request was made." : "Live AI is off (needs AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true). No request was made.");
  }
  const [cand] = routeFor(c, settings, "connection_test", false, { providerId, model });
  const taskId = newId("aitask");
  let attemptNo = 0;
  const maxOut = Math.min(TEST_MAX_OUTPUT, c.maxOutputTokens);
  checkLimits(c, wsId, settings, cand as Candidate, taskId, "test_request", 1, { inputTokens: estimateTokens(TEST_SYSTEM) + estimateTokens(prompt), maxOutputTokens: maxOut });
  const currency = c.ai.currency;
  try {
    const res = await c.ai.generateText(providerId, { task: "test_request", system: TEST_SYSTEM, prompt, model, maxOutputTokens: maxOut }, {
      timeoutMs: c.registry.find(providerId, model)?.timeoutMs,
      observer: (a) => { attemptNo++; recordUsage(c, wsId, taskId, "test_request", attemptNo, a, a.kind, a.outcome, iso(c), null, a.costStatus, a.errorMessage); },
    });
    audit(c, wsId, "owner", "ai.test_request", "ai_task", taskId, { provider: providerId, model, mode, ok: true });
    return {
      status: "ok", mode, provider: providerId, model, text: (res.text ?? "").slice(0, 2000),
      usage: res.usage ? { inputTokens: res.usage.inputTokens ?? null, outputTokens: res.usage.outputTokens ?? null, source: res.usage.source } : null,
      estimatedCostMicros: res.estimatedCostMicros, costStatus: res.costStatus, currency, latencyMs: res.latencyMs, requestId: res.requestId,
    };
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("provider_unavailable", "Unexpected failure");
    audit(c, wsId, "owner", "ai.test_request", "ai_task", taskId, { provider: providerId, model, mode, ok: false, kind: err.kind });
    return {
      status: "error", mode, provider: providerId, model, errorKind: err.kind, message: err.message,
      usage: err.usage ? { inputTokens: err.usage.inputTokens ?? null, outputTokens: err.usage.outputTokens ?? null, source: err.usage.source } : null,
      estimatedCostMicros: null, costStatus: "unknown_no_usage", currency, requestId: err.requestId,
    };
  }
}
