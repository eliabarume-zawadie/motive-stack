import { describe, expect, it } from "vitest";
import { GraphClient } from "../src/connector/meta/graphClient.js";
import { MetaApiError } from "../src/connector/meta/errors.js";
import { graphError, mockFetch, noSleep } from "./helpers.js";

const make = (m: ReturnType<typeof mockFetch>, extra = {}) =>
  new GraphClient({ token: "SECRET_TOKEN", version: "v25.0", timeoutMs: 1000, fetchImpl: m.fetchImpl, sleep: noSleep, ...extra });

describe("GraphClient", () => {
  it("sends the token in the Authorization header, never in the URL", async () => {
    const m = mockFetch([{ body: { id: "1" } }]);
    await make(m).get("me", { fields: "id" });
    expect(m.calls[0]!.url).toBe("https://graph.facebook.com/v25.0/me?fields=id");
    expect(m.calls[0]!.url).not.toContain("SECRET_TOKEN");
    expect((m.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET_TOKEN");
  });

  it("retries a GET on rate limiting and then succeeds", async () => {
    const m = mockFetch([{ status: 400, body: graphError(17) }, { status: 400, body: graphError(4) }, { body: { ok: true } }]);
    await expect(make(m).get("me")).resolves.toEqual({ ok: true });
    expect(m.calls).toHaveLength(3);
  });

  it("gives up on a GET after the retry limit and throws a rate_limit error", async () => {
    const m = mockFetch(Array.from({ length: 5 }, () => ({ status: 400, body: graphError(17) })));
    await expect(make(m, { maxReadRetries: 2 }).get("me")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(m.calls).toHaveLength(3);
  });

  it("does not retry a GET on permission errors", async () => {
    const m = mockFetch([{ status: 400, body: graphError(200, "no perm") }]);
    await expect(make(m).get("x")).rejects.toMatchObject({ kind: "permission" });
    expect(m.calls).toHaveLength(1);
  });

  it("never retries a POST, even on a transient error", async () => {
    const m = mockFetch([{ status: 500, body: graphError(2) }, { body: { id: "1" } }]);
    await expect(make(m).post("act_1/campaigns", { name: "x" })).rejects.toMatchObject({ kind: "transient" });
    expect(m.calls).toHaveLength(1);
  });

  it("marks a timed-out POST as outcome-unknown and does not retry", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const m = mockFetch([abort, { body: { id: "1" } }]);
    const err = await make(m).post("act_1/campaigns", { name: "x" }).catch((e: MetaApiError) => e) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.kind).toBe("timeout");
    expect(err.outcomeUnknown).toBe(true);
    expect(m.calls).toHaveLength(1);
  });

  it("maps an expired token to token_expired", async () => {
    const m = mockFetch([{ status: 401, body: graphError(190, "expired") }]);
    await expect(make(m).get("me")).rejects.toMatchObject({ kind: "token_expired" });
  });

  it("does not call a wrong-token-type error (code 190) an expired token", async () => {
    const m = mockFetch([{ status: 400, body: graphError(190, "(#190) This method must be called with a Page Access Token") }]);
    await expect(make(m).get("p/leadgen_forms")).rejects.toMatchObject({ kind: "permission", code: 190 });
  });

  it("maps validation errors and keeps code, subcode and trace id", async () => {
    const m = mockFetch([{ status: 400, body: graphError(100, "bad", { error_subcode: 1815089 }) }]);
    const err = await make(m).post("a", {}).catch((e: MetaApiError) => e);
    expect(err).toMatchObject({ kind: "validation", code: 100, subcode: 1815089, fbtraceId: "TRACE" });
  });

  it("never leaks the token into error messages", async () => {
    const m = mockFetch([{ status: 400, body: graphError(100, "Invalid token SECRET_TOKEN here") }]);
    const err = await make(m).get("me").catch((e: MetaApiError) => e) as MetaApiError;
    expect(err.message).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(err)).not.toContain("SECRET_TOKEN");
  });

  it("form-encodes POST bodies and JSON-encodes object values", async () => {
    const m = mockFetch([{ body: { id: "1" } }]);
    await make(m).post("act_1/campaigns", { name: "n", special_ad_categories: [] });
    const body = new URLSearchParams(String(m.calls[0]!.init.body));
    expect(body.get("name")).toBe("n");
    expect(body.get("special_ad_categories")).toBe("[]");
  });
});
