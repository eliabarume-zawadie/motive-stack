/**
 * Phase 2: the Brand Kit (preferences, versioned, version-bound approval) and the asset library (validated files, immutable versions, rights, review),
 * plus the storage layer's path and integrity rules. Signed-in people are test identities; nothing leaves this process.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig, workspaceTokenRuntime } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { LocalAssetStore, MemoryAssetStore, assetKey, isValidKey } from "../src/storage/assetStore.js";
import { readImageInfo } from "../src/storage/imageInfo.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

/* ---------------------------------------------------------------- tiny valid files, built from bytes */
function png(w = 4, h = 3, salt = 0): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12, "ascii"); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20); head[24] = 8; head[25] = 2;
  return Buffer.concat([head, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, salt & 255])]);
}
function jpeg(w = 6, h = 5): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webp(w = 7, h = 2): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(22, 4); b.write("WEBPVP8X", 8, "ascii"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

/* ---------------------------------------------------------------- unit: file inspection and the storage layer */

describe("reading what a file really is", () => {
  it("recognises PNG, JPEG and WebP from their own bytes and reads their size", () => {
    expect(readImageInfo(png(40, 30))).toEqual({ mime: "image/png", ext: "png", width: 40, height: 30 });
    expect(readImageInfo(jpeg(640, 480))).toEqual({ mime: "image/jpeg", ext: "jpg", width: 640, height: 480 });
    expect(readImageInfo(webp(1200, 628))).toEqual({ mime: "image/webp", ext: "webp", width: 1200, height: 628 });
  });
  it("refuses scripts, SVG, GIF, HTML, empty and truncated files, however they are named", () => {
    for (const bad of [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), Buffer.from("<html><script>1</script></html>"), Buffer.from("GIF89a\x01\x00\x01\x00"),
      Buffer.from("#!/bin/sh\necho hi"), Buffer.alloc(0), Buffer.from([0x89, 0x50, 0x4e, 0x47]), png().subarray(0, 20), jpeg().subarray(0, 6),
    ]) expect(readImageInfo(bad)).toBeNull();
  });
  it("refuses a zero or absurd size (a likely mistake or decompression bomb)", () => {
    expect(readImageInfo(png(0, 10))).toBeNull();
    expect(readImageInfo(png(40000, 10))).toBeNull();
    expect(readImageInfo(png(12000, 12000))).not.toBeNull();
  });
});

describe("storage keys and the local store", () => {
  it("builds keys only from safe ids and a known extension, and refuses anything that could leave the folder", () => {
    expect(assetKey("ws_abc", "asset_1", 3, "png")).toBe("ws_abc/asset_1/v3.png");
    for (const args of [["../ws", "a", 1, "png"], ["ws", "a/b", 1, "png"], ["ws", "a", 0, "png"], ["ws", "a", 1, "svg"], ["ws", "a", 1, "png/../x"], ["", "a", 1, "png"], ["WS", "a", 1, "png"]] as const) {
      expect(() => assetKey(...(args as [string, string, number, string])), JSON.stringify(args)).toThrow();
    }
    for (const k of ["../x/y/v1.png", "a/b/v1.png/../../c", "a/b/../c/v1.png", "/etc/passwd", "a\\b\\v1.png", "a/b/v1.svg", "a/b/c/v1.png", "a/b/v1.png\0"]) expect(isValidKey(k), k).toBe(false);
  });

  it("writes inside its folder, never overwrites a version's file, and returns null for a missing key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-assets-"));
    open.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new LocalAssetStore(dir);
    const key = assetKey("ws_a", "asset_1", 1, "png");
    await s.put(key, png());
    expect(readdirSync(join(dir, "ws_a", "asset_1"))).toEqual(["v1.png"]);
    expect(readFileSync(join(dir, "ws_a", "asset_1", "v1.png")).equals(png())).toBe(true);
    await expect(s.put(key, png(9, 9))).rejects.toThrow(); // 'wx': an existing file is never replaced
    expect((await s.get(key))!.equals(png())).toBe(true);
    expect(await s.get(assetKey("ws_a", "asset_1", 2, "png"))).toBeNull();
    await expect(s.put("../../escape/x/v1.png", png())).rejects.toThrow();
    await expect(s.get("../../etc/passwd")).rejects.toThrow();
    writeFileSync(join(dir, "outside.txt"), "x");
    await s.remove(key);
    expect(await s.get(key)).toBeNull();
  });

  it("the in-memory store follows the same rules", async () => {
    const s = new MemoryAssetStore();
    const key = assetKey("ws_a", "asset_1", 1, "jpg");
    await s.put(key, jpeg());
    await expect(s.put(key, jpeg())).rejects.toThrow();
    await expect(s.put("../x", jpeg())).rejects.toThrow();
    expect((await s.get(key))!.equals(jpeg())).toBe(true);
  });
});

