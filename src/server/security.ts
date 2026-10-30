import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Browser and deployment boundary: security headers on EVERY response, Host validation on every request, Origin validation on
 * state-changing requests.
 *
 * What is (and is not) true of this server today:
 *   - Authentication is a Bearer header set by the page's JavaScript. There are no cookies, so classic CSRF does not apply; Origin
 *     validation here is defense in depth, and Host validation is what stops DNS rebinding against the loopback listener.
 *   - It listens on 127.0.0.1 only and speaks plain HTTP. TLS is terminated by something in front of it, which is a deployment
 *     decision. Fastify's trustProxy stays OFF and nothing here reads X-Forwarded-* or Forwarded: those headers are client-controlled
 *     unless a proxy overwrites them, and the policy must not depend on them.
 *   - Origin is never authentication. Authentication and authorization run after these checks and are still mandatory.
 */
export interface SecurityConfig {
  /** Exact origins the application is served from (scheme://host[:port]), e.g. https://app.example.com. Empty: loopback only. */
  publicOrigins: string[];
  /** Strict-Transport-Security max-age in seconds; 0 = never sent. Only sent for requests whose Host is an https public origin. */
  hstsMaxAgeSec: number;
}
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = { publicOrigins: [], hstsMaxAgeSec: 0 };

interface ParsedOrigin {
  origin: string;
  scheme: "http:" | "https:";
  host: string;
  /** Port as the browser would write it: null for the scheme's default. */
  port: string | null;
}

const DEFAULT_PORT = { "http:": "80", "https:": "443" } as const;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STATE_CHANGING: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HOST_RE = /^(\[::1\]|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::([0-9]{1,5}))?$/;

/** The content policy for the UI and the API. The UI loads one module script, one stylesheet and its self-hosted fonts from this origin and talks only to this origin. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/** Error text names variables only, never values. */
export function loadSecurityConfig(env: Record<string, string | undefined>): SecurityConfig {
  const problems: string[] = [];
  const publicOrigins: string[] = [];
  const raw = env.PUBLIC_ORIGINS?.trim();
  if (raw) {
    for (const part of raw.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const parsed = parseOrigin(entry);
      if (!parsed || parsed.origin !== entry.toLowerCase()) {
        problems.push("PUBLIC_ORIGINS: each entry must be an exact origin such as https://app.example.com (no path, query, credentials or trailing slash)");
        break;
      }
      if (parsed.scheme === "http:" && !LOOPBACK_HOSTS.has(parsed.host)) {
        problems.push("PUBLIC_ORIGINS: a non-local origin must use https");
        break;
      }
      if (!publicOrigins.includes(parsed.origin)) publicOrigins.push(parsed.origin);
    }
    if (publicOrigins.length > 20) problems.push("PUBLIC_ORIGINS: at most 20 entries");
  }
  let hstsMaxAgeSec = 0;
  const hsts = env.HSTS_MAX_AGE_SEC?.trim();
  if (hsts) {
    const n = Number(hsts);
    if (!/^\d+$/.test(hsts) || !Number.isSafeInteger(n) || n > 63_072_000) problems.push("HSTS_MAX_AGE_SEC: integer from 0 to 63072000");
    else hstsMaxAgeSec = n;
    if (hstsMaxAgeSec > 0 && !publicOrigins.some((o) => o.startsWith("https://"))) problems.push("HSTS_MAX_AGE_SEC: needs an https origin in PUBLIC_ORIGINS (only then is TLS asserted)");
  }
  if (problems.length) throw new Error(`Invalid configuration (${problems.join("; ")})`);
  return { publicOrigins, hstsMaxAgeSec };
}

