import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthRuntime } from "../auth/config.js";
import { authzAllows, legacyTokenActor, routeKey, ROUTE_PERMISSIONS, userActor, type AuthzContext, type Permission } from "../auth/authz.js";
import { ORG_ROUTE_PERMISSIONS, orgRoleAllows, type OrgRole } from "../auth/orgAuthz.js";
import { AuthError, type Identity, type Principal } from "../auth/types.js";
import type { AppContext } from "../app/context.js";
import { activeMembership } from "../app/memberships.js";
import { activeOrgMembership, customRolePermissions } from "../app/organizations.js";
import { findUser, upsertUser } from "../app/users.js";
import { authenticate } from "../app/workspaces.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is calling, once authenticated (a verified person, or the legacy workspace token). Derived on the server. */
    principal: Principal | null;
    /** For workspace routes: the verified workspace, the caller's CURRENT role in it, and the actor to record. */
    authz: AuthzContext | null;
    /** For organization routes: the verified organization and the caller's CURRENT organization role. Only ever a signed-in person. */
    orgAuthz: { organizationId: string; role: OrgRole; actor: { kind: "user"; userId: string; label: string } } | null;
  }
  interface FastifyInstance {
    /** Every registered route, so tests can prove each non-public one demands credentials and a permission. */
    routeTable: Array<{ method: string; url: string }>;
  }
}

/**
 * The ONLY routes reachable without credentials. Everything else under /api/ is denied by default, including routes added later.
 * POST /api/workspaces is public only while no identity provider is configured (workspace_token mode), because the token it
 * returns is then the only way in. With AUTH_MODE=oidc it needs a signed-in person, who becomes the owner.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/health", "HEAD /api/health",
  "GET /api/config", "HEAD /api/config",
  "POST /api/workspaces",
]);

/** Routes for a signed-in PERSON that are not inside one workspace. */
export const USER_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/me",
  "GET /api/me/workspaces",
  "GET /api/me/organizations",
  "POST /api/organizations", // a signed-in person starts an agency organization
  "POST /api/workspaces/claim",
  "POST /api/workspaces", // in oidc mode
]);

const body = (code: string, message: string) => ({ error: { code, message } });
const MAX_CREDENTIAL = 8192;

/** Accepts exactly `Bearer <token>`. Anything else (other schemes, extra words, empty) is treated as no usable credential. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(header);
  return m && m[1]!.length <= MAX_CREDENTIAL ? m[1]! : null;
}

const WORKSPACE_TOKEN_PREFIX = "msw_";
const looksLikeJwt = (t: string) => t.split(".").length === 3;

function reject(reply: FastifyReply, invalid: boolean) {
  return reply
    .header("www-authenticate", invalid ? 'Bearer error="invalid_token"' : "Bearer")
    .status(401)
    .send(body("unauthorized", "Missing or invalid credentials"));
}
const notFound = (reply: FastifyReply, what: string) => reply.status(404).send(body("not_found", `${what} not found`));

/**
 * Registers authentication AND authorization. It runs in `onRequest`, so a request that fails is refused BEFORE its body is read.
 *
 * Status policy (the same everywhere):
 *   401  no credentials, or credentials that do not verify
 *   404  authenticated, but not an active member of that workspace (identical to a workspace that does not exist), or a resource
 *        that is not in the workspace named in the URL (decided by the services, which scope every query to that workspace)
 *   403  an active member whose CURRENT role does not allow this operation, or a workspace route with no declared permission
 *   503  the identity provider's keys could not be obtained (never a pass)
 *
 * Workspace routes accept two kinds of caller:
 *   a signed-in person (OIDC)  -> must hold an active membership; the role is read from the database on every request
 *   the legacy workspace token -> an 'admin'-equivalent principal, never a user, never an owner; only while not disabled
 */