/* ---------------------------------------------------------------- API worlds */

type Json = Record<string, any>;
interface World { db: ReturnType<typeof openDb>; ctx: AppContext; app: FastifyInstance; store: MemoryAssetStore }
function boot(mode: "oidc" | "token", limits: Partial<AppContext["assetLimits"]> = {}): World {
  const db = openDb(":memory:");
  migrate(db);
  const store = new MemoryAssetStore();
  const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: store, assetLimits: limits });
  const app = buildServer(ctx, mode === "oidc" ? oidc() : workspaceTokenRuntime);
  open.push(() => db.open && db.close());
  return { db, ctx, app, store };
}
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  const isJson = String(res.headers["content-type"] ?? "").includes("json");
  return { status: res.statusCode, headers: res.headers, raw: res.rawPayload, body: (isJson && res.body ? JSON.parse(res.body) : {}) as Json };
}
async function person(w: World, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  const r = await call(w.app, "GET", "/api/me", token);
  return { token, id: r.body.user.id as string };
}

/** A workspace with an owner, an admin, a second admin, an operator and a viewer. */
async function team() {
  const w = boot("oidc");
  const owner = await person(w, "olivia");
  const admin = await person(w, "adam");
  const admin2 = await person(w, "amy");
  const operator = await person(w, "oscar");
  const viewer = await person(w, "vera");
  const W = (await call(w.app, "POST", "/api/workspaces", owner.token, { name: "Brand Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(w.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  return { w, base, W, owner, admin, admin2, operator, viewer };
}
type Team = Awaited<ReturnType<typeof team>>;
const upload = (t: Team, by: { token: string }, over: Json = {}, file: Buffer = png()) =>
  call(t.w.app, "POST", `${t.base}/assets`, by.token, { name: "Logo", kind: "logo", source: "uploaded", rightsBasis: "owned", data: b64(file), ...over });

/* ---------------------------------------------------------------- Brand Kit */

describe("Brand Kit: preferences, separate from business facts, versioned, with version-bound approval", () => {
  const KIT = { voice: { descriptors: ["warm", "direct"], preferredTerms: ["neighbour"], avoidTerms: ["cheap"], ctaStyle: "Short and friendly" }, visual: { colors: [{ name: "Brand blue", hex: "#1A4D8F", role: "primary" }], typography: "Rounded sans-serif", imageStyle: "Natural light", logoRules: "Clear space of one logo height" }, audiences: [{ name: "Homeowners", description: "Owners of older houses" }], channels: [{ channel: "Facebook", notes: "Square images" }], disclaimers: [{ text: "Terms apply", appliesTo: "offers" }], notes: "" };

  it("starts empty, saves as a new version, and saving the same content again changes nothing", async () => {
    const t = await team();
    const empty = (await call(t.w.app, "GET", `${t.base}/brand-kit`, t.viewer.token)).body;
    expect(empty).toMatchObject({ exists: false, version: 0, status: "draft", approvedVersion: null });
    const v1 = (await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, KIT)).body;
    expect(v1).toMatchObject({ exists: true, version: 1, status: "draft", approvedVersion: null });
    expect(v1.kit.voice.descriptors).toEqual(["warm", "direct"]);
    expect((await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, KIT)).body.version).toBe(1);
    const v2 = (await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, { ...KIT, notes: "Updated" })).body;
    expect(v2.version).toBe(2);
    const versions = (await call(t.w.app, "GET", `${t.base}/brand-kit/versions`, t.viewer.token)).body.versions as Json[];
    expect(versions.map((v) => [v.version, v.changed])).toEqual([[1, ["Voice", "Look", "Audiences", "Channels", "Disclaimers"]], [2, ["Notes"]]]);
  });

  it("is strict: it cannot carry business facts, claims, unknown fields, bad colours or oversized text", async () => {
    const t = await team();
    const put = (body: Json) => call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, body);
    expect((await put({ ...KIT, services: ["AC repair"] })).status).toBe(400); // a business fact: belongs in the Business Brain
    expect((await put({ ...KIT, verifiedFacts: ["Licensed"] })).status).toBe(400);
    expect((await put({ ...KIT, voice: { ...KIT.voice, claims: ["best"] } })).status).toBe(400);
    expect((await put({ ...KIT, visual: { ...KIT.visual, colors: [{ name: "x", hex: "blue", role: "primary" }] } })).status).toBe(400);
    expect((await put({ ...KIT, visual: { ...KIT.visual, colors: [{ name: "x", hex: "#12345", role: "primary" }] } })).status).toBe(400);
    expect((await put({ ...KIT, notes: "x".repeat(1001) })).status).toBe(400);
    expect((await put({ ...KIT, voice: { ...KIT.voice, avoidTerms: Array.from({ length: 31 }, (_, i) => `t${i}`) } })).status).toBe(400);
    expect((await put({ ...KIT, notes: "bad\u0000text" })).status).toBe(400);
    expect((await call(t.w.app, "GET", `${t.base}/brain`, t.viewer.token)).body.brain).toBeNull(); // the Business Brain was not touched
  });

  it("reference assets must belong to this workspace", async () => {
    const t = await team();
    const mine = (await upload(t, t.operator)).body.id as string;
    expect((await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, { ...KIT, visual: { ...KIT.visual, referenceAssetIds: [mine] } })).status).toBe(200);
    const other = await person(t.w, "olga");
    const W2 = (await call(t.w.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const theirs = (await call(t.w.app, "POST", `/api/workspaces/${W2}/assets`, other.token, { name: "Logo", kind: "logo", source: "uploaded", rightsBasis: "owned", data: b64(png(5, 5)) })).body.id as string;
    const r = await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, { ...KIT, visual: { ...KIT.visual, referenceAssetIds: [theirs] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("unknown_reference_asset");
  });

  it("review: an operator submits, a different admin approves exactly that version, and an edit afterwards withdraws the approval without changing the approved content", async () => {
    const t = await team();
    await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, KIT);
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/submit`, t.operator.token)).body.status).toBe("needs_review");
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/submit`, t.operator.token)).body.error.code).toBe("already_submitted");
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.operator.token, { version: 1 })).status).toBe(403); // no brandkit.approve
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.admin.token, { version: 7 })).body.error.code).toBe("stale");
    const ok = (await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.admin.token, { version: 1 })).body;
    expect(ok).toMatchObject({ status: "approved", approvedVersion: 1, decision: { separation: "enforced" } });
    // edit after approval: a newer draft; the approved content is still the old one
    const edited = (await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, { ...KIT, voice: { ...KIT.voice, descriptors: ["bold"] } })).body;
    expect(edited).toMatchObject({ version: 2, status: "draft", approvedVersion: 1 });
    expect(edited.approved.voice.descriptors).toEqual(["warm", "direct"]);
    expect(edited.kit.voice.descriptors).toEqual(["bold"]);
    // approving requires a fresh submission of the new version
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.admin.token, { version: 2 })).body.error.code).toBe("not_submitted");
    const types = ((await call(t.w.app, "GET", `${t.base}/activity`, t.owner.token)).body as Json[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["brandkit.saved", "brandkit.submitted", "brandkit.approved"]));
  });

  it("separation of duties: the person who submitted cannot approve it, rejection needs a reason, and a rejected version can be fixed and resubmitted", async () => {
    const t = await team();
    await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.admin.token, KIT);
    await call(t.w.app, "POST", `${t.base}/brand-kit/submit`, t.admin.token);
    const self = await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.admin.token, { version: 1 });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_approval_not_allowed");
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/reject`, t.admin2.token, { version: 1 })).body.error.code).toBe("reason_required");
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/reject`, t.admin2.token, { version: 1, reason: "Colours unclear" })).body).toMatchObject({ status: "rejected", decision: { reason: "Colours unclear" } });
    await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.admin.token, { ...KIT, notes: "Fixed" });
    await call(t.w.app, "POST", `${t.base}/brand-kit/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/approve`, t.admin2.token, { version: 2 })).body.status).toBe("approved");
  });

  it("viewers read but cannot change; nothing leaks to another workspace", async () => {
    const t = await team();
    await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.operator.token, KIT);
    expect((await call(t.w.app, "GET", `${t.base}/brand-kit`, t.viewer.token)).status).toBe(200);
    expect((await call(t.w.app, "PUT", `${t.base}/brand-kit`, t.viewer.token, KIT)).status).toBe(403);
    expect((await call(t.w.app, "POST", `${t.base}/brand-kit/submit`, t.viewer.token)).status).toBe(403);
    const other = await person(t.w, "olga");
    expect((await call(t.w.app, "GET", `${t.base}/brand-kit`, other.token)).status).toBe(404);
    const W2 = (await call(t.w.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    expect((await call(t.w.app, "GET", `/api/workspaces/${W2}/brand-kit`, other.token)).body.exists).toBe(false);
  });

  it("in local single-token mode approval is allowed and recorded as not enforceable, never as separation", async () => {
    const w = boot("token");
    const { workspace, token } = createWorkspace(w.ctx, "Local Co");
    const base = `/api/workspaces/${workspace.id}`;
    await call(w.app, "PUT", `${base}/brand-kit`, token, KIT);
    await call(w.app, "POST", `${base}/brand-kit/submit`, token);
    const r = (await call(w.app, "POST", `${base}/brand-kit/approve`, token, { version: 1 })).body;
    expect(r.status).toBe("approved");
    expect(r.decision.separation).toBe("not_enforceable_token_mode");
  });
});

