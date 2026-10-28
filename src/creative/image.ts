import { createHash } from "node:crypto";
import { encodePng } from "./png.js";
import { RATIOS, RATIO_IDS, type RatioId } from "./ratios.js";

/**
 * Image generation behind a small, capability-aware interface. A provider says what it can do (formats, ratios, whether it renders text, whether it is a mock);
 * the app asks only for what the provider declared. THERE IS NO LIVE IMAGE PROVIDER in this release: the only implementation is the offline mock below,
 * which draws a deterministic placeholder from the concept's colours. It makes no network call, spends nothing, and its output is labelled as a mock everywhere.
 *
 * Code outside this folder never imports a vendor SDK; a live provider would implement ImageProvider here and be added deliberately, with its own safety review.
 */
export interface Palette { background: string; foreground: string; accent: string }

export interface ImageProviderCapabilities {
  id: string;
  label: string;
  model: string;
  /** True for anything that does not produce real creative work. The screens say so next to every image it made. */
  mock: boolean;
  /** Always true for a provider that can be called without leaving this computer. */
  offline: boolean;
  ratios: readonly RatioId[];
  formats: readonly ("png")[];
  /** Can the provider put legible words in the picture? Mock: no, so overlay text is never promised from the picture. */
  rendersText: boolean;
  /** Does the same request give the same picture? */
  deterministic: boolean;
  note: string;
}

export interface ImageRequest { ratio: RatioId; width: number; height: number; seed: string; prompt: string; palette: Palette; signal?: AbortSignal | undefined }
export interface ImageResult { bytes: Buffer; mime: "image/png" }

/** A failure the provider reports. `retryable` says whether trying again can help (a timeout can; a refusal cannot). */
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); this.name = "ProviderError"; }
}

export interface ImageProvider {
  readonly capabilities: ImageProviderCapabilities;
  generate(req: ImageRequest): Promise<ImageResult>;
}

/** Failure injection for tests and for trying the failure screens by hand. Never set by the running app. */
export interface MockImageFaults {
  /** Fail this many calls with a retryable error, then succeed. */
  transientFailures?: number;
  /** Refuse every call with a non-retryable error. */
  refuse?: boolean;
  /** Return bytes that look like a PNG but are cut short. */
  truncate?: boolean;
  /** Return a valid picture of the wrong size. */
  wrongSize?: boolean;
  /** Return something that is not an image. */
  notAnImage?: boolean;
  /** Wait this long (ms, honouring the abort signal) before answering. */
  delayMs?: number;
}

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export class MockImageProvider implements ImageProvider {
  readonly capabilities: ImageProviderCapabilities = {
    id: "mock-image", label: "Offline placeholder", model: "mock-image-1", mock: true, offline: true, ratios: RATIO_IDS, formats: ["png"], rendersText: false, deterministic: true,
    note: "A placeholder drawn on this computer from your colours. It is not real artwork, contains no words, and no image service was contacted.",
  };
  /** Mutable on purpose: tests set it. A fresh provider has no faults. */
  faults: MockImageFaults = {};
  calls = 0;

  async generate(req: ImageRequest): Promise<ImageResult> {
    this.calls++;
    const f = this.faults;
    if (f.delayMs) await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, f.delayMs);
      req.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new ProviderError("aborted", "The render was cancelled", false)); }, { once: true });
    });
    if (req.signal?.aborted) throw new ProviderError("aborted", "The render was cancelled", false);
    if (f.refuse) throw new ProviderError("provider_refused", "The image provider refused this request", false);
    if (f.transientFailures && f.transientFailures > 0) { f.transientFailures--; throw new ProviderError("provider_unavailable", "The image provider did not answer", true); }
    if (f.notAnImage) return { bytes: Buffer.from("<html>not an image</html>"), mime: "image/png" };
    let { width, height } = req;
    if (f.wrongSize) { width = Math.max(8, width - 40); }
    const png = draw(width, height, req.seed, req.palette);
    return { bytes: f.truncate ? png.subarray(0, Math.floor(png.length / 2)) : png, mime: "image/png" };
  }
}

/** A seeded placeholder: background, a large accent shape, a foreground band, and a few "text lines" as plain bars. Deterministic for a seed. */
function draw(w: number, h: number, seed: string, p: Palette): Buffer {
  const rnd = createHash("sha256").update(seed).digest();
  const bg = hex(p.background); const fg = hex(p.foreground); const ac = hex(p.accent);
  const px = new Uint8Array(w * h * 3);
  const cx = Math.floor(w * (0.3 + (rnd[0]! / 255) * 0.4)); const cy = Math.floor(h * (0.25 + (rnd[1]! / 255) * 0.3)); const r = Math.floor(Math.min(w, h) * (0.22 + (rnd[2]! / 255) * 0.12));
  const bandTop = Math.floor(h * 0.68);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = bg;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) c = ac;
    else if (y >= bandTop && y < bandTop + 6) c = ac;
    else if (y >= bandTop + 6) c = fg;
    // three "text lines" inside the band: bars in the background colour
    if (y >= bandTop + 6) for (let k = 0; k < 3; k++) { const ty = bandTop + 22 + k * 22; if (y >= ty && y < ty + 9 && x > w * 0.08 && x < w * (0.9 - k * 0.2)) c = bg; }
    const o = (y * w + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
  return encodePng(w, h, px);
}

export const RATIO_SIZE = (r: RatioId): { width: number; height: number } => ({ width: RATIOS[r].width, height: RATIOS[r].height });
