import { randomUUID } from "node:crypto";

/**
 * Server-side error visibility: one JSON line per server error (HTTP 5xx), written to standard error, where a service manager (systemd, a PaaS) collects it.
 *
 * What a line contains: time, a request id (also returned to the caller on a 500 so a report can be matched to the line), the HTTP method, the ROUTE TEMPLATE (for example
 * /api/workspaces/:wid/brain, never the real URL, so no ids or query strings), the status, a short category, the error's class name and code, and the source location
 * (src/...:line) where it was thrown.
 *
 * What it NEVER contains: the request body, headers, tokens, credentials, the query string, the error MESSAGE (messages can echo values), or any user data. Anything that is not
 * a short plain identifier is dropped rather than escaped.
 *
 * Repeated errors: when the number of server errors inside the window reaches the threshold, ONE extra line with event "repeated_server_errors" is written (and again only after a
 * further full window), so an operator can alert on that single event instead of reading every line. Detection is in this process's memory and resets on a restart.
 */
export const DEFAULT_ALERT_THRESHOLD = 5;
export const DEFAULT_ALERT_WINDOW_MS = 5 * 60 * 1000;
const MAX_ROUTES_IN_ALERT = 5;

export interface ErrorLogOptions {
  /** Where finished lines go. Default: standard error. Tests pass their own. */
  sink?: (line: string) => void;
  now?: () => number;
  alertThreshold?: number;
  alertWindowMs?: number;
}

export interface ServerErrorInfo {
  requestId: string;
  method: string;
  /** The route template from the router, or undefined when no route matched. */
  route: string | undefined;
  status: number;
  category: string;
  error: unknown;
}

export interface ErrorLog {
  record(info: ServerErrorInfo): void;
}

/** A new request id for every request. Never taken from the client, so nobody can put text of their choosing into the log. */
export const newRequestId = (): string => `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
const ident = (v: unknown): string | undefined => (typeof v === "string" && IDENT.test(v) ? v : undefined);
const TEMPLATE = /^\/[A-Za-z0-9_\-./:*]{0,198}$/; // a path template: letters, digits and the router's own punctuation only; no query string, no spaces
const method = (v: string): string => (/^[A-Z]{3,7}$/.test(v) ? v : "?");

/** The first stack frame inside this project, reduced to "src/path/file.ts:line". Absolute paths (which carry user names) and node_modules frames are dropped. */
function location(err: unknown): string | undefined {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  for (const line of stack.split("\n").slice(1, 40)) {
    if (line.includes("node_modules") || line.includes("node:")) continue;
    const m = /[\\/]((?:src|scripts)[\\/][A-Za-z0-9_.\\/-]+):(\d+)(?::\d+)?\)?\s*$/.exec(line.trim());
    if (m) return `${m[1]!.replace(/\\/g, "/")}:${m[2]}`;
  }
  return undefined;
}

export function createErrorLog(o: ErrorLogOptions = {}): ErrorLog {
  const sink = o.sink ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const now = o.now ?? Date.now;
  const threshold = o.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
  const windowMs = o.alertWindowMs ?? DEFAULT_ALERT_WINDOW_MS;
  let recent: Array<{ at: number; route: string }> = [];
  let lastAlertAt: number | null = null;
  const emit = (obj: Record<string, unknown>) => { try { sink(JSON.stringify(obj)); } catch { /* logging must never break a response */ } };

  return {
    record(info) {
      const at = now();
      const route = info.route !== undefined && TEMPLATE.test(info.route) ? info.route : "(unmatched)";
      const err = info.error as { name?: unknown; code?: unknown } | null | undefined;
      emit({
        ts: new Date(at).toISOString(), level: "error", event: "server_error", requestId: ident(info.requestId) ?? "unknown", method: method(info.method), route, status: info.status,
        category: ident(info.category) ?? "unknown", errorName: ident(err?.name), errorCode: ident(err?.code), location: location(info.error),
      });
      recent = recent.filter((r) => at - r.at < windowMs);
      recent.push({ at, route });
      if (recent.length >= threshold && (lastAlertAt === null || at - lastAlertAt >= windowMs)) {
        lastAlertAt = at;
        emit({
          ts: new Date(at).toISOString(), level: "alert", event: "repeated_server_errors", count: recent.length, windowSec: Math.round(windowMs / 1000), threshold,
          routes: [...new Set(recent.map((r) => r.route))].slice(0, MAX_ROUTES_IN_ALERT),
        });
      }
    },
  };
}
