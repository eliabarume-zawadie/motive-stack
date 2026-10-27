import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { AiError } from "../ai/types.js";
import { aiProviderStatus, connectionTest, getAiSettings, listModels, listUsage, putAiSettings, runTestRequest, usageSummary } from "../app/aiService.js";
import { analysisView, approveSafeInsights, brainPatchFor, decideInsight, latestWebsiteAnalysis, retryWebsiteAnalysisAi, startWebsiteAnalysis } from "../app/websiteAnalysis.js";
import { generateCampaign, listCampaigns, updateBrief } from "../app/campaigns.js";
import { dashboardView } from "../app/dashboard.js";
import type { AppContext } from "../app/context.js";
import { AppError } from "../app/errors.js";
import { ingestLeadEvent } from "../app/leads.js";
import { createProposal, decideProposal, getProposalRow } from "../app/proposals.js";
import { activityView, campaignView, jobsView, leadsView, proposalView, workspaceView } from "../app/views.js";
import { addMember, changeRole, claimWorkspace, createWorkspaceForUser, disableLegacyToken, listMembers, listUserWorkspaces, removeMember } from "../app/memberships.js";
import { createWorkspace, getBrain, putBrain } from "../app/workspaces.js";
import type { AuthzContext } from "../auth/authz.js";
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
    try {
      done(null, JSON.parse(body));
    } catch {
      done(Object.assign(new Error("Malformed JSON"), { statusCode: 400, code: "invalid_json" }), undefined);
    }
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
    const fe = err as { statusCode?: number; code?: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.status(fe.statusCode).send(errorBody(fe.code ?? "bad_request", "Bad request"));
    return reply.status(500).send(errorBody("internal", "Internal error")); // never echo internals or secrets
  });

  // ---- public routes ----
  app.get("/api/health", async () => ({ ok: true }));

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

    ws.get("/", async (req) => workspaceView(ctx, wid(req)));
    ws.patch("/", async (req) => {
      const { metaAccountId } = WorkspaceUpdateSchema.parse(req.body);
      selectMetaAccount(ctx, wid(req), metaAccountId, az(req).actor); // live: only an account this workspace is authorized for
      return workspaceView(ctx, wid(req));
    });

    ws.get("/brain", async (req) => getBrain(ctx, wid(req)) ?? { brain: null, version: 0 });
    ws.put("/brain", async (req) => putBrain(ctx, wid(req), req.body, az(req).actor.label));

    ws.get("/campaigns", async (req) => listCampaigns(ctx, wid(req)));
    ws.post("/campaigns/generate", async (req, reply) => {
      const body = GenerateRequestSchema.parse(req.body ?? {});
      const rec = await generateCampaign(ctx, wid(req), body);
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
      const { role } = MemberRoleSchema.parse(req.body);
      changeRole(ctx, az(req).actor, wid(req), p(req, "uid"), role);
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

    ws.get("/leads", async (req) => leadsView(ctx, wid(req)));
    ws.get("/activity", async (req) => activityView(ctx, wid(req)));
    ws.get("/jobs", async (req) => jobsView(ctx, wid(req)));
    // One read-only summary for the UI's dashboard, campaign list, operations and integrations views. Jobs inside it are included only for
    // roles that may read /jobs; everything else is what workspace.read already allows.
    ws.get("/dashboard", async (req) => dashboardView(ctx, wid(req), az(req).role));
  }, { prefix: "/api/workspaces/:wid" });

  app.register(fastifyStatic, { root: PUBLIC_DIR });
  return app;
}
