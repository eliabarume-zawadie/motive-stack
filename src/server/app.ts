import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { AiError } from "../ai/types.js";
import { brainProvenance, reconcileLedger } from "../app/provenance.js";
import { aiProviderStatus, connectionTest, getAiSettings, listModels, listUsage, putAiSettings, runTestRequest, usageSummary } from "../app/aiService.js";
import { analysisView, approveSafeInsights, brainPatchFor, decideInsight, latestWebsiteAnalysis, recordFillApplied, retryWebsiteAnalysisAi, startWebsiteAnalysis } from "../app/websiteAnalysis.js";
import { splitPlan } from "../app/campaignPlan.js";
import { generateCampaign, listCampaigns, updateBrief } from "../app/campaigns.js";
import { dashboardView } from "../app/dashboard.js";
import type { AppContext } from "../app/context.js";
import { AppError } from "../app/errors.js";
import { ingestLeadEvent, leadDetail, setLeadStatus } from "../app/leads.js";
import { retryDeadJob } from "../app/jobs.js";
import { createProposal, decideProposal, requestExecution, getProposalRow } from "../app/proposals.js";
import { activityView, campaignView, jobsView, leadsView, proposalView, workspaceView } from "../app/views.js";
import { addMember, assignMemberRole, claimWorkspace, createWorkspaceForUser, disableLegacyToken, listMembers, listUserWorkspaces, removeMember } from "../app/memberships.js";
import { createWorkspace, getBrain, putBrain } from "../app/workspaces.js";
import { AccessGrantSchema, OrgMemberAddSchema, OrgMemberRoleSchema, OrgNameSchema, PermissionPreviewSchema, addOrgMember, archiveRoleTemplate, changeOrgRole, createAgencyOrganization, createClientWorkspace, createRoleTemplate, describePermissions, getOrganization, grantWorkspaceAccess, listOrgMembers, listOrgWorkspaces, listRoleTemplates, listUserOrganizations, orgAuditView, removeOrgMember, updateRoleTemplate, validatePermissionList } from "../app/organizations.js";
import { getPolicy, setPolicy } from "../app/workspacePolicy.js";
import { applyAllocations, archivePlan, generatePlanDrafts, listPlans, planView, recommendPlan, regenerateOpportunity, reviewPlanBudget, updateOpportunity, updatePlan } from "../app/plans.js";
import { archiveCampaign, completeCampaign, LIFECYCLE_LABEL } from "../app/lifecycle.js";
import { budgetPosition } from "../app/budgetCommitments.js";
import { brandKitVersions, brandKitView, decideBrandKit, saveBrandKit, submitBrandKit } from "../app/brandKit.js";
import { archiveCreative, attachImportedVariant, cancelRender, checkCreative, createCreative, creativeDetail, decideCreative, listCampaignCreatives, readVariantFile, requestRenders, retryRender, reviseCreative, submitCreative, suggestConcepts } from "../app/creatives.js";
import { readdirSync } from "node:fs";
import { eraseLead, exportWorkspace } from "../app/privacy.js";
import { usageView } from "../app/quotas.js";
import { integrationsView, leadCrmDryRun, proposalDryRun, runSimulatedTest } from "../app/integrations.js";
import { abandonExperiment, concludeExperiment, createExperiment, experimentAnalysis, experimentView, listExperiments, recordObservation, recordUsage, replaceDraftPlan, startExperiment } from "../app/experiments.js";
import { createLearning, decideLearning, decideRecommendation, listLearnings, recommendations, suggestLearnings } from "../app/learnings.js";
import { createForm, formDetail, importLeads, listForms, listImportBatches, reviseForm, setFollowUp, testSubmit } from "../app/leadIntake.js";
import { analyticsView } from "../app/analytics.js";
import { assignees, calendar, createWorkItem, inbox, listNotifications, listWorkItems, markNotificationsRead, ownershipOf, ownerSubject, setOwnership, updateWorkItem } from "../app/teamOps.js";
import { VIDEO_SUPPORT } from "../creative/video.js";
import { bodyShapeProblem } from "./bodyShape.js";
import { addAssetVersion, archiveAsset, assetBodyLimit, assetDetail, createAsset, decideAssetVersion, listAssets, readAssetFile, submitAssetVersion } from "../app/assets.js";
import { CUSTOMIZABLE_PERMISSIONS, PERMISSION_CATALOG } from "../auth/orgAuthz.js";
import { authzAllows, permissionsFor, type AuthzContext } from "../auth/authz.js";
import { ClaimSchema, CredentialPutSchema, EmptyBodySchema, MemberAddSchema, MemberRoleSchema, MetaAccountSchema } from "../auth/schemas.js";
import { CREDENTIAL_KINDS, type CredentialKind, type WriteResult } from "../credentials/vault.js";
import { audit } from "../app/core.js";
import { DEFAULT_API_RATE_LIMITS, DEFAULT_CLAIM_RATE_LIMITS, DEFAULT_CREDENTIAL_RATE_LIMITS, RateLimiter, type ApiRateLimits, type ClaimRateLimits, type CredentialRateLimits } from "./rateLimit.js";
import { DEFAULT_SECURITY_CONFIG, registerSecurity, type SecurityConfig } from "./security.js";
import { authorizeMetaAccount, disableMetaAccount, listMetaAccounts, parseAccountId, revokeMetaAccount, selectMetaAccount } from "../app/metaAccounts.js";
import { workspaceTokenRuntime, type AuthRuntime } from "../auth/config.js";
import { registerAuth } from "./auth.js";
import {
  ConnectionTestSchema,
  DecisionSchema,
  GenerateRequestSchema,
  SimulatedLeadSchema,
  WorkspaceCreateSchema,
  WorkspaceUpdateSchema,
} from "../domain/schemas.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

const errorBody = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });

const userActorOf = (p: { userId: string; label: string }) => ({ kind: "user" as const, userId: p.userId, label: p.label });

/** The web client talks only to this API. It never receives provider credentials. */
/** Largest body the credential write routes accept. A secret is at most 4096 characters; this leaves room for JSON and a label. */
const CREDENTIAL_BODY_LIMIT = 8 * 1024;

const MIGRATION_FILE_COUNT = readdirSync(fileURLToPath(new URL("../db/migrations/", import.meta.url))).filter((f) => f.endsWith(".sql")).length;

