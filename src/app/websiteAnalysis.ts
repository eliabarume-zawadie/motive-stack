import { createHash } from "node:crypto";
import { AiError } from "../ai/types.js";
import { CrawlRefused, crawlSite, type CrawlResult } from "../web/crawler.js";
import { UnsafeUrlError, parseWebsiteUrl } from "../web/urlSafety.js";
import { runAiTask } from "./aiService.js";
import type { AppContext } from "./context.js";
import { audit, iso } from "./core.js";
import { AppError, notFound } from "./errors.js";
import { newId } from "./util.js";
import { getBrain } from "./workspaces.js";
import {
  ANALYSIS_JSON_SCHEMA, AnalysisOutputSchema, buildBrainPatch, buildPrompt, CATEGORY_LABEL, FLAG_TEXT, SCHEMA_HINT, SYSTEM_PROMPT, simulatedInsights, verifyInsights,
  type BrainPatch, type InsightBasis, type InsightCategory, type InsightRow, type PageText,
} from "./websiteInsights.js";

/**
 * Business Brain website analysis: read the owner's public website (bounded, safe), turn it into PROPOSED findings with evidence, and let
 * the owner approve, edit or reject each before anything reaches the Business Brain. The analysis never edits the Business Brain itself.
 */

const STALE_RUNNING_MS = 5 * 60_000;
const CACHE_MS = 24 * 60 * 60_000;
const REFRESH_MIN_GAP_MS = 60_000;
const ANALYSIS_MAX_OUTPUT_TOKENS = 3000;

interface AnalysisRow {
  id: string; workspace_id: string; url: string; site: string; status: "running" | "ready" | "failed"; step: string; error_code: string | null; error_message: string | null;
  robots: string | null; pages: string; page_text: string | null; notes: string; analysis_mode: "simulated" | "ai" | null; provider: string | null; model: string | null;
  task_id: string | null; usage: string | null; created_at: string; created_by: string; completed_at: string | null;
}
interface InsightDbRow {
  id: string; analysis_id: string; position: number; category: InsightCategory; text: string; original_text: string; basis: InsightBasis; evidence: string; flags: string;
  status: "proposed" | "approved" | "rejected"; edited: number; decided_at: string | null; decided_by: string | null;
}

export interface InsightView extends InsightRow {
  label: string;
  originalText: string;
  edited: boolean;
  flagNotes: string[];
  decidedAt: string | null;
}

export interface AnalysisView {
  id: string;
  url: string;
  site: string;
  status: "running" | "ready" | "failed";
  step: string;
  error: { code: string; message: string } | null;
  robots: string | null;
  pages: Array<{ url: string; title: string; status: string; reason: string | null; chars: number; looksLikeInstructions: boolean }>;
  notes: string[];
  /** "simulated": read from the pages without AI (mock mode). "ai": produced by a real model (or a local one). */
  mode: "simulated" | "ai" | null;
  provider: string | null;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costMicros: number | null; costStatus: string; currency: string } | null;
  createdAt: string;
  completedAt: string | null;
  /** True when this answer came from a recent earlier analysis instead of reading the site again. */
  cached: boolean;
  canRetryAi: boolean;
  insights: InsightView[];
}

const parse = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

function rowOf(c: AppContext, wsId: string, id: string): AnalysisRow {
  const r = c.db.prepare("SELECT * FROM website_analyses WHERE id = ? AND workspace_id = ?").get(id, wsId) as AnalysisRow | undefined;
  if (!r) throw notFound("Website analysis");
  return r;
}

function failStale(c: AppContext, r: AnalysisRow): AnalysisRow {
  if (r.status === "running" && c.now().getTime() - Date.parse(r.created_at) > STALE_RUNNING_MS) {
    const msg = "The analysis did not finish (the app may have been restarted). Please start it again.";
    c.db.prepare("UPDATE website_analyses SET status = 'failed', error_code = 'interrupted', error_message = ?, step = 'Stopped' WHERE id = ?").run(msg, r.id);
    return { ...r, status: "failed", error_code: "interrupted", error_message: msg, step: "Stopped" };
  }
  return r;
}