/* ---------------------------------------------------------------- assets */

describe("asset library: validated uploads", () => {
  it("accepts a PNG, JPEG and WebP and records what the bytes are, with provenance and rights, and a draft status", async () => {
    const t = await team();
    for (const [file, mime, w, h] of [[png(40, 30), "image/png", 40, 30], [jpeg(64, 48), "image/jpeg", 64, 48], [webp(120, 63), "image/webp", 120, 63]] as const) {
      const r = await upload(t, t.operator, { name: `File ${mime}`, kind: "image", licenseNote: "Own photo", usageRestrictions: "Not for print" }, file);
      expect(r.status).toBe(201);
      expect(r.body.versions[0]).toMatchObject({ version: 1, status: "draft", mime, width: w, height: h, sizeBytes: file.length, source: "uploaded", rights: { basis: "owned", licenseNote: "Own photo", usageRestrictions: "Not for print" }, createdByKind: "person" });
      expect(r.body.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.approvedVersion).toBeNull();
    }
    expect((await call(t.w.app, "GET", `${t.base}/assets`, t.viewer.token)).body.assets).toHaveLength(3);
  });

  it("decides the type from the bytes, not the name or the claim: scripts, SVG and disguised files are refused and nothing is stored", async () => {
    const t = await team();
    for (const [name, file] of [["logo.png", Buffer.from("<svg><script>alert(1)</script></svg>")], ["photo.jpg", Buffer.from("<?php system($_GET['c']); ?>")], ["a.png", Buffer.from("GIF89a....")], ["b.webp", Buffer.from("not an image at all")]] as const) {
      const r = await upload(t, t.operator, { name }, file);
      expect(r.status, name).toBe(415);
      expect(r.body.error.code).toBe("unsupported_file");
    }
    expect(t.w.store.files.size).toBe(0);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM assets").get()).toEqual({ n: 0 });
  });

  it("enforces size and format limits and rejects unknown or unsafe fields", async () => {
    const t = await team();
    expect((await upload(t, t.operator, { data: "not base64 !!!" })).status).toBe(400);
    expect((await upload(t, t.operator, { data: "" })).status).toBe(400);
    expect((await upload(t, t.operator, { kind: "video" })).status).toBe(400); // not supported yet
    expect((await upload(t, t.operator, { rightsBasis: "generated" })).status).toBe(400); // an upload cannot claim to be generated
    expect((await upload(t, t.operator, { storageKey: "../../x" })).status).toBe(400);
    expect((await upload(t, t.operator, { workspaceId: "ws_other" })).status).toBe(400);
    expect((await upload(t, t.operator, { name: "" })).status).toBe(400);
    expect((await upload(t, t.operator, { name: "bad\u0000name" })).status).toBe(400);
    expect((await upload(t, t.operator, { rightsExpiresAt: "tomorrow" })).status).toBe(400);
    expect((await upload(t, t.operator, { source: "imported" })).status).toBe(400); // an import must say where it came from
    expect((await upload(t, t.operator, { source: "imported", sourceNote: "Supplied by the client by email" })).status).toBe(201);
    const big = png(); const huge = Buffer.concat([big, Buffer.alloc(6 * 1024 * 1024)]);
    const r = await upload(t, t.operator, {}, huge);
    expect([400, 413]).toContain(r.status);
  });

  it("a per-file limit from the context is honoured, and the workspace quota and asset count stop further uploads", async () => {
    const w = boot("token", { maxFileBytes: 100, maxWorkspaceBytes: 150, maxAssets: 2 });
    const { workspace, token } = createWorkspace(w.ctx, "Quota Co");
    const base = `/api/workspaces/${workspace.id}`;
    const up = (file: Buffer, name = "L") => call(w.app, "POST", `${base}/assets`, token, { name, kind: "logo", source: "uploaded", rightsBasis: "owned", data: b64(file) });
    expect((await up(Buffer.concat([png(), Buffer.alloc(200)]))).body.error.code).toBe("file_too_large");
    expect((await up(png(3, 3, 1))).status).toBe(201); // 42 bytes
    expect((await up(png(3, 3, 2))).status).toBe(201);
    expect((await up(png(3, 3, 3))).body.error.code).toBe("too_many_assets");
    const full = boot("token", { maxWorkspaceBytes: 60 });
    const ws2 = createWorkspace(full.ctx, "Full Co");
    const b2 = `/api/workspaces/${ws2.workspace.id}`;
    const up2 = (f: Buffer) => call(full.app, "POST", `${b2}/assets`, ws2.token, { name: "L", kind: "logo", source: "uploaded", rightsBasis: "owned", data: b64(f) });
    expect((await up2(png(3, 3, 1))).status).toBe(201);
    expect((await up2(png(3, 3, 2))).body.error.code).toBe("workspace_storage_full");
    expect(full.store.files.size).toBe(1);
  });

  it("reports an identical file already in the library without blocking it", async () => {
    const t = await team();
    const first = (await upload(t, t.operator, { name: "Logo A" })).body;
    const second = (await upload(t, t.operator, { name: "Logo B" })).body;
    expect(second.duplicateOf).toEqual([first.id]);
    expect(first.duplicateOf).toEqual([]);
    expect((await call(t.w.app, "GET", `${t.base}/assets/${first.id}`, t.viewer.token)).body.duplicateOf).toEqual([second.id]);
  });

  it("never returns the storage key or any path, and audit entries hold no file content", async () => {
    const t = await team();
    const r = await upload(t, t.operator, {}, png(10, 10));
    expect(JSON.stringify(r.body)).not.toMatch(/storage|\.png"|\/v1|ws_[a-z0-9]{10}\//i);
    const audits = JSON.stringify(t.w.db.prepare("SELECT detail FROM audit_events WHERE type LIKE 'asset.%'").all());
    expect(audits).not.toContain(b64(png(10, 10)).slice(0, 20));
    expect(audits).toContain("image/png"); // metadata is recorded
  });
});

describe("asset library: versions, rights and review", () => {
  it("a replacement is a new version; the old file and its approval stay reproducible until the new one is approved", async () => {
    const t = await team();
    const a = (await upload(t, t.admin)).body;
    await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/1/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/1/approve`, t.admin2.token, {})).body.approvedVersion).toBe(1);
    const v2 = (await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions`, t.operator.token, { source: "uploaded", rightsBasis: "owned", data: b64(png(8, 8, 9)) })).body;
    expect(v2).toMatchObject({ currentVersion: 2, approvedVersion: 1, status: "draft" }); // the new draft does NOT replace the approved version
    expect(v2.versions.map((v: Json) => [v.version, v.status, v.parentVersion])).toEqual([[1, "approved", null], [2, "draft", 1]]);
    const f1 = await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token);
    expect(Buffer.from(f1.raw).equals(png())).toBe(true); // version 1 is exactly what was approved
    await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/2/submit`, t.operator.token);
    const after = (await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/2/approve`, t.admin2.token, {})).body;
    expect(after).toMatchObject({ approvedVersion: 2 });
    expect(after.versions.map((v: Json) => v.status)).toEqual(["superseded", "approved"]);
    expect(Buffer.from((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token)).raw).equals(png())).toBe(true); // still retrievable
    expect(t.w.store.files.size).toBe(2);
  });

  it("approval needs stated rights, an unexpired licence, a second person, and a version that is actually waiting for review", async () => {
    const t = await team();
    const unknown = (await upload(t, t.admin, { rightsBasis: "unknown" }, png(2, 2, 1))).body;
    expect((await call(t.w.app, "POST", `${t.base}/assets/${unknown.id}/versions/1/approve`, t.admin2.token, {})).body.error.code).toBe("not_submitted");
    await call(t.w.app, "POST", `${t.base}/assets/${unknown.id}/versions/1/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${unknown.id}/versions/1/approve`, t.admin2.token, {})).body.error.code).toBe("rights_unknown");
    const expired = (await upload(t, t.admin, { rightsBasis: "licensed", rightsExpiresAt: "2000-01-01" }, png(2, 2, 2))).body;
    await call(t.w.app, "POST", `${t.base}/assets/${expired.id}/versions/1/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${expired.id}/versions/1/approve`, t.admin2.token, {})).body.error.code).toBe("rights_expired");
    const own = (await upload(t, t.admin, {}, png(2, 2, 3))).body;
    await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/approve`, t.admin.token, {})).body.error.code).toBe("self_approval_not_allowed");
    expect((await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/approve`, t.operator.token, {})).status).toBe(403); // no assets.review
    expect((await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/reject`, t.admin2.token, {})).body.error.code).toBe("reason_required");
    const rej = (await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/reject`, t.admin2.token, { reason: "Blurry" })).body;
    expect(rej.versions[0]).toMatchObject({ status: "rejected", review: { note: "Blurry" } });
    expect((await call(t.w.app, "POST", `${t.base}/assets/${own.id}/versions/1/submit`, t.admin.token)).body.versions[0].status).toBe("needs_review"); // a rejected version can be resubmitted
  });

  it("an older version cannot be approved once a newer one is approved", async () => {
    const t = await team();
    const a = (await upload(t, t.admin)).body;
    await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions`, t.admin.token, { source: "uploaded", rightsBasis: "owned", data: b64(png(5, 5, 4)) });
    for (const v of [1, 2]) await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/${v}/submit`, t.admin.token);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/2/approve`, t.admin2.token, {})).status).toBe(200);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions/1/approve`, t.admin2.token, {})).body.error.code).toBe("newer_version_approved");
  });

  it("archiving hides an asset from the default list, keeps its files, and blocks further changes", async () => {
    const t = await team();
    const a = (await upload(t, t.operator)).body;
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/archive`, t.operator.token)).status).toBe(403); // admin+
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/archive`, t.admin.token)).body.archived).toBe(true);
    expect((await call(t.w.app, "GET", `${t.base}/assets`, t.viewer.token)).body.assets).toHaveLength(0);
    expect((await call(t.w.app, "GET", `${t.base}/assets?archived=true`, t.viewer.token)).body.assets).toHaveLength(1);
    expect(t.w.store.files.size).toBe(1);
    expect((await call(t.w.app, "POST", `${t.base}/assets/${a.id}/versions`, t.operator.token, { source: "uploaded", rightsBasis: "owned", data: b64(png(9, 9)) })).body.error.code).toBe("asset_archived");
  });

  it("roles: a viewer can look and download but not upload; an operator uploads but cannot approve or archive", async () => {
    const t = await team();
    expect((await upload(t, t.viewer)).status).toBe(403);
    const a = (await upload(t, t.operator)).body;
    expect((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token)).status).toBe(200);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM assets").get()).toEqual({ n: 1 });
  });
});

