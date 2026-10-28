import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Where asset FILES live. The database holds only metadata and provenance; the bytes sit behind this small, provider-neutral interface so a managed object
 * store can replace the local folder later without touching the rest of the app. Nothing here is a production storage claim: the local store is a
 * development folder with no backup, retention or access-control story beyond the application's own checks.
 *
 * Rules every implementation follows:
 *  - the caller supplies a KEY built by assetKey() from validated ids and a fixed extension, never a user-supplied name;
 *  - a key is never overwritten (every version has its own key, so an approved version stays reproducible);
 *  - bytes are returned only for a key the application asks for after it has checked workspace ownership and permission.
 */
export interface AssetStore {
  readonly kind: string;
  /** Stores bytes under a new key. Throws if the key already exists. */
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Removes a file this process just wrote when the database insert that should have recorded it failed. Not used for retention. */
  remove(key: string): Promise<void>;
}

const SEGMENT = /^[a-z0-9_]{1,64}$/;
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "webp"]);

/** workspace/asset/version.ext. Every part is checked, so a key can never contain a path separator, a dot-dot or anything outside the pattern. */
export function assetKey(workspaceId: string, assetId: string, version: number, ext: string): string {
  if (!SEGMENT.test(workspaceId) || !SEGMENT.test(assetId)) throw new Error("invalid asset key");
  if (!Number.isInteger(version) || version < 1 || version > 99999) throw new Error("invalid asset key");
  if (!ASSET_EXTENSIONS.has(ext)) throw new Error("invalid asset key");
  return `${workspaceId}/${assetId}/v${version}.${ext}`;
}

const KEY_RE = /^[a-z0-9_]{1,64}\/[a-z0-9_]{1,64}\/v[0-9]{1,5}\.(png|jpg|webp)$/;
export const isValidKey = (key: string): boolean => KEY_RE.test(key);

/** A folder on this computer (default `data/assets`, git-ignored). The resolved path must stay inside the root, whatever the key says. */
export class LocalAssetStore implements AssetStore {
  readonly kind = "local-folder";
  private readonly root: string;
  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }
  private pathOf(key: string): string {
    if (!isValidKey(key)) throw new Error("invalid asset key");
    const p = resolve(this.root, ...key.split("/"));
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error("invalid asset key"); // belt and braces: never leave the root
    return p;
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: "wx" }); // 'wx': fails if the file exists, so a version's file is never replaced
  }
  async get(key: string): Promise<Buffer | null> {
    try { return await readFile(this.pathOf(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/** In memory: the default for tests and for any context that was not given a folder, so nothing is written to disk by accident. */
export class MemoryAssetStore implements AssetStore {
  readonly kind = "memory";
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> {
    if (!isValidKey(key)) throw new Error("invalid asset key");
    if (this.files.has(key)) throw new Error("asset key exists");
    this.files.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer | null> {
    if (!isValidKey(key)) throw new Error("invalid asset key");
    const b = this.files.get(key);
    return b ? Buffer.from(b) : null;
  }
  async remove(key: string): Promise<void> {
    this.files.delete(key);
  }
}