export function analysisView(c: AppContext, wsId: string, id: string, cached = false): AnalysisView {
  const r = failStale(c, rowOf(c, wsId, id));
  const insights = (c.db.prepare("SELECT * FROM website_insights WHERE analysis_id = ? ORDER BY position").all(id) as InsightDbRow[]).map(insightView);
  const usage = parse<{ inputTokens?: number | null; outputTokens?: number | null; costMicros?: number | null; costStatus?: string; currency?: string } | null>(r.usage, null);
  return {
    id: r.id, url: r.url, site: r.site, status: r.status, step: r.step,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? "The analysis failed." } : null,
    robots: r.robots, pages: parse(r.pages, []), notes: parse(r.notes, []), mode: r.analysis_mode, provider: r.provider, model: r.model,
    usage: usage ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, costMicros: usage.costMicros ?? null, costStatus: usage.costStatus ?? "unknown_no_usage", currency: usage.currency ?? c.ai.currency } : null,
    createdAt: r.created_at, completedAt: r.completed_at, cached,
    canRetryAi: r.status === "failed" && !!r.page_text && r.error_code !== "interrupted" && !["robots_disallow", "blocked_by_site", "homepage_failed"].includes(r.error_code ?? ""),
    insights,
  };
}

function insightView(r: InsightDbRow): InsightView {
  const flags = parse<string[]>(r.flags, []);
  return {
    id: r.id, category: r.category, label: CATEGORY_LABEL[r.category] ?? r.category, text: r.text, originalText: r.original_text, basis: r.basis,
    evidence: parse(r.evidence, []), flags, flagNotes: flags.map((f) => FLAG_TEXT[f]).filter(Boolean) as string[], status: r.status, edited: r.edited === 1, decidedAt: r.decided_at,
  };
}

