import { describe, expect, it } from "vitest";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { generateCampaign, getCampaignRecord, listCampaigns, updateBrief } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { BRAIN, makeCore } from "./fixtures.js";

function setup(provider = new MockAiProvider()) {
  const core = makeCore();
  const c = buildContext({ db: core.db, now: core.now, aiProviders: [provider], gateway: { sleep: async () => {} } });
  const ws = createWorkspace(c, "A").workspace;
  return { c, ws };
}
const gen = { providerId: "mock", model: "mock-deterministic-1" };

describe("campaign generation", () => {
  it("requires a Business Brain first", async () => {
    const { c, ws } = setup();
    await expect(generateCampaign(c, ws.id, gen)).rejects.toMatchObject({ code: "brain_required" });
  });

  it("stores the validated campaign, version 1 and its assets", async () => {
    const { c, ws } = setup();
    putBrain(c, ws.id, BRAIN);
    const rec = await generateCampaign(c, ws.id, gen);
    expect(rec).toMatchObject({ status: "draft", currentVersion: 1 });
    expect(rec.versions).toEqual([expect.objectContaining({ version: 1, source: "ai", aiProvider: "mock", aiModel: "mock-deterministic-1" })]);
    expect(rec.assets.filter((a) => a.kind === "headline").length).toBe(rec.brief.headlines.length);
    expect(rec.brief.objective).toBe("OUTCOME_LEADS");
  });

  it("stores nothing when the model output is invalid", async () => {
    const { c, ws } = setup(new MockAiProvider("invalid"));
    putBrain(c, ws.id, BRAIN);
    await expect(generateCampaign(c, ws.id, gen)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(listCampaigns(c, ws.id)).toEqual([]);
  });

  it("stores nothing when the provider is unavailable", async () => {
    const { c, ws } = setup(new MockAiProvider("unavailable"));
    putBrain(c, ws.id, BRAIN);
    await expect(generateCampaign(c, ws.id, gen)).rejects.toMatchObject({ kind: "not_eligible" });
    expect(listCampaigns(c, ws.id)).toEqual([]);
  });
});

describe("campaign versions and isolation", () => {
  it("a human edit creates version 2 and keeps version 1", async () => {
    const { c, ws } = setup();
    putBrain(c, ws.id, BRAIN);
    const v1 = await generateCampaign(c, ws.id, gen);
    const v2 = updateBrief(c, ws.id, v1.id, { ...v1.brief, name: "Edited name" });
    expect(v2.currentVersion).toBe(2);
    expect(v2.versions.map((v) => v.source)).toEqual(["ai", "human"]);
    expect(v2.name).toBe("Edited name");
  });

  it("rejects an invalid edit without creating a version", async () => {
    const { c, ws } = setup();
    putBrain(c, ws.id, BRAIN);
    const v1 = await generateCampaign(c, ws.id, gen);
    expect(() => updateBrief(c, ws.id, v1.id, { ...v1.brief, headlines: [] })).toThrow();
    expect(getCampaignRecord(c, ws.id, v1.id).currentVersion).toBe(1);
  });

  it("does not let another workspace read or edit a campaign", async () => {
    const { c, ws } = setup();
    const other = createWorkspace(c, "B").workspace;
    putBrain(c, ws.id, BRAIN);
    const rec = await generateCampaign(c, ws.id, gen);
    expect(() => getCampaignRecord(c, other.id, rec.id)).toThrow(/not found/i);
    expect(() => updateBrief(c, other.id, rec.id, rec.brief)).toThrow(/not found/i);
    expect(listCampaigns(c, other.id)).toEqual([]);
  });
});
