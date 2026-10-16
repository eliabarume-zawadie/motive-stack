import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db/db.js";
import { authenticate, createWorkspace, getBrain, getWorkspace, putBrain } from "../src/app/workspaces.js";
import { AppError } from "../src/app/errors.js";
import { BRAIN, makeCore } from "./fixtures.js";

describe("migrations", () => {
  it("apply once and are idempotent", () => {
    const db = openDb(":memory:");
    expect(migrate(db)).toEqual(["001_init.sql", "002_ai.sql", "003_generation_identity.sql"]);
    expect(migrate(db)).toEqual([]);
  });
});

describe("workspaces", () => {
  it("creates a workspace, returns the token once, and stores only a hash", () => {
    const c = makeCore();
    const { workspace, token } = createWorkspace(c, "Acme");
    expect(token).toMatch(/^msw_/);
    const row = c.db.prepare("SELECT token_hash FROM workspaces WHERE id = ?").get(workspace.id) as { token_hash: string };
    expect(row.token_hash).not.toContain(token);
    expect(JSON.stringify(workspace)).not.toContain(token);
  });

  it("authenticates only the workspace the token belongs to", () => {
    const c = makeCore();
    const a = createWorkspace(c, "A");
    const b = createWorkspace(c, "B");
    expect(authenticate(c, a.workspace.id, a.token)).toBe(true);
    expect(authenticate(c, a.workspace.id, b.token)).toBe(false);
    expect(authenticate(c, b.workspace.id, a.token)).toBe(false);
    expect(authenticate(c, a.workspace.id, undefined)).toBe(false);
    expect(authenticate(c, "ws_missing", a.token)).toBe(false);
  });

  it("throws not_found for an unknown workspace", () => {
    expect(() => getWorkspace(makeCore(), "ws_nope")).toThrow(AppError);
  });
});

describe("Business Brain", () => {
  it("validates and versions saves", () => {
    const c = makeCore();
    const { workspace } = createWorkspace(c, "A");
    expect(getBrain(c, workspace.id)).toBeNull();
    expect(putBrain(c, workspace.id, BRAIN).version).toBe(1);
    expect(putBrain(c, workspace.id, { ...BRAIN, offer: "10% off" }).version).toBe(2);
    expect(getBrain(c, workspace.id)?.brain.offer).toBe("10% off");
  });

  it("rejects invalid input and unknown fields, and keeps the previous version", () => {
    const c = makeCore();
    const { workspace } = createWorkspace(c, "A");
    putBrain(c, workspace.id, BRAIN);
    expect(() => putBrain(c, workspace.id, { ...BRAIN, services: [] })).toThrow();
    expect(() => putBrain(c, workspace.id, { ...BRAIN, maxDailyBudgetCents: -5 })).toThrow();
    expect(() => putBrain(c, workspace.id, { ...BRAIN, hacked: true })).toThrow();
    expect(getBrain(c, workspace.id)?.version).toBe(1);
  });

  it("keeps each workspace's brain separate", () => {
    const c = makeCore();
    const a = createWorkspace(c, "A").workspace;
    const b = createWorkspace(c, "B").workspace;
    putBrain(c, a.id, BRAIN);
    expect(getBrain(c, b.id)).toBeNull();
    putBrain(c, b.id, { ...BRAIN, businessName: "Other Co" });
    expect(getBrain(c, a.id)?.brain.businessName).toBe("Sunrise Plumbing");
  });
});
