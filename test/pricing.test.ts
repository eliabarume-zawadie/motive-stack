import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PricingTable } from "../src/ai/pricing.js";
import { ModelRegistry } from "../src/ai/registry.js";

const u = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, source: "provider" as const });
const shipped = () => PricingTable.fromFile("config/ai-pricing.json");

describe("shipped price list (verified 2026-10-16, see docs/ai-verification.md)", () => {
  const file = JSON.parse(readFileSync("config/ai-pricing.json", "utf8")) as { prices: Array<Record<string, any>> };

  it("every entry has a source URL, a verification date and a stated scope, and positive rates", () => {
    expect(file.prices.length).toBeGreaterThan(0);
    for (const p of file.prices) {
      expect(p.source).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com)\//);
      expect(p.asOf).toBe("2026-10-16");
      expect(p.appliesTo.length).toBeGreaterThan(20);
      expect(p.inputPerMTokMicros).toBeGreaterThan(0);
      expect(p.outputPerMTokMicros).toBeGreaterThan(0);
    }
  });

  it("covers every live test model in the registry, and no model it does not know", () => {
    const reg = ModelRegistry.fromFile("config/ai-models.json");
    const table = shipped();
    // mock is simulated and ollama runs locally with no per-token charge: neither has a price, by design
    for (const e of reg.entries.filter((x) => x.provider !== "mock" && x.provider !== "ollama")) expect(table.has(e.provider, e.model), `${e.provider}/${e.model}`).toBe(true);
    expect(table.has("ollama", "llama3.1:latest")).toBe(false); // a local model must never carry a price entry
    for (const p of file.prices) expect(reg.find(p.provider, p.model), `${p.provider}/${p.model}`).toBeDefined();
  });

  it("matches the figures read from the official pages", () => {
    const t = shipped();
    expect(t.entry("anthropic", "claude-haiku-5-5")).toMatchObject({ inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, longContext: { aboveInputTokens: 100_000, inputPerMTokMicros: 500_000, outputPerMTokMicros: 2_500_000 } });
    expect(t.entry("anthropic", "claude-sonnet-5-5")).toMatchObject({ inputPerMTokMicros: 2_000_000, outputPerMTokMicros: 10_000_000 });
    expect(t.entry("anthropic", "claude-opus-5-5")).toMatchObject({ inputPerMTokMicros: 4_000_000, outputPerMTokMicros: 20_000_000 });
    expect(t.entry("openai", "gpt-6-luna")).toMatchObject({ inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, longContext: { aboveInputTokens: 272_000, inputPerMTokMicros: 200_000, outputPerMTokMicros: 750_000 } });
    expect(t.entry("openai", "gpt-5.5")).toMatchObject({ inputPerMTokMicros: 5_000_000, outputPerMTokMicros: 30_000_000, longContext: { inputPerMTokMicros: 10_000_000, outputPerMTokMicros: 45_000_000 } });
  });
});

describe("cost estimation rules", () => {
  it("prices a small request at the base rate (Haiku 5.5: 1000 in + 500 out = $0.00035)", () => {
    expect(shipped().estimate("anthropic", "claude-haiku-5-5", u(1000, 500), false)).toEqual({ micros: 350, status: "estimated" });
  });
  it("switches to the long-context rate for the WHOLE request above the threshold", () => {
    const t = shipped();
    expect(t.estimate("anthropic", "claude-haiku-5-5", u(100_000, 1000), false).micros).toBe(Math.round((100_000 * 100_000 + 1000 * 500_000) / 1e6)); // at the threshold: base
    expect(t.estimate("anthropic", "claude-haiku-5-5", u(100_001, 1000), false).micros).toBe(Math.round((100_001 * 500_000 + 1000 * 2_500_000) / 1e6)); // above: long-context
    expect(t.estimate("openai", "gpt-6-luna", u(300_000, 1000), false).micros).toBe(Math.round((300_000 * 200_000 + 1000 * 750_000) / 1e6));
  });
  it("never turns unknown into zero: no price, no usage, and unmodelled tiers are all null", () => {
    const t = shipped();
    expect(t.estimate("anthropic", "claude-haiku-4-5-20251001", u(1, 1), false)).toEqual({ micros: null, status: "unknown_no_pricing" });
    expect(t.estimate("anthropic", "claude-haiku-5-5", undefined, false)).toEqual({ micros: null, status: "unknown_no_usage" });
    expect(t.estimate("anthropic", "claude-haiku-5-5", { source: "provider" }, false)).toEqual({ micros: null, status: "unknown_no_usage" });
    const limited = new PricingTable("USD", [{ provider: "p", model: "m", inputPerMTokMicros: 1, outputPerMTokMicros: 1, baseValidUpToInputTokens: 1000, appliesTo: "test fixture", asOf: "2026-01-01", source: "https://example.com" }]);
    expect(limited.estimate("p", "m", u(2000, 1), false)).toEqual({ micros: null, status: "unknown_no_pricing" });
  });
  it("a genuine provider-reported zero is a real zero cost, distinct from unknown", () => {
    expect(shipped().estimate("anthropic", "claude-haiku-5-5", u(0, 0), false)).toEqual({ micros: 0, status: "estimated" });
  });
  it("rejects a price file with a zero, missing-source or badly dated entry", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "price-"));
    const bad = (entry: object) => {
      const f = join(dir, `p${Math.random()}.json`);
      writeFileSync(f, JSON.stringify({ currency: "USD", prices: [{ provider: "p", model: "m", inputPerMTokMicros: 1, outputPerMTokMicros: 1, appliesTo: "x", asOf: "2026-10-16", source: "https://example.com", ...entry }] }));
      return () => PricingTable.fromFile(f);
    };
    expect(bad({})).not.toThrow();
    expect(bad({ inputPerMTokMicros: 0 })).toThrow();
    expect(bad({ outputPerMTokMicros: 0 })).toThrow();
    expect(bad({ source: "not a url" })).toThrow();
    expect(bad({ asOf: "yesterday" })).toThrow();
  });
});