describe("asset files: downloads, isolation and integrity", () => {
  it("serves the exact bytes with the type read from the file and headers that stop a file from running as anything", async () => {
    const t = await team();
    const a = (await upload(t, t.operator, {}, jpeg(30, 20))).body;
    const f = await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token);
    expect(f.status).toBe(200);
    expect(Buffer.from(f.raw).equals(jpeg(30, 20))).toBe(true);
    expect(f.headers["content-type"]).toBe("image/jpeg");
    expect(f.headers["x-content-type-options"]).toBe("nosniff");
    expect(f.headers["cache-control"]).toBe("private, no-store");
    expect(f.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(String(f.headers["content-disposition"])).toBe('inline; filename="asset.jpg"');
  });

  it("another workspace, an unknown asset, a bad version and a missing credential all get nothing", async () => {
    const t = await team();
    const a = (await upload(t, t.operator)).body;
    const other = await person(t.w, "olga");
    const W2 = (await call(t.w.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const mine = `${t.base}/assets/${a.id}/versions/1/file`;
    expect((await call(t.w.app, "GET", mine, other.token)).status).toBe(404); // not a member
    expect((await call(t.w.app, "GET", `/api/workspaces/${W2}/assets/${a.id}/versions/1/file`, other.token)).status).toBe(404); // own workspace, someone else's asset id
    expect((await call(t.w.app, "GET", `/api/workspaces/${W2}/assets/${a.id}`, other.token)).status).toBe(404);
    expect((await call(t.w.app, "POST", `/api/workspaces/${W2}/assets/${a.id}/versions/1/approve`, other.token, {})).status).toBe(404);
    expect((await call(t.w.app, "POST", `/api/workspaces/${W2}/assets/${a.id}/archive`, other.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", mine)).status).toBe(401);
    expect((await call(t.w.app, "GET", `${t.base}/assets/nope/versions/1/file`, t.viewer.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/9/file`, t.viewer.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/abc/file`, t.viewer.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/-1/file`, t.viewer.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", `${t.base}/assets/..%2F..%2Fetc/versions/1/file`, t.viewer.token)).status).toBe(404);
    expect((await call(t.w.app, "GET", `/api/workspaces/${W2}/assets`, other.token)).body.assets).toEqual([]);
  });

  it("a file whose bytes no longer match their record is refused, and a missing file says so", async () => {
    const t = await team();
    const a = (await upload(t, t.operator)).body;
    const key = (t.w.db.prepare("SELECT storage_key k FROM asset_versions WHERE asset_id = ?").get(a.id) as { k: string }).k;
    t.w.store.files.set(key, png(9, 9, 7)); // someone swapped the file behind the app's back
    const bad = await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token);
    expect(bad.status).toBe(500);
    expect(bad.body.error.code).toBe("asset_integrity");
    t.w.store.files.delete(key);
    expect((await call(t.w.app, "GET", `${t.base}/assets/${a.id}/versions/1/file`, t.viewer.token)).status).toBe(410);
  });

  it("a failed database write leaves no orphan file behind", async () => {
    const t = await team();
    t.w.db.exec("CREATE TRIGGER fail_asset BEFORE INSERT ON asset_versions BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const r = await upload(t, t.operator);
    expect(r.status).toBe(500);
    expect(t.w.store.files.size).toBe(0);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM assets").get()).toEqual({ n: 0 });
  });

  it("local single-token mode: the token may upload and approve, and the approval is recorded as not enforceable", async () => {
    const w = boot("token");
    const { workspace, token } = createWorkspace(w.ctx, "Local Co");
    const base = `/api/workspaces/${workspace.id}`;
    const a = (await call(w.app, "POST", `${base}/assets`, token, { name: "Logo", kind: "logo", source: "uploaded", rightsBasis: "owned", data: b64(png()) })).body;
    await call(w.app, "POST", `${base}/assets/${a.id}/versions/1/submit`, token);
    const done = (await call(w.app, "POST", `${base}/assets/${a.id}/versions/1/approve`, token, {})).body;
    expect(done.versions[0]).toMatchObject({ status: "approved", review: { separation: "not_enforceable_token_mode" } });
  });
});
