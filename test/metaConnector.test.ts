import { describe, expect, it } from "vitest";
import { GraphClient } from "../src/connector/meta/graphClient.js";
import { MetaConnector } from "../src/connector/meta/MetaConnector.js";
import type { ApprovalGrant, CampaignDraftInput } from "../src/connector/AdPlatformConnector.js";
import { graphError, mockFetch, noSleep } from "./helpers.js";

const SANDBOX = "act_2327392417830705";
const NOW = new Date("2026-10-15T12:00:00Z");

const build = (responses: Parameters<typeof mockFetch>[0], allow = [SANDBOX]) => {
  const m = mockFetch(responses);
  const client = new GraphClient({ token: "T", version: "v25.0", timeoutMs: 1000, fetchImpl: m.fetchImpl, sleep: noSleep });
  return { m, connector: new MetaConnector(client, { writeAllowlist: allow, now: () => NOW }) };
};

const input: CampaignDraftInput = { workspaceId: "ws1", accountId: SANDBOX, name: "MS-TEST", objective: "OUTCOME_LEADS" };
const approval: ApprovalGrant = {
  workspaceId: "ws1", accountId: SANDBOX, action: "create_campaign_draft",
  actionVersion: 1, approvedBy: "elia", expiresAt: "2026-10-15T13:00:00Z",
};

describe("reads", () => {
  it("lists authorized accounts in the platform-neutral shape", async () => {
    const { connector } = build([{ body: { data: [{ id: "act_1", name: "A", account_status: 1, currency: "USD" }] } }]);
    expect(await connector.getAuthorizedAccounts()).toEqual([
      { id: "act_1", name: "A", status: "active", currency: "USD" },
    ]);
  });

  it("reads account details", async () => {
    const { connector } = build([{ body: { id: SANDBOX, name: "S", account_status: 1, currency: "USD", timezone_name: "UTC", amount_spent: "0" } }]);
    expect(await connector.getAdAccountDetails(SANDBOX)).toMatchObject({ id: SANDBOX, amountSpent: "0", status: "active" });
  });

  it("lists campaigns", async () => {
    const { connector } = build([{ body: { data: [{ id: "9", name: "c", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_LEADS" }] } }]);
    expect(await connector.listCampaigns(SANDBOX)).toEqual([
      { id: "9", name: "c", status: "PAUSED", effectiveStatus: "PAUSED", objective: "OUTCOME_LEADS" },
    ]);
  });

  it("rejects a response that does not match the schema", async () => {
    const { connector } = build([{ body: { data: [{ name: "no id" }] } }]);
    await expect(connector.listCampaigns(SANDBOX)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects ids with unsafe characters before any request", async () => {
    const { connector, m } = build([]);
    await expect(connector.getAdAccountDetails("act_1/../me")).rejects.toThrow(/invalid/i);
    expect(m.calls).toHaveLength(0);
  });

  it("lists lead forms and retrieves a lead", async () => {
    const { connector } = build([
      { body: { data: [{ id: "f1", name: "Form", status: "ACTIVE" }] } },
      { body: { id: "1099050259370881", created_time: "2026-10-15T11:37:07+0000", field_data: [{ name: "EMAIL", values: ["a@b.c"] }] } },
    ]);
    expect(await connector.listLeadForms("123")).toEqual([{ id: "f1", name: "Form", status: "ACTIVE" }]);
    expect(await connector.retrieveLead("1099050259370881")).toEqual({
      id: "1099050259370881", createdTime: "2026-10-15T11:37:07+0000", fields: { EMAIL: ["a@b.c"] },
    });
  });
});

describe("createCampaignDraft approval gate", () => {
  const cases: Array<[string, Partial<ApprovalGrant> | null, string[]?]> = [
    ["no approval", null],
    ["wrong account", { accountId: "act_999" }],
    ["wrong workspace", { workspaceId: "other" }],
    ["wrong action", { action: "activate_campaign" as never }],
    ["expired approval", { expiresAt: "2026-10-15T11:00:00Z" }],
    ["blank approver", { approvedBy: " " }],
    ["account not on the write allow-list", {}, []],
  ];
  for (const [label, patch, allow] of cases) {
    it(`refuses: ${label}, and makes no request`, async () => {
      const { connector, m } = build([], allow ?? [SANDBOX]);
      const grant = patch === null ? undefined : ({ ...approval, ...patch } as ApprovalGrant);
      await expect(connector.createCampaignDraft(input, grant as ApprovalGrant)).rejects.toMatchObject({ kind: "approval_refused" });
      expect(m.calls).toHaveLength(0);
    });
  }
});

describe("createCampaignDraft", () => {
  it("creates a PAUSED campaign with the required parameters and verifies it by reading back", async () => {
    const { connector, m } = build([
      { body: { id: "555" } },
      { body: { id: "555", name: "MS-TEST", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_LEADS" } },
    ]);
    const c = await connector.createCampaignDraft(input, approval);
    expect(c).toMatchObject({ id: "555", status: "PAUSED", effectiveStatus: "PAUSED" });
    const body = new URLSearchParams(String(m.calls[0]!.init.body));
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("special_ad_categories")).toBe("[]");
    expect(body.get("is_adset_budget_sharing_enabled")).toBe("false");
    expect(body.get("daily_budget")).toBeNull();
    expect(m.calls[0]!.url).toContain(`/${SANDBOX}/campaigns`);
    expect(m.calls[1]!.url).toContain("/555?");
  });

  it("fails loudly if the read-back shows the campaign is not paused", async () => {
    const { connector } = build([
      { body: { id: "555" } },
      { body: { id: "555", name: "MS-TEST", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" } },
    ]);
    await expect(connector.createCampaignDraft(input, approval)).rejects.toMatchObject({ kind: "verification_failed" });
  });

  it("after a timeout, reconciles by name instead of retrying the create", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { connector, m } = build([
      abort,
      { body: { data: [{ id: "555", name: "MS-TEST", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_LEADS" }] } },
      { body: { id: "555", name: "MS-TEST", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_LEADS" } },
    ]);
    const c = await connector.createCampaignDraft(input, approval);
    expect(c.id).toBe("555");
    expect(m.calls.filter((x) => x.init.method === "POST")).toHaveLength(1);
  });

  it("after a timeout with no match, reports an unknown outcome and still does not retry", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { connector, m } = build([abort, { body: { data: [] } }]);
    await expect(connector.createCampaignDraft(input, approval)).rejects.toMatchObject({ kind: "timeout", outcomeUnknown: true });
    expect(m.calls.filter((x) => x.init.method === "POST")).toHaveLength(1);
  });

  it("surfaces Meta validation errors without retrying", async () => {
    const { connector, m } = build([{ status: 400, body: graphError(100, "Invalid parameter", { error_subcode: 4834011 }) }]);
    await expect(connector.createCampaignDraft(input, approval)).rejects.toMatchObject({ kind: "validation", subcode: 4834011 });
    expect(m.calls).toHaveLength(1);
  });
});