export function buildServer(ctx: AppContext, auth: AuthRuntime = workspaceTokenRuntime, extra: { rateLimits?: CredentialRateLimits; claimLimits?: ClaimRateLimits; apiLimits?: ApiRateLimits; security?: SecurityConfig; now?: () => number; /** Tests: a limiter with a small table. */ limiter?: RateLimiter } = {}): FastifyInstance {
  // logger is OFF: request bodies (which carry secrets on the credential routes) are never written to a log.
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const limits = extra.rateLimits ?? DEFAULT_CREDENTIAL_RATE_LIMITS;
  const limiter = extra.limiter ?? new RateLimiter(extra.now);
  const windowMs = limits.windowSec * 1000;
  const credentialOp = (method: string) => (method === "PUT" ? "store" : method === "POST" ? "revoke" : method === "DELETE" ? "delete" : null);
  const knownKind = (v: unknown): v is CredentialKind => typeof v === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(v);
  // Browser and deployment boundary FIRST: Host and Origin are checked, and security headers are added to every response, before anything
  // else (authentication included) runs. Hooks run in registration order.
  registerSecurity(app, extra.security ?? DEFAULT_SECURITY_CONFIG);
  registerAuth(app, ctx, auth, {
    // An identified person was refused a credential write: record WHO and WHAT (never the body). Throttled so a refused caller cannot flood the audit trail.
    denied: (req, authz, permission) => {
      const op = permission === "credentials.manage" ? credentialOp(req.method) : null;
      if (!op || !limiter.hit(`denied|${authz.workspaceId}|${authz.actor.label}`, limits.deniedAuditMax, windowMs).allowed) return;
      const kind = (req.params as { kind?: string }).kind;
      audit(ctx, authz.workspaceId, authz.actor.label, "credential.denied", "credential", knownKind(kind) ? kind : "-", { operation: op, reason: authz.actor.kind === "user" ? "role" : "person_only" });
    },
  }); // before any route, so its onRoute hook sees them all and its onRequest hook guards them all
  // General volume limit per VERIFIED person. It runs after authentication, so it only ever sees an identity the server has verified:
  // an unauthenticated caller creates no entry and cannot spend anyone's quota (volume before authentication is a job for the proxy in
  // front of this process; see docs/browser-deployment-security.md). Credential and claim limits are separate counters and unchanged.
  const apiLimits = extra.apiLimits ?? DEFAULT_API_RATE_LIMITS;
  app.addHook("onRequest", async (req, reply) => {
    const who = req.principal?.label;
    if (!who) return; // public routes, static files, unknown paths: not counted
    const r = limiter.hit(`api|${who}`, apiLimits.apiMax, apiLimits.apiWindowSec * 1000);
    if (!r.allowed) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
      throw new AppError(429, "rate_limited", "Too many requests; try again later"); // the same fixed wording as the other limits
    }
  });
  // Everything under /credentials, including refusals and unknown sub-paths, must never be stored by a browser or a shared cache.
  app.addHook("onSend", async (req, reply, payload) => {
    // Match on the matched route AND the requested path: an unknown sub-path falls through to the static-file wildcard route.
    if ((req.routeOptions?.url ?? "").includes("/credentials") || (req.url.split("?")[0] ?? "").includes("/credentials")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Fastify rejects an empty body that is labelled JSON. Many clients do exactly that for "no options" requests,
  // so treat it as "no body" and let each route's schema decide whether a body is required.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return done(Object.assign(new Error("Malformed JSON"), { statusCode: 400, code: "invalid_json" }), undefined);
    }
    // Order of events for a request: onRequest hooks (sign-in, rate limits, role checks: an unauthenticated caller is refused here and its body is never parsed), then this parser,
    // then validation inside the route. Checking the shape here, once for every JSON route, means an oversized or over-nested body is refused before any zod schema or business code
    // sees it. Only JSON bodies reach this parser (uploads are base64 inside JSON, not multipart; text/plain reaches a route only as a plain string, which no list schema accepts; every other
    // content type is refused with 415), and Fastify enforces each route's bodyLimit before the body gets here.
    if (bodyShapeProblem(parsed)) return done(new AppError(400, "body_too_complex", "The request has too many items in a list or is nested too deeply"), undefined);
    done(null, parsed);
  });

  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send(errorBody(err.code, err.message));
    if (err instanceof ZodError) {
      return reply.status(400).send(errorBody("validation", "Invalid input", { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }));
    }
    if (err instanceof AiError) {
      // Provider-side failures are 5xx/429 for the caller; our own configuration/policy refusals are 4xx.
      const status: Record<string, number> = {
        provider_unavailable: 503, invalid_output: 502, auth: 502, insufficient_balance: 502, timeout: 504, rate_limit: 429,
        budget_exhausted: 429, budget_unverifiable: 409, live_disabled: 409, not_eligible: 409, cancelled: 499,
      };
      return reply.status(status[err.kind] ?? 400).send(errorBody(err.kind, err.message, err.requestId ? { requestId: err.requestId } : {}));
    }
    if (typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code.startsWith("SQLITE_BUSY")) return reply.status(503).send(errorBody("busy", "The workspace is being changed by another request; try again in a moment"));
    const fe = err as { statusCode?: number; code?: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.status(fe.statusCode).send(errorBody(fe.code ?? "bad_request", "Bad request"));
    return reply.status(500).send(errorBody("internal", "Internal error")); // never echo internals or secrets
  });

  // ---- public routes ----
  app.get("/api/health", async () => ({ ok: true }));
  // Readiness for a load balancer or monitor: can this process reach its database and is it fully migrated? It says yes or no and which check failed, nothing more.
  app.get("/api/health/ready", async (_req, reply) => {
    const checks = { database: false, migrations: false };
    try { ctx.db.prepare("SELECT 1").get(); checks.database = true; const n = (ctx.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get() as { n: number }).n; checks.migrations = n === MIGRATION_FILE_COUNT; } catch { /* a failed check stays false */ }
    const ok = checks.database && checks.migrations;
    return reply.status(ok ? 200 : 503).header("cache-control", "no-store").send({ ok, checks });
  });

  // Mode flags only: no keys, no key presence, nothing a browser could use to reach a provider.
  app.get("/api/config", async () => ({
    mode: ctx.integrations.mode,
    auth: auth.publicConfig,
    live: { meta: ctx.integrations.liveMeta, ai: ctx.integrations.liveAi, ghl: ctx.integrations.liveGhl },
    ai: { mode: ctx.integrations.aiMode, liveCallsAllowed: ctx.integrations.allowLiveProviderCalls, live: ctx.integrations.liveAi, local: ctx.integrations.localAi, currency: ctx.ai.currency },
    simulated: { meta: !ctx.integrations.liveMeta, crm: true, ai: ctx.integrations.aiMode === "mock" },
    providers: ctx.ai.list(),
  }));

  app.post("/api/workspaces", async (req, reply) => {
    const { name } = WorkspaceCreateSchema.parse(req.body);
    // Signed in (AUTH_MODE=oidc): the person becomes the owner and no workspace token exists. Otherwise (no identity provider): the
    // legacy path, where the token returned here, once, is the only way in.
    const p = req.principal;
    if (p?.kind === "user") {
      if (!auth.policy.canRegister(p.identity)) throw new AppError(403, "not_authorized", "This account is not authorized to create workspaces");
      return reply.status(201).send({ workspace: createWorkspaceForUser(ctx, userActorOf(p), name) });
    }
    const { workspace, token } = createWorkspace(ctx, name);
    return reply.status(201).send({ workspace, token }); // token is shown exactly once
  });

  // ---- a signed-in person's own workspaces, and the bootstrap for workspaces that predate memberships ----
  app.get("/api/me/workspaces", async (req) => {
    const p = req.principal;
    if (p?.kind !== "user") throw new AppError(401, "unauthorized", "Missing or invalid credentials");
    return { workspaces: listUserWorkspaces(ctx, p.userId) };
  });
  app.post("/api/workspaces/claim", async (req, reply) => {
    const p = req.principal;
    if (p?.kind !== "user") throw new AppError(401, "unauthorized", "Missing or invalid credentials");
    const { workspaceId, token } = ClaimSchema.parse(req.body);
    // Possession of a legacy token is not enough to become an owner (owners manage credentials). Claiming is for explicitly listed
    // identities only, and this is decided BEFORE the token is looked at, so a refused identity learns nothing about any token.
    if (!auth.policy.canClaim(p.identity)) throw new AppError(403, "claim_not_permitted", "This account may not claim a workspace");
    // Only identities that passed the check above use up quota, and each person has their own (no one can spend another's).
    const claimLimit = extra.claimLimits ?? DEFAULT_CLAIM_RATE_LIMITS;
    const attempt = limiter.hit(`claim|${p.userId}`, claimLimit.claimMax, claimLimit.claimWindowSec * 1000);
    if (!attempt.allowed) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1000))));
      throw new AppError(429, "rate_limited", "Too many requests; try again later"); // same wording as the credential routes; nothing about the token or workspace
    }
    return reply.status(200).send({ workspace: claimWorkspace(ctx, userActorOf(p), workspaceId, token), role: "owner" });
  });

  // ---- the signed-in person (only when AUTH_MODE=oidc; authenticated by the hook in ./auth.ts) ----
  app.get("/api/me", async (req) => {
    const p = req.principal;
    if (p?.kind !== "user") throw new AppError(401, "unauthorized", "Missing or invalid credentials");
    return { user: { id: p.userId, email: p.identity.email, displayName: p.identity.displayName } };
  });

  // ---- workspace-scoped routes: authenticated by the onRequest hook in ./auth.ts (the Bearer token must belong to :wid) ----
  app.register(async (ws) => {
    // The workspace id every handler uses is the one the hook VERIFIED for this caller, never the raw URL value.
    const az = (req: FastifyRequest): AuthzContext => {
      if (!req.authz) throw new AppError(401, "unauthorized", "Missing or invalid credentials"); // unreachable: the hook sets it or refuses
      return req.authz;
    };
    const wid = (req: FastifyRequest) => az(req).workspaceId;
    const p = <T extends string>(req: FastifyRequest, k: T) => (req.params as Record<T, string>)[k];

    ws.get("/", async (req) => {
      const a = az(req);
      // the role and the permissions it grants, derived on the server, so the screen can say "you may not do this" instead of showing a button that fails
      return { ...workspaceView(ctx, wid(req)), role: a.role, permissions: permissionsFor(a.role, a.actor.kind, a.customPermissions), customRoleId: a.customRoleId ?? null };
    });
    ws.patch("/", async (req) => {
      const { metaAccountId } = WorkspaceUpdateSchema.parse(req.body);
      selectMetaAccount(ctx, wid(req), metaAccountId, az(req).actor); // live: only an account this workspace is authorized for
      return workspaceView(ctx, wid(req));
    });

    ws.get("/brain", async (req) => getBrain(ctx, wid(req)) ?? { brain: null, version: 0 });
    ws.put("/brain", async (req) => {
      const saved = putBrain(ctx, wid(req), req.body, az(req).actor.label);
      reconcileLedger(ctx, wid(req)); // what is recorded as coming from a website now matches what is really saved
      // Lowering the daily limit below what is already committed is allowed, but it is flagged, audited and blocks new approvals until the commitments fit again.
      const pos = budgetPosition(ctx, wid(req));
      if (pos.overLimitCents > 0) audit(ctx, wid(req), az(req).actor.label, "budget.over_limit", "workspace", wid(req), { ceilingCents: pos.ceilingCents, committedCents: pos.committedCents, overLimitCents: pos.overLimitCents });
      return { ...saved, budget: { ceilingCents: pos.ceilingCents, committedCents: pos.committedCents, availableCents: pos.availableCents, overLimitCents: pos.overLimitCents } };
    });
    ws.get("/brain/provenance", async (req) => brainProvenance(ctx, wid(req)));

    ws.get("/campaigns", async (req) => listCampaigns(ctx, wid(req)));
    ws.post("/campaigns/generate", async (req, reply) => {
      const { rest, plan } = splitPlan(req.body ?? {});
      const body = GenerateRequestSchema.parse(rest);
      const rec = await generateCampaign(ctx, wid(req), body, undefined, plan);
      return reply.status(201).send(campaignView(ctx, wid(req), rec.id));
    });
    ws.get("/campaigns/:cid", async (req) => campaignView(ctx, wid(req), p(req, "cid")));
    ws.put("/campaigns/:cid/brief", async (req) => {
      updateBrief(ctx, wid(req), p(req, "cid"), req.body, az(req).actor.label);
      return campaignView(ctx, wid(req), p(req, "cid"));
    });
    ws.post("/campaigns/:cid/proposals", async (req, reply) => {
      const row = createProposal(ctx, wid(req), p(req, "cid"), az(req).actor.label);
      return reply.status(201).send(proposalView(ctx, wid(req), row));
    });
    ws.post("/campaigns/:cid/simulate-lead", async (req, reply) => {
      const input = SimulatedLeadSchema.parse(req.body);
      return reply.status(202).send(ingestLeadEvent(ctx, wid(req), p(req, "cid"), input));
    });

    ws.get("/proposals/:pid", async (req) => proposalView(ctx, wid(req), getProposalRow(ctx, wid(req), p(req, "pid"))));
    for (const decision of ["approve", "reject"] as const) {
      ws.post(`/proposals/:pid/${decision}`, async (req) => {
        const body = DecisionSchema.parse(req.body);
        // Attribution is the server-derived actor. The name in the body is kept only as an unverified label.
        const actor = az(req).actor;
        const approver = actor.kind === "user" ? ({ kind: "user", userId: actor.userId } as const) : ({ kind: "legacy_token" } as const);
        const by = { decidedBy: actor.label, approver, claimedLabel: body.decidedBy, reason: body.reason, acknowledgedReview: body.acknowledgedReview };
        return proposalView(ctx, wid(req), decideProposal(ctx, wid(req), p(req, "pid"), decision, by));
      });
    }

    // Running an approved action is its own step with its own permission: approving never runs anything.
    ws.post("/proposals/:pid/execute", async (req) => proposalView(ctx, wid(req), requestExecution(ctx, wid(req), p(req, "pid"), az(req).actor.label)));
    ws.get("/policy", async (req) => getPolicy(ctx, wid(req)));

    // ---- Marketing plans: groups of SEPARATE campaigns sharing one daily budget. A plan is never approved as a whole; each campaign keeps its own proposal and approval ----
    ws.get("/plans", async (req) => listPlans(ctx, wid(req), (req.query as { archived?: string } | undefined)?.archived === "true"));
    ws.post("/plans/recommend", async (req, reply) => reply.status(201).send(recommendPlan(ctx, wid(req), az(req).actor.label, req.body)));
    ws.get("/plans/:plid", async (req) => planView(ctx, wid(req), p(req, "plid")));
    ws.patch("/plans/:plid", async (req) => updatePlan(ctx, wid(req), az(req).actor.label, p(req, "plid"), req.body));
    ws.patch("/plans/:plid/opportunities/:opid", async (req) => updateOpportunity(ctx, wid(req), az(req).actor.label, p(req, "plid"), p(req, "opid"), req.body));
    ws.post("/plans/:plid/generate", async (req) => generatePlanDrafts(ctx, wid(req), az(req).actor.label, p(req, "plid"), req.body));
    ws.post("/plans/:plid/opportunities/:opid/regenerate", async (req) => regenerateOpportunity(ctx, wid(req), az(req).actor.label, p(req, "plid"), p(req, "opid"), req.body));
    ws.post("/plans/:plid/apply-allocations", async (req) => applyAllocations(ctx, wid(req), az(req).actor.label, p(req, "plid")));
    ws.post("/plans/:plid/budget-review", async (req) => reviewPlanBudget(ctx, wid(req), p(req, "plid"), req.body, approverOf(req)));
    ws.post("/plans/:plid/archive", async (req) => archivePlan(ctx, wid(req), az(req).actor.label, p(req, "plid")));
    ws.post("/campaigns/:cid/archive", async (req) => { const s = archiveCampaign(ctx, wid(req), p(req, "cid"), az(req).actor.label); return { lifecycle: { state: s, label: LIFECYCLE_LABEL[s] } }; });
    ws.post("/campaigns/:cid/complete", async (req) => { const s = completeCampaign(ctx, wid(req), p(req, "cid"), az(req).actor.label); return { lifecycle: { state: s, label: LIFECYCLE_LABEL[s] } }; });

    // ---- Brand Kit: preferences, never business facts. Versioned; approval is bound to one version ----
    const approverOf = (req: FastifyRequest) => { const a = az(req).actor; return { decidedBy: a.label, approver: a.kind === "user" ? ({ kind: "user", userId: a.userId } as const) : ({ kind: "legacy_token" } as const) }; };
    ws.get("/brand-kit", async (req) => brandKitView(ctx, wid(req)));
    ws.put("/brand-kit", async (req) => saveBrandKit(ctx, wid(req), az(req).actor.label, req.body));
    ws.post("/brand-kit/submit", async (req) => submitBrandKit(ctx, wid(req), az(req).actor.label));
    ws.post("/brand-kit/approve", async (req) => decideBrandKit(ctx, wid(req), "approve", req.body, approverOf(req)));
    ws.post("/brand-kit/reject", async (req) => decideBrandKit(ctx, wid(req), "reject", req.body, approverOf(req)));
    ws.get("/brand-kit/versions", async (req) => ({ versions: brandKitVersions(ctx, wid(req)) }));

    // ---- Asset library: metadata in the database, bytes behind the AssetStore. Uploads are JSON (base64) so no extra dependency is needed ----
    const assetDeps = { c: ctx, store: ctx.assetStore, limits: ctx.assetLimits };
    const upload = { bodyLimit: assetBodyLimit(ctx.assetLimits) };
    ws.get("/assets", async (req) => listAssets(ctx, wid(req), (req.query as { archived?: string } | undefined)?.archived === "true"));
    ws.post("/assets", upload, async (req, reply) => reply.status(201).send(await createAsset(assetDeps, wid(req), az(req).actor.label, req.body)));
    ws.get("/assets/:aid", async (req) => assetDetail(ctx, wid(req), p(req, "aid")));
    ws.post("/assets/:aid/versions", upload, async (req, reply) => reply.status(201).send(await addAssetVersion(assetDeps, wid(req), p(req, "aid"), az(req).actor.label, req.body)));
    const ver = (req: FastifyRequest) => { const v = Number(p(req, "v")); if (!Number.isInteger(v) || v < 1) throw new AppError(404, "not_found", "Asset version not found"); return v; };
    ws.get("/assets/:aid/versions/:v/file", async (req, reply) => {
      const f = await readAssetFile(assetDeps, wid(req), p(req, "aid"), ver(req));
      // The type comes from the file's own bytes (checked at upload). A sandboxed, script-free policy and nosniff mean even a hostile file could not run anything.
      return reply.header("content-type", f.mime).header("content-disposition", `inline; filename="asset.${f.ext}"`).header("x-content-type-options", "nosniff").header("cache-control", "private, no-store").header("content-security-policy", "default-src 'none'; sandbox").send(f.bytes);
    });
    ws.post("/assets/:aid/versions/:v/submit", async (req) => submitAssetVersion(ctx, wid(req), p(req, "aid"), ver(req), az(req).actor.label));
    ws.post("/assets/:aid/versions/:v/approve", async (req) => decideAssetVersion(ctx, wid(req), p(req, "aid"), ver(req), "approve", req.body, approverOf(req)));
    ws.post("/assets/:aid/versions/:v/reject", async (req) => decideAssetVersion(ctx, wid(req), p(req, "aid"), ver(req), "reject", req.body, approverOf(req)));
    ws.post("/assets/:aid/archive", async (req) => archiveAsset(ctx, wid(req), p(req, "aid"), az(req).actor.label));

    // ---- Creative Studio (images; mock provider only). Pictures are persisted render jobs; nothing is complete until its bytes are validated and stored ----
    ws.get("/creative/providers", async () => ({ image: [ctx.imageProvider.capabilities], video: VIDEO_SUPPORT, limits: ctx.creativeLimits }));
    ws.get("/campaigns/:cid/creative-concepts", async (req) => suggestConcepts(ctx, wid(req), p(req, "cid")));
    ws.get("/campaigns/:cid/creatives", async (req) => listCampaignCreatives(ctx, wid(req), p(req, "cid")));
    ws.post("/campaigns/:cid/creatives", async (req, reply) => reply.status(201).send(createCreative(ctx, wid(req), az(req).actor.label, p(req, "cid"), req.body)));
    ws.get("/creatives/:crid", async (req) => creativeDetail(ctx, wid(req), p(req, "crid")));
    ws.post("/creatives/:crid/versions", async (req, reply) => reply.status(201).send(reviseCreative(ctx, wid(req), az(req).actor.label, p(req, "crid"), req.body)));
    ws.post("/creatives/:crid/archive", async (req) => archiveCreative(ctx, wid(req), az(req).actor.label, p(req, "crid")));
    ws.post("/creatives/:crid/versions/:v/renders", async (req, reply) => reply.status(202).send(requestRenders(ctx, wid(req), az(req).actor.label, p(req, "crid"), ver(req), req.body)));
    ws.post("/creatives/:crid/versions/:v/images", async (req) => attachImportedVariant(ctx, wid(req), az(req).actor.label, p(req, "crid"), ver(req), req.body));
    ws.post("/creatives/:crid/versions/:v/check", async (req) => checkCreative(ctx, wid(req), p(req, "crid"), ver(req)));
    ws.post("/creatives/:crid/versions/:v/submit", async (req) => submitCreative(ctx, wid(req), az(req).actor.label, p(req, "crid"), ver(req)));
    ws.post("/creatives/:crid/versions/:v/approve", async (req) => decideCreative(ctx, wid(req), p(req, "crid"), ver(req), "approve", req.body, approverOf(req)));
    ws.post("/creatives/:crid/versions/:v/reject", async (req) => decideCreative(ctx, wid(req), p(req, "crid"), ver(req), "reject", req.body, approverOf(req)));
    ws.get("/creatives/:crid/versions/:v/pictures/:ratio/file", async (req, reply) => {
      const f = await readVariantFile(ctx, wid(req), p(req, "crid"), ver(req), p(req, "ratio"));
      return reply.header("content-type", f.mime).header("content-disposition", `inline; filename="creative.${f.ext}"`).header("x-content-type-options", "nosniff").header("cache-control", "private, no-store").header("content-security-policy", "default-src 'none'; sandbox").send(f.bytes);
    });
    ws.post("/renders/:rid/cancel", async (req) => cancelRender(ctx, wid(req), az(req).actor.label, p(req, "rid")));
    ws.post("/renders/:rid/retry", async (req) => retryRender(ctx, wid(req), az(req).actor.label, p(req, "rid")));

    // ---- Team operations: inbox, calendar, tasks, owners and reviewers, in-app notifications (nothing is sent outside the app) ----
    const me = (req: FastifyRequest): string | null => { const a = az(req).actor; return a.kind === "user" ? a.userId : null; };
    ws.get("/inbox", async (req) => inbox(ctx, wid(req), { userId: me(req), can: (perm) => authzAllows(az(req), perm) }));
    ws.get("/calendar", async (req) => { const q = (req.query ?? {}) as { from?: string; to?: string }; return calendar(ctx, wid(req), q.from, q.to); });
    ws.get("/assignees", async (req) => assignees(ctx, wid(req)));
    ws.get("/work-items", async (req) => listWorkItems(ctx, wid(req), (req.query as { status?: string } | undefined)?.status));
    ws.post("/work-items", async (req, reply) => reply.status(201).send(createWorkItem(ctx, wid(req), az(req).actor.label, req.body)));
    ws.patch("/work-items/:wiid", async (req) => updateWorkItem(ctx, wid(req), az(req).actor.label, p(req, "wiid"), req.body));
    ws.get("/ownerships/:stype/:sid", async (req) => { const t = p(req, "stype"); if (t !== "campaign" && t !== "creative") throw new AppError(404, "not_found", "Not found"); ownerSubject(ctx, wid(req), t, p(req, "sid")); return ownershipOf(ctx, wid(req), t, p(req, "sid")); });
    ws.put("/ownerships", async (req) => setOwnership(ctx, wid(req), az(req).actor.label, req.body));
    ws.get("/notifications", async (req) => listNotifications(ctx, wid(req), me(req)));
    ws.post("/notifications/read-all", async (req) => markNotificationsRead(ctx, wid(req), me(req)));
    ws.post("/notifications/:nid/read", async (req) => markNotificationsRead(ctx, wid(req), me(req), p(req, "nid")));

    // ---- Lead intake and reporting: imports (labelled IMPORTED, never sent to a CRM), follow-up reminders, form definitions (nothing published), truthful analytics ----
    ws.post("/leads/import", async (req, reply) => reply.status(201).send(importLeads(ctx, wid(req), az(req).actor.label, req.body)));
    ws.get("/lead-imports", async (req) => listImportBatches(ctx, wid(req)));
    ws.put("/leads/:lid/follow-up", async (req) => setFollowUp(ctx, wid(req), p(req, "lid"), req.body, az(req).actor.label));
    ws.get("/campaigns/:cid/forms", async (req) => listForms(ctx, wid(req), p(req, "cid")));
    ws.post("/campaigns/:cid/forms", async (req, reply) => reply.status(201).send(createForm(ctx, wid(req), az(req).actor.label, p(req, "cid"), req.body)));
    ws.get("/forms/:fid", async (req) => formDetail(ctx, wid(req), p(req, "fid")));
    ws.post("/forms/:fid/versions", async (req, reply) => reply.status(201).send(reviseForm(ctx, wid(req), az(req).actor.label, p(req, "fid"), req.body)));
    ws.post("/forms/:fid/test-submission", async (req, reply) => reply.status(201).send(testSubmit(ctx, wid(req), az(req).actor.label, p(req, "fid"), req.body)));
    ws.get("/analytics", async (req) => analyticsView(ctx, wid(req)));

    // ---- Experiments, the Marketing Brain and recommendations: records and decisions only. Nothing here changes spend, edits a campaign or publishes ----
    ws.get("/experiments", async (req) => listExperiments(ctx, wid(req)));
    ws.post("/experiments", async (req, reply) => reply.status(201).send(createExperiment(ctx, wid(req), az(req).actor.label, req.body)));
    ws.get("/experiments/:eid", async (req) => experimentView(ctx, wid(req), p(req, "eid")));
    ws.put("/experiments/:eid", async (req) => replaceDraftPlan(ctx, wid(req), az(req).actor.label, p(req, "eid"), req.body));
    ws.post("/experiments/:eid/start", async (req) => startExperiment(ctx, wid(req), az(req).actor.label, p(req, "eid")));
    ws.post("/experiments/:eid/usage", async (req) => recordUsage(ctx, wid(req), az(req).actor.label, p(req, "eid"), req.body));
    ws.post("/experiments/:eid/observations", async (req) => recordObservation(ctx, wid(req), az(req).actor.label, p(req, "eid"), req.body));
    ws.get("/experiments/:eid/analysis", async (req) => experimentAnalysis(ctx, wid(req), p(req, "eid")));
    ws.post("/experiments/:eid/conclude", async (req) => concludeExperiment(ctx, wid(req), p(req, "eid"), req.body, az(req).actor.label));
    ws.post("/experiments/:eid/abandon", async (req) => abandonExperiment(ctx, wid(req), p(req, "eid"), req.body, az(req).actor.label));
    ws.get("/learnings", async (req) => listLearnings(ctx, wid(req), (req.query as { status?: string } | undefined)?.status));
    ws.post("/learnings", async (req, reply) => reply.status(201).send(createLearning(ctx, wid(req), az(req).actor.label, req.body)));
    ws.post("/learnings/suggest", async (req) => suggestLearnings(ctx, wid(req), az(req).actor.label));
    for (const d of ["confirm", "reject", "retire"] as const) ws.post(`/learnings/:lid/${d}`, async (req) => decideLearning(ctx, wid(req), p(req, "lid"), d, req.body, approverOf(req)));
    ws.get("/recommendations", async (req) => recommendations(ctx, wid(req)));
    ws.post("/recommendations/decide", async (req) => { const b = (req.body ?? {}) as { key?: unknown; decision?: unknown; note?: unknown }; if (typeof b.key !== "string" || (b.decision !== "accept" && b.decision !== "dismiss")) throw new AppError(400, "invalid_request", "Send a key and a decision of accept or dismiss"); return decideRecommendation(ctx, wid(req), b.key, b.decision, { note: b.note }, az(req).actor.label); });

    // ---- Integrations: a read-only description, simulated self-tests of built-in stand-ins, and read-only previews. Nothing here can switch an integration on ----
    ws.get("/integrations", async (req) => integrationsView(ctx, wid(req), (auth.publicConfig as { mode?: string }).mode ?? "workspace_token"));
    ws.post("/integrations/:aid/test", async (req) => runSimulatedTest(ctx, wid(req), az(req).actor.label, p(req, "aid")));
    ws.get("/proposals/:pid/dry-run", async (req) => proposalDryRun(ctx, wid(req), p(req, "pid")));
    ws.get("/leads/:lid/crm-dry-run", async (req) => leadCrmDryRun(ctx, wid(req), p(req, "lid")));

    // ---- Privacy and operations: export (secrets removed), erase one lead's personal data, usage against limits ----
    ws.get("/export", async (req, reply) => reply.header("cache-control", "no-store").header("content-disposition", `attachment; filename="motivestack-export-${wid(req)}.json"`).send(exportWorkspace(ctx, wid(req), az(req).actor.label)));
    ws.post("/leads/:lid/erase", async (req) => eraseLead(ctx, wid(req), p(req, "lid"), req.body, az(req).actor.label));
    ws.get("/usage", async (req) => usageView(ctx, wid(req)));
    ws.put("/policy", async (req) => setPolicy(ctx, az(req).actor, wid(req), req.body));

    // ---- AI configuration, usage and explicit connection test ----
    ws.get("/ai/settings", async (req) => ({ settings: getAiSettings(ctx, wid(req)), models: listModels(ctx, wid(req)) }));
    ws.put("/ai/settings", async (req) => ({ settings: putAiSettings(ctx, wid(req), req.body, az(req).actor.label), models: listModels(ctx, wid(req)) }));
    ws.get("/ai/usage", async (req) => ({ summary: usageSummary(ctx, wid(req)), recent: listUsage(ctx, wid(req), 25) }));
    ws.post("/ai/connection-test", async (req) => {
      const body = ConnectionTestSchema.parse(req.body);
      return connectionTest(ctx, wid(req), body.provider, body.model);
    });

    // ---- stored integration credentials: MASKED STATUS ONLY (M4.4a). No route returns, accepts or deletes a secret. ----
    // The workspace is the one the hook verified for this caller. The hook has already required an admin or owner who is a signed-in
    // person (never the legacy workspace token). With no key provider the answer is the fixed safe response and says nothing about
    // keys, providers or what may be stored.
    ws.get("/credentials", async (req) => {
      const a = az(req);
      if (!ctx.credentials.available) return { available: false, credentials: [] };
      return {
        available: true,
        // An explicit allow-list of fields: key ids, ciphertext and anything else the vault knows are never part of the response.
        credentials: ctx.credentials.list(a).map((c) => ({ kind: c.kind, status: c.status, version: c.version, label: c.label, updatedAt: c.updatedAt, updatedBy: c.updatedBy })),
      };
    });

    // ---- stored integration credentials: OWNER-ONLY WRITES (M4.4b) ----
    // Authorization is the central hook's: a signed-in person who is an OWNER of the verified workspace (never the legacy token). Here:
    //  - an in-process rate limit runs BEFORE the body is read; repeated client errors lock the caller out for a while,
    //  - the query string, content type, body size and fields are strict, and no message ever repeats a request value,
    //  - changes to an existing credential need If-Match (428 missing, 412 stale); creating one when none is active does not,
    //  - responses carry masked status only, plus an ETag with the credential's version.
    const callerKey = (a: AuthzContext) => `${a.workspaceId}|${a.actor.label}`;
    const failKey = (a: AuthzContext) => `fail|${callerKey(a)}`;
    const gated = new WeakSet<object>();
    const rateGate = async (req: FastifyRequest, reply: FastifyReply) => {
      const a = az(req);
      let wait = limiter.lockedFor(failKey(a));
      let scope = "failures";
      if (!wait) {
        const c = limiter.hit(`caller|${callerKey(a)}`, limits.callerMax, windowMs);
        if (!c.allowed) [wait, scope] = [c.retryAfterMs, "caller"];
      }
      if (!wait) {
        const w = limiter.hit(`workspace|${a.workspaceId}`, limits.workspaceMax, windowMs);
        if (!w.allowed) [wait, scope] = [w.retryAfterMs, "workspace"];
      }
      if (wait) {
        if (limiter.hit(`audit-limited|${callerKey(a)}`, 1, windowMs).allowed) {
          audit(ctx, a.workspaceId, a.actor.label, "credential.rate_limited", "credential", "-", { operation: credentialOp(req.method), scope });
        }
        reply.header("retry-after", String(Math.max(1, Math.ceil(wait / 1000))));
        throw new AppError(429, "rate_limited", "Too many requests; try again later"); // the same for every scope: it says nothing about the limits
      }
      gated.add(req);
    };
    /** After the response: a client error from an admitted request counts toward the caller's lockout (including parser rejections). */
    const countFailure = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!gated.has(req) || !req.authz) return;
      if (reply.statusCode >= 400 && reply.statusCode < 500 && reply.statusCode !== 429) {
        limiter.fail(failKey(req.authz), limits.failureMax, limits.failureWindowSec * 1000, limits.lockoutSec * 1000);
      }
    };
    /**
     * Strict JSON, decided BEFORE the body is parsed. Fastify itself would also accept text/plain (as a string), so this is checked here:
     * PUT must say it is JSON; a revoke or delete that carries a body must too. Only utf-8 (or no charset) is accepted.
     */
    const JSON_TYPE = /^application\/json\s*(?:;\s*charset=("?)utf-8\1)?\s*$/i;
    const requireJson = async (req: FastifyRequest) => {
      const type = req.headers["content-type"];
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      if ((req.method === "PUT" || hasBody) && !(typeof type === "string" && JSON_TYPE.test(type))) throw new AppError(415, "unsupported_media_type", "The request body must be application/json");
    };
    const writeRoute = { bodyLimit: CREDENTIAL_BODY_LIMIT, onRequest: [rateGate, requireJson], onResponse: [countFailure] };

    const credentialView = (c: WriteResult["credential"]) => ({ kind: c.kind, status: c.status, version: c.version, label: c.label, updatedAt: c.updatedAt, updatedBy: c.updatedBy });
    const credentialBefore = (req: FastifyRequest): { kind: CredentialKind; ifMatch: number | null } => {
      if (req.url.includes("?")) throw new AppError(400, "query_not_allowed", "Query strings are not accepted on this route");
      if (!ctx.credentials.available) throw new AppError(503, "credentials_unavailable", "Credential storage is not configured on this server");
      const kind = p(req, "kind");
      if (!knownKind(kind)) throw new AppError(404, "not_found", "Credential not found");
      const header = req.headers["if-match"];
      if (header === undefined) return { kind, ifMatch: null };
      const m = typeof header === "string" ? /^(?:W\/)?"?([1-9][0-9]{0,8})"?$/.exec(header.trim()) : null;
      if (!m) throw new AppError(400, "invalid_precondition", "If-Match must be the credential's version number");
      return { kind, ifMatch: Number(m[1]) };
    };
    const credentialReply = (reply: FastifyReply, r: WriteResult) =>
      reply.header("etag", `"${r.credential.version}"`).status(r.outcome === "created" ? 201 : 200).send({ outcome: r.outcome, credential: credentialView(r.credential) });

    ws.put("/credentials/:kind", writeRoute, async (req, reply) => {
      try {
        const { kind, ifMatch } = credentialBefore(req);
        const parsed = CredentialPutSchema.safeParse(req.body);
        if (!parsed.success) throw new AppError(400, "validation", "The request body is not valid"); // never the zod issues: they can echo values
        const result = await ctx.credentials.put(az(req), { kind, secret: parsed.data.secret, label: parsed.data.label ?? null }, { enforce: true, ifMatch });
        return credentialReply(reply, result);
      } finally {
        req.body = undefined; // do not keep the secret reachable from the request object
      }
    });
    ws.post("/credentials/:kind/revoke", writeRoute, async (req, reply) => {
      try {
        const { kind, ifMatch } = credentialBefore(req);
        if (!EmptyBodySchema.safeParse(req.body ?? {}).success) throw new AppError(400, "validation", "The request body is not valid");
        return credentialReply(reply, await ctx.credentials.revoke(az(req), kind, { enforce: true, ifMatch }));
      } finally {
        req.body = undefined;
      }
    });
    ws.delete("/credentials/:kind", writeRoute, async (req, reply) => {
      try {
        const { kind, ifMatch } = credentialBefore(req);
        if (!EmptyBodySchema.safeParse(req.body ?? {}).success) throw new AppError(400, "validation", "The request body is not valid");
        return credentialReply(reply, await ctx.credentials.delete(az(req), kind, { enforce: true, ifMatch }));
      } finally {
        req.body = undefined;
      }
    });

    // ---- members and the workspace token (owner-only management; see src/auth/authz.ts) ----
    ws.get("/members", async (req) => ({ members: listMembers(ctx, wid(req)) }));
    ws.post("/members", async (req, reply) => {
      const { userId, role } = MemberAddSchema.parse(req.body);
      addMember(ctx, az(req).actor, wid(req), userId, role);
      return reply.status(201).send({ members: listMembers(ctx, wid(req)) });
    });
    ws.patch("/members/:uid", async (req) => {
      const body = MemberRoleSchema.parse(req.body);
      assignMemberRole(ctx, az(req).actor, wid(req), p(req, "uid"), { ...(body.role ? { role: body.role } : {}), ...(body.customRoleId ? { customRoleId: body.customRoleId } : {}) });
      return { members: listMembers(ctx, wid(req)) };
    });
    ws.delete("/members/:uid", async (req) => {
      removeMember(ctx, az(req).actor, wid(req), p(req, "uid"));
      return { members: listMembers(ctx, wid(req)) };
    });
    // ---- which Meta ad accounts this workspace may use (owners manage; admins may only choose among them via PATCH /) ----
    const accountParam = (req: FastifyRequest) => parseAccountId(p(req, "aid")) ?? "act_0";
    ws.get("/meta-accounts", async (req) => ({ accounts: listMetaAccounts(ctx, wid(req)) }));
    ws.post("/meta-accounts", async (req, reply) => {
      const { accountId } = MetaAccountSchema.parse(req.body);
      authorizeMetaAccount(ctx, az(req).actor, wid(req), accountId);
      return reply.status(201).send({ accounts: listMetaAccounts(ctx, wid(req)) });
    });
    ws.post("/meta-accounts/:aid/disable", async (req) => {
      disableMetaAccount(ctx, az(req).actor, wid(req), accountParam(req));
      return { accounts: listMetaAccounts(ctx, wid(req)) };
    });
    ws.delete("/meta-accounts/:aid", async (req) => {
      revokeMetaAccount(ctx, az(req).actor, wid(req), accountParam(req));
      return { accounts: listMetaAccounts(ctx, wid(req)) };
    });

    ws.post("/legacy-token/disable", async (req) => {
      disableLegacyToken(ctx, az(req).actor, wid(req));
      return { legacyTokenEnabled: false };
    });

    ws.get("/ai/status", async () => aiProviderStatus(ctx));
    ws.post("/ai/test-request", async (req) => {
      const body = z.object({ provider: z.string().min(1).max(60), model: z.string().min(1).max(100), prompt: z.string().max(2000) }).strict().parse(req.body);
      return runTestRequest(ctx, wid(req), body.provider, body.model, body.prompt);
    });

    // ---- Business Brain website analysis: reads the owner's public website (bounded, SSRF-safe) and PROPOSES findings. Nothing is confirmed until the owner approves it and saves the Business Brain.
    ws.post("/website-analyses", async (req, reply) => {
      const body = z.object({ url: z.string().max(2048), refresh: z.boolean().optional() }).strict().parse(req.body);
      const r = startWebsiteAnalysis(ctx, wid(req), body.url, az(req).actor.label, { refresh: body.refresh });
      return reply.status(r.started ? 202 : 200).send({ analysis: r.analysis, started: r.started, cached: r.cached });
    });
    ws.get("/website-analyses/latest", async (req) => ({ analysis: latestWebsiteAnalysis(ctx, wid(req)) }));
    ws.get("/website-analyses/:aid", async (req) => ({ analysis: analysisView(ctx, wid(req), p(req, "aid")) }));
    ws.post("/website-analyses/:aid/retry-ai", async (req, reply) => reply.status(202).send({ analysis: retryWebsiteAnalysisAi(ctx, wid(req), p(req, "aid"), az(req).actor.label).analysis }));
    ws.post("/website-analyses/:aid/approve-safe", async (req) => {
      const body = z.object({ includeClaims: z.boolean().optional() }).strict().parse(req.body ?? {});
      const n = approveSafeInsights(ctx, wid(req), p(req, "aid"), az(req).actor.label, { includeClaims: body.includeClaims });
      return { approved: n, analysis: analysisView(ctx, wid(req), p(req, "aid")) };
    });
    ws.post("/website-analyses/:aid/insights/:iid", async (req) => {
      const body = z.object({ action: z.enum(["approve", "reject", "reset", "edit"]), text: z.string().max(600).optional() }).strict().parse(req.body);
      return { insight: decideInsight(ctx, wid(req), p(req, "aid"), p(req, "iid"), body.action, body.text, az(req).actor.label) };
    });
    ws.get("/website-analyses/:aid/brain-patch", async (req) => brainPatchFor(ctx, wid(req), p(req, "aid")));
    ws.post("/website-analyses/:aid/applied", async (req) => {
      const item = z.object({ field: z.string().max(40), value: z.string().max(2100) }).strict();
      const body = z.object({ added: z.array(item).max(80), removed: z.array(item).max(80) }).strict().parse(req.body);
      return recordFillApplied(ctx, wid(req), p(req, "aid"), body, az(req).actor.label);
    });

    ws.get("/leads", async (req) => leadsView(ctx, wid(req)));
    ws.get("/activity", async (req) => activityView(ctx, wid(req)));
    ws.get("/jobs", async (req) => jobsView(ctx, wid(req)));
    ws.post("/jobs/:jid/retry", async (req) => retryDeadJob(ctx, wid(req), p(req, "jid"), az(req).actor.label));
    ws.get("/leads/:lid", async (req) => leadDetail(ctx, wid(req), p(req, "lid")));
    ws.put("/leads/:lid/status", async (req) => setLeadStatus(ctx, wid(req), p(req, "lid"), req.body, az(req).actor.label));
    // One read-only summary for the UI's dashboard, campaign list, operations and integrations views. Jobs inside it are included only for
    // roles that may read /jobs; everything else is what workspace.read already allows.
    ws.get("/dashboard", async (req) => dashboardView(ctx, wid(req), (p) => authzAllows(az(req), p)));
  }, { prefix: "/api/workspaces/:wid" });

  // ---- organizations (signed-in people only; with no identity provider these routes do not exist) ----
  const person = (req: FastifyRequest) => {
    const pr = req.principal;
    if (pr?.kind !== "user") throw new AppError(401, "unauthorized", "Missing or invalid credentials");
    return userActorOf(pr);
  };
  app.get("/api/me/organizations", async (req) => ({ organizations: listUserOrganizations(ctx, person(req).userId) }));
  app.post("/api/organizations", async (req, reply) => reply.status(201).send(createAgencyOrganization(ctx, person(req), OrgNameSchema.parse(req.body).name)));
  app.register(async (org) => {
    const oz = (req: FastifyRequest) => {
      if (!req.orgAuthz) throw new AppError(401, "unauthorized", "Missing or invalid credentials"); // unreachable: the hook sets it or refuses
      return req.orgAuthz;
    };
    const oid = (req: FastifyRequest) => oz(req).organizationId; // the VERIFIED organization, never the raw URL value
    const q = <T extends string>(req: FastifyRequest, k: T) => (req.params as Record<T, string>)[k];
    org.get("/", async (req) => ({ ...getOrganization(ctx, oid(req)), role: oz(req).role }));
    org.get("/workspaces", async (req) => ({ workspaces: listOrgWorkspaces(ctx, oid(req)) }));
    org.post("/workspaces", async (req, reply) => reply.status(201).send(createClientWorkspace(ctx, oz(req).actor, oid(req), OrgNameSchema.parse(req.body).name)));
    org.get("/members", async (req) => ({ members: listOrgMembers(ctx, oid(req)) }));
    org.post("/members", async (req, reply) => { const b = OrgMemberAddSchema.parse(req.body); addOrgMember(ctx, oz(req).actor, oid(req), b.userId, b.role); return reply.status(201).send({ members: listOrgMembers(ctx, oid(req)) }); });
    org.patch("/members/:uid", async (req) => { changeOrgRole(ctx, oz(req).actor, oid(req), q(req, "uid"), OrgMemberRoleSchema.parse(req.body).role); return { members: listOrgMembers(ctx, oid(req)) }; });
    org.delete("/members/:uid", async (req) => { removeOrgMember(ctx, oz(req).actor, oid(req), q(req, "uid")); return { members: listOrgMembers(ctx, oid(req)) }; });
    org.get("/permissions", async () => ({ permissions: CUSTOMIZABLE_PERMISSIONS.map((p) => ({ permission: p, ...PERMISSION_CATALOG[p] })) }));
    org.get("/role-templates", async (req) => ({ roles: listRoleTemplates(ctx, oid(req)) }));
    org.post("/role-templates", async (req, reply) => reply.status(201).send(createRoleTemplate(ctx, oz(req).actor, oid(req), req.body)));
    org.put("/role-templates/:tid", async (req) => updateRoleTemplate(ctx, oz(req).actor, oid(req), q(req, "tid"), req.body));
    org.delete("/role-templates/:tid", async (req) => { archiveRoleTemplate(ctx, oz(req).actor, oid(req), q(req, "tid")); return { roles: listRoleTemplates(ctx, oid(req)) }; });
    org.post("/role-preview", async (req) => describePermissions(validatePermissionList(PermissionPreviewSchema.parse(req.body).permissions)));
    org.post("/access-grants", async (req, reply) => reply.status(201).send(grantWorkspaceAccess(ctx, oz(req).actor, oid(req), AccessGrantSchema.parse(req.body))));
    org.get("/audit", async (req) => ({ events: orgAuditView(ctx, oid(req)) }));
  }, { prefix: "/api/organizations/:oid" });

  app.register(fastifyStatic, { root: PUBLIC_DIR });
  return app;
}
