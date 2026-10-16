import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires an access token", () => {
    expect(() => loadConfig({})).toThrow(/META_ACCESS_TOKEN/);
  });

  it("applies defaults", () => {
    const c = loadConfig({ META_ACCESS_TOKEN: "t" });
    expect(c.graphVersion).toBe("v25.0");
    expect(c.timeoutMs).toBe(30000);
    expect(c.writeAllowlist).toEqual([]);
  });

  it("parses the write allow-list and rejects malformed ids", () => {
    const c = loadConfig({ META_ACCESS_TOKEN: "t", META_WRITE_ALLOWLIST: "act_1, act_2 " });
    expect(c.writeAllowlist).toEqual(["act_1", "act_2"]);
    expect(() => loadConfig({ META_ACCESS_TOKEN: "t", META_WRITE_ALLOWLIST: "123" })).toThrow();
  });

  it("rejects a malformed graph version", () => {
    expect(() => loadConfig({ META_ACCESS_TOKEN: "t", META_GRAPH_VERSION: "latest" })).toThrow();
  });

  it("never includes the token in the error text", () => {
    try {
      loadConfig({ META_ACCESS_TOKEN: "SECRET123", META_GRAPH_VERSION: "bad" });
    } catch (e) {
      expect(String(e)).not.toContain("SECRET123");
    }
  });
});
