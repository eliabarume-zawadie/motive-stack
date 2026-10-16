import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { AiError } from "../ai/types.js";
import { connectionTest, getAiSettings, listModels, listUsage, putAiSettings, usageSummary } from "../app/aiService.js";
import { generateCampaign, listCampaigns, updateBrief } from "../app/campaigns.js";
import type { AppContext } from "../app/context.js";
import { AppError } from "../app/errors.js";
import { ingestLeadEvent } from "../app/leads.js";
import { createProposal, decideProposal, getProposalRow } from "../app/proposals.js";
import { activityView, campaignView, jobsView, leadsView, proposalView, workspaceView } from "../app/views.js";
import { authenticate, createWorkspace, getBrain, putBrain, setMetaAccount } from "../app/workspaces.js";
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

/** The web client talks only to this API. It never receives provider credentials. */
export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

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
    live: { meta: ctx.integrations.liveMeta, ai: ctx.integrations.liveAi, ghl: ctx.integrations.liveGhl },
    ai: { mode: ctx.integrations.aiMode, liveCallsAllowed: ctx.integrations.allowLiveProviderCalls, live: ctx.integrations.liveAi, local: ctx.integrations.localAi, currency: ctx.ai.currency },
    simulated: { meta: !ctx.integrations.liveMeta, crm: true, ai: ctx.integrations.aiMode === "mock" },
    providers: ctx.ai.list(),
  }));

  app.post("/api/workspaces", async (req, reply) => {
    const { name } = WorkspaceCreateSchema.parse(req.body);
    const { workspace, token } = createWorkspace(ctx, name);
    return reply.status(201).send({ workspace, token }); // token is shown exactly once
  });

  // ---- workspace-scoped routes: Bearer token must belong to :wid ----
  app.register(async (ws) => {
    ws.addHook("preHandler", async (req, reply) => {
      const wid = (req.params as { wid: string }).wid;
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
      if (!authenticate(ctx, wid, token)) return reply.status(401).send(errorBody("unauthorized", "Missing or invalid workspace token"));
    });

    const wid = (req: FastifyRequest) => (req.params as { wid: string }).wid;
    const p = <T extends string>(req: FastifyRequest, k: T) => (req.params as Record<T, string>)[k];

    ws.get("/", async (req) => workspaceView(ctx, wid(req)));
    ws.patch("/", async (req) => {
      const { metaAccountId } = WorkspaceUpdateSchema.parse(req.body);
      setMetaAccount(ctx, wid(req), metaAccountId);
      return workspaceView(ctx, wid(req));
    });

    ws.get("/brain", async (req) => getBrain(ctx, wid(req)) ?? { brain: null, version: 0 });
    ws.put("/brain", async (req) => putBrain(ctx, wid(req), req.body));

    ws.get("/campaigns", async (req) => listCampaigns(ctx, wid(req)));
    ws.post("/campaigns/generate", async (req, reply) => {
      const body = GenerateRequestSchema.parse(req.body ?? {});
      const rec = await generateCampaign(ctx, wid(req), body);
      return reply.status(201).send(campaignView(ctx, wid(req), rec.id));
    });
    ws.get("/campaigns/:cid", async (req) => campaignView(ctx, wid(req), p(req, "cid")));
    ws.put("/campaigns/:cid/brief", async (req) => {
      updateBrief(ctx, wid(req), p(req, "cid"), req.body);
      return campaignView(ctx, wid(req), p(req, "cid"));
    });
    ws.post("/campaigns/:cid/proposals", async (req, reply) => {
      const row = createProposal(ctx, wid(req), p(req, "cid"));
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
        return proposalView(ctx, wid(req), decideProposal(ctx, wid(req), p(req, "pid"), decision, body));
      });
    }

    // ---- AI configuration, usage and explicit connection test ----
    ws.get("/ai/settings", async (req) => ({ settings: getAiSettings(ctx, wid(req)), models: listModels(ctx, wid(req)) }));
    ws.put("/ai/settings", async (req) => ({ settings: putAiSettings(ctx, wid(req), req.body), models: listModels(ctx, wid(req)) }));
    ws.get("/ai/usage", async (req) => ({ summary: usageSummary(ctx, wid(req)), recent: listUsage(ctx, wid(req), 25) }));
    ws.post("/ai/connection-test", async (req) => {
      const body = ConnectionTestSchema.parse(req.body);
      return connectionTest(ctx, wid(req), body.provider, body.model);
    });

    ws.get("/leads", async (req) => leadsView(ctx, wid(req)));
    ws.get("/activity", async (req) => activityView(ctx, wid(req)));
    ws.get("/jobs", async (req) => jobsView(ctx, wid(req)));
  }, { prefix: "/api/workspaces/:wid" });

  app.register(fastifyStatic, { root: PUBLIC_DIR });
  return app;
}