export function registerAuth(
  app: FastifyInstance,
  ctx: AppContext,
  runtime: AuthRuntime,
  hooks: { /** Called when an IDENTIFIED caller is refused for lack of permission. Must never throw into the request. */ denied?: (req: FastifyRequest, authz: AuthzContext, permission: Permission) => void } = {},
): void {
  app.decorateRequest("principal", null);
  app.decorateRequest("authz", null);
  app.decorateRequest("orgAuthz", null);
  const routes: Array<{ method: string; url: string }> = [];
  app.decorate("routeTable", routes);
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) routes.push({ method: m, url: r.url });
  });

  /** Verify a person's token. Returns the identity, or sends the failure response and returns null. */
  async function verifyPerson(token: string, reply: FastifyReply): Promise<Identity | null> {
    try {
      return await runtime.verifier!.verify(token);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e; // a bug must surface as a 500, not look like a bad token
      if (e.reason === "keys_unavailable") reply.status(503).send(body("auth_unavailable", "Sign-in is temporarily unavailable"));
      else reject(reply, true);
      return null;
    }
  }

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return; // static assets only
    const pattern = req.routeOptions?.url ?? "";
    if (pattern === "" || pattern === "/*") return notFound(reply, "Resource"); // nothing under /api/ is a static file
    const key = routeKey(req.method, pattern);
    const publicKey = `${req.method} ${pattern}`;

    // Workspace creation is open only without an identity provider.
    if (PUBLIC_ROUTES.has(publicKey) && !(key === "POST /api/workspaces" && runtime.mode === "oidc")) return;

    const wid = (req.params as { wid?: string } | undefined)?.wid;
    const oid = (req.params as { oid?: string } | undefined)?.oid;
    const isUserRoute = USER_ROUTES.has(key);
    if (!wid && !oid && !isUserRoute) return reject(reply, false); // default deny

    if ((isUserRoute || oid) && !runtime.verifier) return notFound(reply, "Resource"); // no identity provider: person-level and organization routes do not exist

    const token = bearerToken(req.headers.authorization);
    if (!token) return reject(reply, req.headers.authorization !== undefined);

    // ---- person-level routes ----
    if (!wid) {
      if (token.startsWith(WORKSPACE_TOKEN_PREFIX) || !looksLikeJwt(token)) return reject(reply, true); // a workspace token is not a person
      const identity = await verifyPerson(token, reply);
      if (!identity) return;
      // Closed pilot: only an authorized identity is provisioned. Someone who already has a user row (invited by an owner after being
      // authorized) keeps working, but is not updated. Anyone else is refused and nothing is written.
      const user = runtime.policy.canRegister(identity) ? upsertUser(ctx, identity) : findUser(ctx, identity);
      if (!user) return reply.status(403).send(body("not_authorized", "This account is not authorized to use this service"));
      req.principal = { kind: "user", userId: user.id, identity, label: userActor(user.id).label };
      if (oid) {
        // ---- organization routes: a signed-in person with an ACTIVE organization membership, judged by their CURRENT organization role ----
        const om = activeOrgMembership(ctx, user.id, oid);
        if (!om) return notFound(reply, "Organization"); // same answer as an organization that does not exist
        const orgPermission = ORG_ROUTE_PERMISSIONS[key];
        if (!orgPermission || !orgRoleAllows(om.role, orgPermission)) return reply.status(403).send(body("forbidden", "Your role does not allow this"));
        req.orgAuthz = { organizationId: om.organizationId, role: om.role, actor: { kind: "user", userId: user.id, label: userActor(user.id).label } };
      }
      return;
    }

    // ---- workspace routes ----
    let authz: AuthzContext;
    if (token.startsWith(WORKSPACE_TOKEN_PREFIX)) {
      if (!authenticate(ctx, wid, token)) return reject(reply, true); // wrong token, unknown workspace, or token disabled: one answer
      const actor = legacyTokenActor(wid);
      req.principal = { kind: "workspace_token", workspaceId: wid, label: actor.label };
      authz = { workspaceId: wid, role: "admin", actor };
    } else if (runtime.verifier && looksLikeJwt(token)) {
      const identity = await verifyPerson(token, reply);
      if (!identity) return;
      // READ-ONLY until authorization passes: a verified identity that is not a member must not create or touch any record.
      // (A member necessarily has a user row, because membership references it; people are provisioned at /api/me, claim and create.)
      const user = findUser(ctx, identity);
      const m = user ? activeMembership(ctx, user.id, wid) : null;
      if (!user || !m) return notFound(reply, "Workspace"); // same answer as a workspace that does not exist
      req.principal = { kind: "user", userId: user.id, identity, label: userActor(user.id).label };
      authz = { workspaceId: m.workspaceId, role: m.role, actor: userActor(user.id) };
      if (m.customRoleId) {
        // a custom role replaces the built-in set; one that no longer exists or was archived grants nothing at all (never more)
        authz.customPermissions = customRolePermissions(ctx, m.customRoleId) ?? new Set<Permission>();
        authz.customRoleId = m.customRoleId;
      }
    } else {
      return reject(reply, true);
    }

    const permission = ROUTE_PERMISSIONS[key];
    if (!permission || !authzAllows(authz, permission)) {
      if (permission) {
        try {
          hooks.denied?.(req, authz, permission);
        } catch {
          /* recording a refusal must never change the refusal */
        }
      }
      return reply.status(403).send(body("forbidden", "Your role does not allow this"));
    }
    req.authz = authz;
  });
}