export function latestWebsiteAnalysis(c: AppContext, wsId: string): AnalysisView | null {
  const r = c.db.prepare("SELECT id FROM website_analyses WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(wsId) as { id: string } | undefined;
  return r ? analysisView(c, wsId, r.id) : null;
}

/* --------------------------------------------------------------------- start */

export interface StartResult { analysis: AnalysisView; started: boolean; cached: boolean; done: Promise<void> }

/**
 * Validates the address, then either returns a recent analysis of the same site or starts a new one in the background. Returns at once.
 * Reading the same site again needs `refresh`, and is limited (one at a time, a minimum gap, a daily cap per workspace).
 */
export function startWebsiteAnalysis(c: AppContext, wsId: string, urlInput: string, actor: string, opts: { refresh?: boolean } = {}): StartResult {
  let url: URL;
  try { url = parseWebsiteUrl(urlInput); } catch (e) {
    if (e instanceof UnsafeUrlError) throw new AppError(400, `url_${e.problem}`, e.message);
    throw e;
  }
  const site = url.hostname.toLowerCase().replace(/^www\./, "");
  const now = c.now().getTime();

  const running = c.db.prepare("SELECT id, created_at FROM website_analyses WHERE workspace_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1").get(wsId) as { id: string; created_at: string } | undefined;
  if (running && now - Date.parse(running.created_at) <= STALE_RUNNING_MS) {
    return { analysis: analysisView(c, wsId, running.id), started: false, cached: false, done: Promise.resolve() };
  }

  const recent = c.db.prepare("SELECT id, created_at, completed_at FROM website_analyses WHERE workspace_id = ? AND site = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1").get(wsId, site) as { id: string; created_at: string; completed_at: string | null } | undefined;
  if (recent) {
    const age = now - Date.parse(recent.completed_at ?? recent.created_at);
    if (!opts.refresh && age < CACHE_MS) return { analysis: analysisView(c, wsId, recent.id, true), started: false, cached: true, done: Promise.resolve() };
    if (opts.refresh && age < REFRESH_MIN_GAP_MS) throw new AppError(429, "refresh_too_soon", "This website was just analyzed. Please wait a minute before analyzing it again.");
  }
  const since = new Date(now - 24 * 60 * 60_000).toISOString();
  const count = (c.db.prepare("SELECT COUNT(*) n FROM website_analyses WHERE workspace_id = ? AND created_at >= ?").get(wsId, since) as { n: number }).n;
  if (count >= c.web.maxAnalysesPerDay) throw new AppError(429, "daily_limit", `The daily limit of ${c.web.maxAnalysesPerDay} website analyses was reached. Try again tomorrow or describe your business manually.`);

  const id = newId("wsa");
  c.db.prepare(
    "INSERT INTO website_analyses (id, workspace_id, url, site, status, step, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, wsId, url.href, site, "running", "Starting", iso(c), actor);
  audit(c, wsId, actor, "website.analysis_started", "website_analysis", id, { site });
  const done = runAnalysis(c, wsId, id, actor).catch(() => { /* recorded on the row */ });
  return { analysis: analysisView(c, wsId, id), started: true, cached: false, done };
}

/** Re-runs ONLY the AI step on the pages already read (after an AI failure such as a spending limit). The site is not fetched again. */
export function retryWebsiteAnalysisAi(c: AppContext, wsId: string, id: string, actor: string): StartResult {
  const r = rowOf(c, wsId, id);
  if (r.status !== "failed" || !r.page_text) throw new AppError(409, "not_retryable", "This analysis cannot be retried without reading the website again.");
  c.db.prepare("UPDATE website_analyses SET status = 'running', step = 'Analyzing what was found', error_code = NULL, error_message = NULL WHERE id = ?").run(id);
  const done = runAnalysis(c, wsId, id, actor, true).catch(() => { /* recorded on the row */ });
  return { analysis: analysisView(c, wsId, id), started: true, cached: false, done };
}

/* ------------------------------------------------------------------ the work */

const step = (c: AppContext, id: string, text: string) => c.db.prepare("UPDATE website_analyses SET step = ? WHERE id = ?").run(text.slice(0, 200), id);

function fail(c: AppContext, wsId: string, id: string, code: string, message: string): void {
  c.db.prepare("UPDATE website_analyses SET status = 'failed', error_code = ?, error_message = ?, step = 'Stopped', completed_at = ? WHERE id = ?").run(code, message.slice(0, 400), iso(c), id);
  audit(c, wsId, "system", "website.analysis_failed", "website_analysis", id, { code });
}

export function friendlyAiError(e: unknown): { code: string; message: string } {
  if (e instanceof AiError) {
    switch (e.kind) {
      case "auth": return { code: "ai_auth", message: "The AI provider did not accept the key stored on the server. Check the server's OpenAI key setting (the key is never shown here)." };
      case "insufficient_balance": return { code: "ai_balance", message: "The AI provider reports the account has no remaining credit. Nothing was analyzed." };
      case "rate_limit": return { code: "ai_rate_limit", message: "The AI provider is busy right now. Wait a minute and try the AI step again." };
      case "timeout": return { code: "ai_timeout", message: "The AI took too long to answer. Try the AI step again." };
      case "invalid_output": return { code: "ai_invalid_output", message: "The AI did not return a usable answer. Try the AI step again, or fill in your business details manually." };
      default: return { code: `ai_${e.kind}`, message: e.message.slice(0, 300) };
    }
  }
  return { code: "ai_failed", message: "The AI step failed unexpectedly. Your website was read; you can try the AI step again." };
}

async function runAnalysis(c: AppContext, wsId: string, id: string, actor: string, reuse = false): Promise<void> {
  try {
    let pages: PageText[];
    let flagged: Map<string, boolean>;
    if (reuse) {
      const r = rowOf(c, wsId, id);
      const stored = parse<Array<{ url: string; text: string; looksLikeInstructions?: boolean }>>(r.page_text, []);
      pages = stored.map((p) => ({ url: p.url, text: p.text }));
      flagged = new Map(stored.map((p) => [p.url, !!p.looksLikeInstructions]));
    } else {
      const row = rowOf(c, wsId, id);
      let crawl: CrawlResult;
      try {
        crawl = await crawlSite(row.url, c.web.crawl, c.web.fetchDeps, (m) => step(c, id, m));
      } catch (e) {
        if (e instanceof CrawlRefused) return fail(c, wsId, id, e.code, e.message);
        if (e instanceof UnsafeUrlError) return fail(c, wsId, id, `url_${e.problem}`, e.message);
        return fail(c, wsId, id, "read_failed", "The website could not be read. You can describe your business manually instead.");
      }
      const readPages = crawl.pages.filter((p) => p.status === "read" && p.text.trim());
      pages = readPages.map((p) => ({ url: p.url, text: [p.title ? `Title: ${p.title}` : "", p.description ? `Description: ${p.description}` : "", p.text].filter(Boolean).join("\n") }));
      flagged = new Map(readPages.map((p) => [p.url, p.looksLikeInstructions]));
      c.db.prepare("UPDATE website_analyses SET robots = ?, pages = ?, notes = ?, page_text = ? WHERE id = ?").run(
        crawl.robots,
        JSON.stringify(crawl.pages.map((p) => ({ url: p.url, title: p.title, status: p.status, reason: p.reason, chars: p.chars, looksLikeInstructions: p.looksLikeInstructions }))),
        JSON.stringify(crawl.notes),
        JSON.stringify(readPages.map((p, i) => ({ url: p.url, text: (pages[i] as PageText).text, looksLikeInstructions: p.looksLikeInstructions }))),
        id,
      );
      if (!pages.length) return fail(c, wsId, id, "no_text", "The website was reached but no readable text was found on it (it may be built so that it needs JavaScript). You can describe your business manually instead.");
      // An unchanged site is not analysed again: the earlier findings, and the owner's decisions on them, are carried over and no AI request is made.
      const hash = createHash("sha256").update(JSON.stringify(pages.map((p) => [p.url, p.text]))).digest("hex");
      c.db.prepare("UPDATE website_analyses SET content_hash = ? WHERE id = ?").run(hash, id);
      const wantMode = c.integrations.aiMode === "mock" ? "simulated" : "ai";
      const prev = c.db.prepare("SELECT id, completed_at, analysis_mode, provider, model, usage FROM website_analyses WHERE workspace_id = ? AND site = ? AND status = 'ready' AND content_hash = ? AND analysis_mode = ? AND id != ? ORDER BY created_at DESC LIMIT 1")
        .get(wsId, row.site, hash, wantMode, id) as { id: string; completed_at: string | null; analysis_mode: string; provider: string | null; model: string | null; usage: string | null } | undefined;
      if (prev) {
        const keep = c.db.prepare("SELECT * FROM website_insights WHERE analysis_id = ? ORDER BY position").all(prev.id) as InsightDbRow[];
        const ins = c.db.prepare("INSERT INTO website_insights (id, analysis_id, workspace_id, position, category, text, original_text, basis, evidence, flags, status, edited, decided_at, decided_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        c.db.transaction(() => {
          for (const k of keep) ins.run(newId("ins"), id, wsId, k.position, k.category, k.text, k.original_text, k.basis, k.evidence, k.flags, k.status, k.edited, k.decided_at, k.decided_by);
          const notes = parse<string[]>(rowOf(c, wsId, id).notes, []);
          notes.push(`The website has not changed since ${(prev.completed_at ?? "").slice(0, 10) || "the last analysis"}, so the earlier findings (and your decisions on them) were reused and no AI request was made.`);
          c.db.prepare("UPDATE website_analyses SET status = 'ready', step = 'Done', analysis_mode = ?, provider = ?, model = ?, task_id = NULL, usage = NULL, completed_at = ?, notes = ? WHERE id = ?")
            .run(prev.analysis_mode, prev.provider, prev.model, iso(c), JSON.stringify(notes), id);
        })();
        audit(c, wsId, actor, "website.analysis_reused", "website_analysis", id, { from: prev.id });
        return;
      }
    }

    step(c, id, "Analyzing what was found");
    let mode: "simulated" | "ai";
    let provider: string | null = null, model: string | null = null, taskId: string | null = null;
    let usage: Record<string, unknown> | null = null;
    let raw;
    if (c.integrations.aiMode === "mock") {
      // Mock mode: no AI provider is involved. The deterministic extractor reads only what the pages literally say.
      mode = "simulated"; provider = "mock"; model = "mock-deterministic-1";
      raw = simulatedInsights(pages);
      taskId = newId("aitask");
    } else {
      const res = await runAiTask(c, wsId, {
        taskType: "website_analysis", system: SYSTEM_PROMPT, prompt: buildPrompt(pages), schemaHint: SCHEMA_HINT, jsonSchema: ANALYSIS_JSON_SCHEMA,
        context: { pages: pages.map((p) => p.url) }, schema: AnalysisOutputSchema, maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      });
      mode = "ai"; provider = res.provider; model = res.model; taskId = res.taskId;
      usage = { inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null, costMicros: res.estimatedCostMicros, costStatus: res.costStatus, currency: c.ai.currency };
      raw = (res.structuredOutput as { insights: never[] }).insights;
    }

    const verified = verifyInsights(raw, pages.map((p) => ({ url: p.url, text: p.text, looksLikeInstructions: flagged.get(p.url) ?? false })));
    const tx = c.db.transaction(() => {
      c.db.prepare("DELETE FROM website_insights WHERE analysis_id = ?").run(id);
      const ins = c.db.prepare("INSERT INTO website_insights (id, analysis_id, workspace_id, position, category, text, original_text, basis, evidence, flags) VALUES (?,?,?,?,?,?,?,?,?,?)");
      verified.forEach((v, i) => ins.run(newId("ins"), id, wsId, i, v.category, v.text, v.text, v.basis, JSON.stringify(v.evidence), JSON.stringify(v.flags)));
      c.db.prepare("UPDATE website_analyses SET status = 'ready', step = 'Done', analysis_mode = ?, provider = ?, model = ?, task_id = ?, usage = ?, completed_at = ?, error_code = NULL, error_message = NULL WHERE id = ?")
        .run(mode, provider, model, taskId, usage ? JSON.stringify(usage) : null, iso(c), id);
    });
    tx();
    audit(c, wsId, actor, "website.analysis_ready", "website_analysis", id, { mode, provider, model, insights: verified.length });
  } catch (e) {
    const f = friendlyAiError(e);
    fail(c, wsId, id, f.code, f.message);
  }
}

/* ------------------------------------------------------------ owner decisions */

export type InsightAction = "approve" | "reject" | "reset" | "edit";

export function decideInsight(c: AppContext, wsId: string, analysisId: string, insightId: string, action: InsightAction, text: string | undefined, actor: string): InsightView {
  rowOf(c, wsId, analysisId);
  const r = c.db.prepare("SELECT * FROM website_insights WHERE id = ? AND analysis_id = ? AND workspace_id = ?").get(insightId, analysisId, wsId) as InsightDbRow | undefined;
  if (!r) throw notFound("Finding");
  const at = iso(c);
  if (action === "edit") {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 300) throw new AppError(400, "validation", "A finding must be between 2 and 300 characters.");
    // An edit is the owner's own statement: it is approved by the act of saving it, and no longer claims to come from the site as written.
    c.db.prepare("UPDATE website_insights SET text = ?, edited = 1, status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?").run(t, at, actor, insightId);
  } else {
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "proposed";
    c.db.prepare("UPDATE website_insights SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(status, status === "proposed" ? null : at, status === "proposed" ? null : actor, insightId);
  }
  audit(c, wsId, actor, "website.insight_decided", "website_insight", insightId, { action, category: r.category });
  return insightView(c.db.prepare("SELECT * FROM website_insights WHERE id = ?").get(insightId) as InsightDbRow);
}

/**
 * Approves every proposed finding that is stated on the site and carries no warning, plus the suggested tone (a style hint, not a claim).
 * Claims need the owner's own confirmation: with `includeClaims` (a separate, explicitly worded button) findings whose ONLY warning is "this is a
 * claim" are approved too. Findings with any other warning, other interpretations and open questions always stay for the owner.
 */
export function approveSafeInsights(c: AppContext, wsId: string, analysisId: string, actor: string, opts: { includeClaims?: boolean } = {}): number {
  rowOf(c, wsId, analysisId);
  const rows = c.db.prepare("SELECT id, category, basis, flags, evidence FROM website_insights WHERE analysis_id = ? AND workspace_id = ? AND status = 'proposed' AND basis IN ('found_on_site','ai_interpretation')").all(analysisId, wsId) as Array<{ id: string; category: string; basis: string; flags: string; evidence: string }>;
  const ok = rows.filter((r) => {
    const flags = parse<string[]>(r.flags, []);
    const hasEvidence = parse<unknown[]>(r.evidence, []).length > 0;
    // interpretations: the suggested tone (needs a quote) and the model's reading of the customer and their need. They fill form fields the owner still reviews and saves.
    if (r.basis === "ai_interpretation") return flags.length === 0 && ((r.category === "tone" && hasEvidence) || r.category === "target_customer" || r.category === "customer_problem");
    return hasEvidence && (flags.length === 0 || (!!opts.includeClaims && flags.every((f) => f === "risky_claim")));
  });
  const at = iso(c);
  const upd = c.db.prepare("UPDATE website_insights SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?");
  c.db.transaction(() => ok.forEach((r) => upd.run(at, actor, r.id)))();
  audit(c, wsId, actor, "website.insights_approved_bulk", "website_analysis", analysisId, { count: ok.length });
  return ok.length;
}

/** The owner-approved findings as a proposed update to the Business Brain. Nothing is saved: the owner reviews it in the form and saves. */
export function brainPatchFor(c: AppContext, wsId: string, analysisId: string): BrainPatch & { approvedCount: number } {
  const r = rowOf(c, wsId, analysisId);
  const approved = (c.db.prepare("SELECT * FROM website_insights WHERE analysis_id = ? AND workspace_id = ? AND status = 'approved' ORDER BY position").all(analysisId, wsId) as InsightDbRow[]).map(insightView);
  const existing = getBrain(c, wsId)?.brain ?? null;
  return { ...buildBrainPatch(approved, existing, r.site), approvedCount: approved.length };
}
