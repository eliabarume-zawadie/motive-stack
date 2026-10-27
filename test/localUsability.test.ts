import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BusinessBrainSchema } from "../src/domain/schemas.js";

// public/recovery.js is plain browser JavaScript with no DOM access; load it as a module here.
// @ts-expect-error browser JavaScript without type declarations
const { parseRecoveryCode, formatRecoveryCode, DEMO_BUSINESS } = (await import("../public/recovery.js")) as {
  parseRecoveryCode: (t: unknown) => { workspaceId: string; token: string } | null;
  formatRecoveryCode: (w: string, t: string) => string;
  DEMO_BUSINESS: Record<string, unknown>;
};

const WS = "ws_0123456789abcdef0123";
const TOKEN = "msw_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6".slice(0, 32);

describe("workspace recovery code", () => {
  it("round-trips an id and token", () => {
    expect(parseRecoveryCode(formatRecoveryCode(WS, TOKEN))).toEqual({ workspaceId: WS, token: TOKEN });
  });
  it("ignores surrounding whitespace and newlines from a paste", () => {
    expect(parseRecoveryCode(`  \n${WS}:${TOKEN}\n `)).toEqual({ workspaceId: WS, token: TOKEN });
  });
  it.each([
    ["empty", ""], ["null", null], ["token only", TOKEN], ["id only", WS], ["swapped", `${TOKEN}:${WS}`],
    ["bad id", `ws_xyz:${TOKEN}`], ["short token", `${WS}:msw_abc`], ["extra part", `${WS}:${TOKEN}:more`],
    ["inner whitespace", `${WS} :${TOKEN}`], ["a URL", `http://localhost/?${WS}:${TOKEN}`],
  ])("rejects %s", (_n, v) => { expect(parseRecoveryCode(v)).toBeNull(); });
});

describe("demo business", () => {
  it("is valid Business Brain input, so saving it works", () => {
    expect(() => BusinessBrainSchema.parse({ ...DEMO_BUSINESS, facts: [] })).not.toThrow();
  });
  it("is clearly fictional and cannot raise the spending ceiling beyond a small demo amount", () => {
    expect(String(DEMO_BUSINESS.businessName)).toMatch(/\(DEMO\)/);
    expect(String(DEMO_BUSINESS.description)).toMatch(/^DEMO DATA/);
    expect(DEMO_BUSINESS.maxDailyBudgetCents as number).toBeLessThanOrEqual(5000);
    expect(Object.isFrozen(DEMO_BUSINESS)).toBe(true);
  });
});

describe("page structure", () => {
  const html = readFileSync("public/index.html", "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  it("has no duplicate element ids", () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
  it("every in-page link points at an element that exists", () => {
    for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${m[1]}`).toContain(m[1]);
  });
  it("labels the recovery panel and the demo action", () => {
    expect(html).toMatch(/Save your workspace recovery code now/);
    expect(html).toMatch(/Load demo business/);
  });
  it("loads only same-origin scripts (the CSP allows nothing else) and no inline script", () => {
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const t of tags) { expect(t).toMatch(/src="[^"/:][^":]*"/); }
  });
});

describe("styles", () => {
  it("lets the hidden attribute win over display rules (a 'hidden' progress bar or panel must not show)", () => {
    expect(readFileSync("public/style.css", "utf8")).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});
