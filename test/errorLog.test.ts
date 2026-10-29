/**
 * Server-side error visibility. Every HTTP 5xx writes one JSON line (request id, route template, status, category, error class) and repeated errors raise one alert line.
 * Nothing sensitive may reach the log: not the body, the query string, headers, tokens, the error message, or real ids. Offline; the log goes to a test sink.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AiError } from "../src/ai/types.js";
import { AppError } from "../src/app/errors.js";
import { buildContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { createErrorLog, newRequestId } from "../src/server/errorLog.js";

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

function boot(opts: { alertThreshold?: number; alertWindowMs?: number; now?: () => number } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env: {} });
  const lines: string[] = [];
  const errorLog = createErrorLog({ sink: (l) => lines.push(l), ...opts });
  const app = buildServer(ctx, undefined, { errorLog });
  open.push(() => db.open && db.close());
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
  return { db, ctx, app, lines, parsed };
}
const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

describe("createErrorLog (the writer)", () => {
  it("writes one line with only the whitelisted fields, in the documented shape", () => {
    const out: string[] = [];
    const log = createErrorLog({ sink: (l) => out.push(l), now: () => Date.parse("2030-01-02T03:04:05.000Z") });
    const err = Object.assign(new TypeError("message with a SECRET-VALUE inside"), { code: "ERR_THING" });
    log.record({ requestId: "req_abc123", method: "PUT", route: "/api/workspaces/:wid/brain", status: 500, category: "internal", error: err });
    const line = JSON.parse(out[0]!);
    expect(Object.keys(line).sort()).toEqual(["category", "errorCode", "errorName", "event", "level", "method", "requestId", "route", "status", "ts"]); // no "location": this error was thrown in a test file, outside src/ and scripts/
    expect(line).toMatchObject({ ts: "2030-01-02T03:04:05.000Z", level: "error", event: "server_error", requestId: "req_abc123", method: "PUT", route: "/api/workspaces/:wid/brain", status: 500, category: "internal", errorName: "TypeError", errorCode: "ERR_THING" });
    expect(out[0]).not.toMatch(/SECRET-VALUE|Users|[A-Za-z]:\\/);
  });

  it("drops anything that is not a short plain identifier or a clean route template instead of escaping it", () => {
    const out: string[] = [];
    const log = createErrorLog({ sink: (l) => out.push(l) });
    const err = Object.assign(new Error("x"), { name: "Bad Name With Spaces\nand a newline", code: "no good; DROP TABLE" });
    log.record({ requestId: "req_1\nINJECTED LINE", method: "GET\r\nX", route: "/api/leads?email=person@example.com", status: 500, category: "weird category!", error: err });
    log.record({ requestId: "req_2", method: "GET", route: undefined, status: 503, category: "database_busy", error: "a string, not an Error" });
    expect(out).toHaveLength(2);
    expect(out.join("")).not.toMatch(/INJECTED|person@|DROP|newline|Bad Name/);
    const [a, b] = out.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ requestId: "unknown", method: "?", route: "(unmatched)", category: "unknown" });
    expect(a.errorName).toBeUndefined();
    expect(a.errorCode).toBeUndefined();
    expect(b).toMatchObject({ route: "(unmatched)", status: 503, category: "database_busy" });
  });

  it("raises ONE alert when the threshold is reached inside the window, and again only after a further full window", () => {
    const out: string[] = [];
    let t = 1_000_000;
    const log = createErrorLog({ sink: (l) => out.push(l), now: () => t, alertThreshold: 3, alertWindowMs: 60_000 });
    const hit = (route: string) => log.record({ requestId: "req_x", method: "GET", route, status: 500, category: "internal", error: new Error("e") });
    hit("/api/a"); t += 1000; hit("/api/b");
    expect(out.map((l) => JSON.parse(l).event)).toEqual(["server_error", "server_error"]); // below the threshold: no alert
    t += 1000; hit("/api/a");
    const alerts = () => out.map((l) => JSON.parse(l)).filter((l) => l.event === "repeated_server_errors");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ level: "alert", count: 3, windowSec: 60, threshold: 3, routes: ["/api/a", "/api/b"] });
    t += 1000; hit("/api/a"); t += 1000; hit("/api/a");
    expect(alerts()).toHaveLength(1); // still the same window: no second alert per error
    t += 61_000; hit("/api/a"); t += 100; hit("/api/a"); t += 100; hit("/api/a");
    expect(alerts()).toHaveLength(2); // a new window with the problem still going
    t += 600_000; hit("/api/a");
    expect(alerts()).toHaveLength(2); // old errors have aged out; one error is not a pattern
  });

  it("never lets a failing sink break the caller, and makes request ids that are unique and plain", () => {
    const log = createErrorLog({ sink: () => { throw new Error("disk full"); } });
    expect(() => log.record({ requestId: "req_1", method: "GET", route: "/x", status: 500, category: "internal", error: new Error("e") })).not.toThrow();
    const ids = new Set(Array.from({ length: 500 }, newRequestId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^req_[0-9a-f]{16}$/);
  });
});

describe("the server's error handler", () => {
  it("logs an unexpected failure once, with the request id the caller also receives, and nothing sensitive", async () => {
    const s = boot();
    const SECRET_MESSAGE = "SECRET-IN-ERROR-MESSAGE-9f31";
    s.app.get("/boom/:thing", async () => { throw new Error(`leaked ${SECRET_MESSAGE}`); }); // outside /api so the default-deny rule does not answer first
    const res = await get(s.app, "/boom/SECRET-PATH-VALUE?token=SECRET-QUERY-VALUE&email=person@example.com", { authorization: "Bearer SECRET-BEARER-TOKEN", cookie: "sid=SECRET-COOKIE", "x-api-key": "SECRET-API-KEY" });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(500);
    expect(body.error.code).toBe("internal");
    expect(body.error.requestId).toMatch(/^req_[0-9a-f]{16}$/);
    expect(res.body).not.toMatch(/SECRET/);
    expect(s.lines).toHaveLength(1);
    const line = s.parsed()[0]!;
    expect(line).toMatchObject({ level: "error", event: "server_error", requestId: body.error.requestId, method: "GET", route: "/boom/:thing", status: 500, category: "internal", errorName: "Error" });
    expect(s.lines[0]).not.toMatch(/SECRET|person@example|Bearer|cookie|x-api-key|token=|\?/);
  });

  it("logs a failure inside a real route (the database goes away) by route template, with no request body, query, token or workspace id in the line", async () => {
    const s = boot();
    const ws = createWorkspace(s.ctx, "Sunrise Plumbing");
    const SECRET_BODY = "SECRET-BODY-OWNER-NAME-77";
    s.db.close(); // every database call from here on throws an unexpected error
    const res = await s.app.inject({
      method: "PUT", url: `/api/workspaces/${ws.workspace.id}/brain?note=SECRET-QUERY-VALUE`,
      headers: { authorization: `Bearer ${ws.token}`, "content-type": "application/json" }, payload: JSON.stringify({ businessName: SECRET_BODY, ownerEmail: "owner@example.com" }),
    });
    expect(res.statusCode).toBe(500);
    expect(s.lines).toHaveLength(1);
    const line = s.parsed()[0]!;
    expect(line).toMatchObject({ method: "PUT", route: "/api/workspaces/:wid/brain", status: 500, category: "internal" });
    expect(line.location).toMatch(/^src\/[A-Za-z0-9_./-]+:\d+$/); // where it was thrown: a project-relative file and line, never an absolute path
    for (const secret of [SECRET_BODY, "owner@example.com", "SECRET-QUERY-VALUE", ws.token, ws.workspace.id, "Bearer", "authorization"]) expect(s.lines[0], secret).not.toContain(secret);
    expect(res.body).not.toContain(ws.token);
  });

  it("logs 5xx answers of every kind with the right category, and does not log 4xx answers", async () => {
    const s = boot();
    s.app.get("/e/ai503", async () => { throw new AiError("provider_unavailable", "provider said SECRET-PROVIDER-TEXT"); });
    s.app.get("/e/ai429", async () => { throw new AiError("rate_limit", "slow down"); });
    s.app.get("/e/app503", async () => { throw new AppError(503, "auth_unavailable", "sign-in is unavailable"); });
    s.app.get("/e/app409", async () => { throw new AppError(409, "conflict", "no"); });
    s.app.get("/e/busy", async () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); });
    const statuses: Record<string, number> = {};
    for (const p of ["ai503", "ai429", "app503", "app409", "busy"]) statuses[p] = (await get(s.app, `/e/${p}`)).statusCode;
    expect(statuses).toEqual({ ai503: 503, ai429: 429, app503: 503, app409: 409, busy: 503 });
    expect(s.parsed().map((l) => [l.route, l.status, l.category])).toEqual([["/e/ai503", 503, "provider"], ["/e/app503", 503, "auth_unavailable"], ["/e/busy", 503, "database_busy"]]);
    expect(s.lines.join("")).not.toContain("SECRET-PROVIDER-TEXT");
    // client errors and ordinary refusals are not server errors
    expect((await get(s.app, "/api/workspaces/ws_nope/brain")).statusCode).toBe(401);
    expect((await get(s.app, "/no/such/route")).statusCode).toBe(404);
    expect(s.parsed()).toHaveLength(3);
  });

  it("ignores a request id sent by the client, so nobody can write text of their choosing into the log", async () => {
    const s = boot();
    s.app.get("/boom", async () => { throw new Error("x"); });
    await get(s.app, "/boom", { "request-id": "evil\nINJECTED", "x-request-id": "evil2" });
    expect(s.parsed()[0]!.requestId).toMatch(/^req_[0-9a-f]{16}$/);
    expect(s.lines[0]).not.toMatch(/evil|INJECTED/);
  });

  it("raises one repeated-error alert line when failures keep happening, and the line carries route templates only", async () => {
    const s = boot({ alertThreshold: 3, alertWindowMs: 60_000 });
    s.app.get("/boom/:id", async () => { throw new Error("x"); });
    for (const id of ["1", "2", "3", "4", "5"]) await get(s.app, `/boom/SECRET-ID-${id}`);
    const events = s.parsed().map((l) => l.event);
    expect(events.filter((e) => e === "server_error")).toHaveLength(5);
    expect(events.filter((e) => e === "repeated_server_errors")).toHaveLength(1);
    expect(s.parsed().find((l) => l.event === "repeated_server_errors")).toMatchObject({ level: "alert", count: 3, routes: ["/boom/:id"] });
    expect(s.lines.join("")).not.toContain("SECRET-ID");
  });
});
