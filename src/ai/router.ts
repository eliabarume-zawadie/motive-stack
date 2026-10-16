import type { ProviderInfo } from "./gateway.js";
import { ModelRegistry, type ModelEntry } from "./registry.js";
import { AiError } from "./types.js";
import type { AiMode } from "../integrations/mode.js";

export type RoutingMode = "manual" | "automatic" | "preferred_with_fallback";

export interface RoutingSettings {
  routingMode: RoutingMode;
  provider: string | null;
  model: string | null;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  /** Data policy: providers this workspace's data may be sent to. null = every configured provider. */
  allowedProviders: string[] | null;
}

export interface Candidate {
  provider: string;
  model: string;
  role: "manual" | "automatic" | "primary" | "fallback";
}

export interface RouteInput {
  settings: RoutingSettings;
  task: string;
  needsStructuredOutput: boolean;
  registry: ModelRegistry;
  providers: ProviderInfo[];
  /** mock: simulated only. local: this-machine model servers only. live: paid remote providers only. Never mixed. */
  aiMode: AiMode;
  /** An explicit per-request choice. Behaves as "manual": a single candidate, no fallback. */
  override?: { provider: string; model: string };
}

/** Why an entry is NOT eligible, or null if it is. Security/eligibility rules run BEFORE any selection. */
export function ineligibleReason(e: ModelEntry, i: RouteInput): string | null {
  if (!e.enabled) return "model is disabled in the registry";
  if (!e.tasks.includes(i.task)) return `model is not configured for task "${i.task}"`;
  if (i.needsStructuredOutput && !e.capabilities.structuredOutput) return "model has no structured-output capability";
  const p = i.providers.find((x) => x.id === e.provider);
  if (!p) return "provider is not registered";
  const kind: AiMode = p.simulated ? "mock" : p.local ? "local" : "live";
  if (kind !== i.aiMode) return `${kind === "mock" ? "simulated" : kind} providers are disabled in ${i.aiMode} mode`;
  if (!p.available) return "provider is not available (missing server-side credentials or not enabled)";
  if (!p.models.includes(e.model)) return "model is not served by the provider adapter";
  if (i.settings.allowedProviders && !i.settings.allowedProviders.includes(e.provider)) return "provider is not permitted by this workspace's data policy";
  return null;
}

/**
 * Deterministic routing. Returns an ordered candidate list; the caller advances to the next candidate
 * only for fallback-eligible errors (rate limit, timeout, provider unavailable).
 */
export function route(i: RouteInput): Candidate[] {
  const check = (provider: string, model: string): ModelEntry => {
    const e = i.registry.find(provider, model);
    if (!e) throw new AiError("unknown_model", `Model "${provider}/${model}" is not in the registry`);
    const why = ineligibleReason(e, i);
    if (why) throw new AiError("not_eligible", `${provider}/${model} cannot be used: ${why}`);
    return e;
  };

  if (i.override) {
    check(i.override.provider, i.override.model);
    return [{ ...i.override, role: "manual" }];
  }

  const s = i.settings;
  if (s.routingMode === "manual") {
    if (!s.provider || !s.model) throw new AiError("not_eligible", "Manual routing needs a provider and model in the workspace AI settings");
    check(s.provider, s.model);
    return [{ provider: s.provider, model: s.model, role: "manual" }];
  }

  if (s.routingMode === "preferred_with_fallback") {
    if (!s.provider || !s.model) throw new AiError("not_eligible", "Preferred routing needs a provider and model in the workspace AI settings");
    check(s.provider, s.model);
    const out: Candidate[] = [{ provider: s.provider, model: s.model, role: "primary" }];
    if (s.fallbackProvider && s.fallbackModel && !(s.fallbackProvider === s.provider && s.fallbackModel === s.model)) {
      const fb = i.registry.find(s.fallbackProvider, s.fallbackModel);
      // A fallback that is not eligible (including data policy) is silently NOT used: it is never routed to.
      if (fb && !ineligibleReason(fb, i)) out.push({ provider: fb.provider, model: fb.model, role: "fallback" });
    }
    return out;
  }

  // automatic: cheapest eligible first; ties broken by provider then model id. No fallback.
  const eligible = i.registry.entries.filter((e) => !ineligibleReason(e, i)).sort(ModelRegistry.order);
  const first = eligible[0];
  if (!first) {
    const reasons = i.registry.entries.map((e) => `${e.provider}/${e.model}: ${ineligibleReason(e, i)}`).filter((r) => !r.endsWith("null"));
    throw new AiError("not_eligible", `No eligible model for task "${i.task}". ${reasons.join("; ")}`);
  }
  return [{ provider: first.provider, model: first.model, role: "automatic" }];
}
