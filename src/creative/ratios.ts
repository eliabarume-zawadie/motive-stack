/**
 * The image formats (aspect ratios) a creative can be made in. The sizes here are the sizes the MOCK provider produces: small on purpose, because a mock
 * render is a placeholder. A real provider would declare its own output sizes in its capabilities; the ratio is what the rest of the app relies on.
 */
export const RATIO_IDS = ["1:1", "4:5", "9:16", "1.91:1"] as const;
export type RatioId = (typeof RATIO_IDS)[number];

export interface RatioSpec { id: RatioId; label: string; use: string; width: number; height: number; value: number }

const spec = (id: RatioId, label: string, use: string, width: number, height: number): RatioSpec => ({ id, label, use, width, height, value: width / height });
export const RATIOS: Record<RatioId, RatioSpec> = {
  "1:1": spec("1:1", "Square", "Feed", 512, 512),
  "4:5": spec("4:5", "Portrait", "Feed (tall)", 400, 500),
  "9:16": spec("9:16", "Vertical", "Stories and Reels", 288, 512),
  "1.91:1": spec("1.91:1", "Landscape", "Link ads and Feed (wide)", 764, 400),
};
export const isRatioId = (v: unknown): v is RatioId => typeof v === "string" && Object.prototype.hasOwnProperty.call(RATIOS, v);

/** A width and height "match" a ratio when they are within 1% of it, so a re-encoded import is not refused over a pixel. */
export const matchesRatio = (width: number, height: number, ratio: RatioId): boolean => height > 0 && Math.abs(width / height - RATIOS[ratio].value) / RATIOS[ratio].value <= 0.01;