function parseOrigin(value: string): ParsedOrigin | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || u.pathname !== "/" || !u.hostname) return null;
  const host = u.hostname.toLowerCase();
  // The URL parser accepts characters (such as "*") that can never appear in a real Host header: refuse them here, so a wildcard-looking
  // entry is a configuration error rather than a silent no-op.
  if (!/^(\[::1\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(host)) return null;
  return { origin: u.origin.toLowerCase(), scheme: u.protocol, host, port: u.port === "" ? null : u.port };
}

/** A Host header as (hostname, port), or null when it is not a plain host[:port]. No userinfo, paths, spaces or trailing dots. */
function parseHostHeader(value: string | undefined): { host: string; port: string | null } | null {
  if (typeof value !== "string") return null;
  const m = HOST_RE.exec(value.toLowerCase());
  if (!m) return null;
  const port = m[2] ?? null;
  if (port !== null && Number(port) > 65535) return null;
  return { host: m[1]!, port };
}

const effectivePort = (scheme: "http:" | "https:", port: string | null): string => port ?? DEFAULT_PORT[scheme];

export function registerSecurity(app: FastifyInstance, config: SecurityConfig = DEFAULT_SECURITY_CONFIG): void {
  const publicOrigins = config.publicOrigins.map((o) => parseOrigin(o)!).filter(Boolean);
  const originSet = new Set(publicOrigins.map((o) => o.origin));

  /** Is this the name (and port) of a place the application is served from? Loopback names on any port, plus the configured public origins. */
  const hostAllowed = (h: { host: string; port: string | null }): boolean =>
    LOOPBACK_HOSTS.has(h.host) || publicOrigins.some((o) => o.host === h.host && effectivePort(o.scheme, h.port) === effectivePort(o.scheme, o.port));

  const refuse = (reply: FastifyReply, code: string, message: string) => reply.status(403).send({ error: { code, message } });

  // Host first (every request), then Origin (state-changing requests), both before authentication. Responses are fixed text: nothing
  // from the request is ever echoed back.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const host = parseHostHeader(req.headers.host);
    if (!host || !hostAllowed(host)) return refuse(reply, "host_not_allowed", "This host is not allowed");

    if (!STATE_CHANGING.has(req.method)) return;
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return refuse(reply, "origin_not_allowed", "This origin is not allowed");
    const origin = req.headers.origin;
    if (origin === undefined) return; // not a browser (or a same-origin request old browsers do not label): authentication decides
    if (typeof origin !== "string") return refuse(reply, "origin_not_allowed", "This origin is not allowed");
    const o = parseOrigin(origin);
    // "null" (sandboxed frames, file pages), garbage, paths and uppercase variants all fail to round-trip.
    if (!o || o.origin !== origin) return refuse(reply, "origin_not_allowed", "This origin is not allowed");
    if (originSet.has(o.origin)) return;
    // A local page may call this server only from the SAME local address and port it was served from: another program on this
    // machine (a different port) or another name for the same machine is a different origin.
    if (o.scheme === "http:" && LOOPBACK_HOSTS.has(o.host) && LOOPBACK_HOSTS.has(host.host) && o.host === host.host && effectivePort("http:", o.port) === effectivePort("http:", host.port)) return;
    return refuse(reply, "origin_not_allowed", "This origin is not allowed");
  });

  // Headers on every response: static files, API answers, 404s, refusals and errors. A route that sets one itself keeps its value.
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const set = (name: string, value: string) => {
      if (!reply.hasHeader(name)) reply.header(name, value);
    };
    set("content-security-policy", CONTENT_SECURITY_POLICY);
    set("x-content-type-options", "nosniff");
    set("referrer-policy", "no-referrer");
    set("cross-origin-opener-policy", "same-origin");
    set("cross-origin-resource-policy", "same-origin");
    // HSTS is a promise about HTTPS, which this process cannot see. It is sent only when the operator asserted TLS (https public origin
    // plus HSTS_MAX_AGE_SEC) AND the request arrived for that origin's host: never for loopback, never from a forwarded header.
    if (config.hstsMaxAgeSec > 0) {
      const host = parseHostHeader(req.headers.host);
      if (host && publicOrigins.some((o) => o.scheme === "https:" && o.host === host.host && effectivePort(o.scheme, host.port) === effectivePort(o.scheme, o.port))) {
        set("strict-transport-security", `max-age=${config.hstsMaxAgeSec}`);
      }
    }
    return payload;
  });
}
