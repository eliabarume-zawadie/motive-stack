import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GraphClient } from "../../src/connector/meta/graphClient.js";
import { MetaConnector } from "../../src/connector/meta/MetaConnector.js";
import { loadIntegrationConfig } from "../../src/integrations/mode.js";

/**
 * LIVE, READ-ONLY checks against the real Meta API. They run only when the developer opts in with ALL of:
 *   LIVE_TESTS=1  INTEGRATION_MODE=live  LIVE_META=true  META_ACCESS_TOKEN=<token>
 * Otherwise they are reported as SKIPPED (never as passed). They never create or change anything.
 */
const env = process.env;
const optedIn = env.LIVE_TESTS === "1" && env.INTEGRATION_MODE === "live" && env.LIVE_META === "true" && !!env.META_ACCESS_TOKEN;
const why = "SKIPPED: set LIVE_TESTS=1 INTEGRATION_MODE=live LIVE_META=true META_ACCESS_TOKEN=...";

describe.skipIf(!optedIn)(`LIVE Meta (read-only)${optedIn ? "" : ` - ${why}`}`, () => {
  const make = () => {
    const cfg = loadConfig(env);
    return new MetaConnector(new GraphClient({ token: cfg.accessToken, version: cfg.graphVersion, timeoutMs: cfg.timeoutMs }), { writeAllowlist: [] });
  };

  it("integration config really is live for Meta", () => {
    expect(loadIntegrationConfig(env).liveMeta).toBe(true);
  });

  it("lists the ad accounts this token can see", async () => {
    const accounts = await make().getAuthorizedAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0]?.id).toMatch(/^act_\d+$/);
  });

  it.skipIf(!env.META_LIVE_TEST_ACCOUNT)("reads campaigns on META_LIVE_TEST_ACCOUNT", async () => {
    const list = await make().listCampaigns(env.META_LIVE_TEST_ACCOUNT as string);
    expect(Array.isArray(list)).toBe(true);
  });

  it("refuses writes because the allow-list is empty", async () => {
    await expect(
      make().createCampaignDraft(
        { workspaceId: "w", accountId: "act_1", name: "x", objective: "OUTCOME_LEADS" },
        { workspaceId: "w", accountId: "act_1", action: "create_campaign_draft", actionVersion: 1, approvedBy: "t", expiresAt: "2999-01-01T00:00:00Z" },
      ),
    ).rejects.toMatchObject({ kind: "approval_refused" });
  });
});

// Always runs, so the report shows an explicit skipped/not-run notice instead of silence.
describe("live test gate", () => {
  it(optedIn ? "live tests are ENABLED for this run" : `live tests are DISABLED for this run (${why})`, () => {
    expect(typeof optedIn).toBe("boolean");
  });
});
