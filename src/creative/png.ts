import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

/** A tiny PNG writer and a strict PNG checker. Used by the mock image provider and by the render validation step. No dependency, no native code. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `rgb` is width*height*3 bytes, row by row. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("pixel data does not match the size");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour, no interlace
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) { raw[y * (1 + width * 3)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (1 + width * 3) + 1); }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export type PngCheck = { ok: true; width: number; height: number } | { ok: false; reason: string };

/**
 * Walks every chunk and checks the signature, each chunk's CRC, a single IHDR first, an IEND last, and (for 8-bit truecolour and greyscale files the mock
 * provider writes) that the decompressed pixel data is exactly the size the header promises. A truncated or damaged file fails here instead of being marked complete.
 */
export function checkPng(b: Buffer): PngCheck {
  if (b.length < 45 || !b.subarray(0, 8).equals(SIGNATURE)) return { ok: false, reason: "not_a_png" };
  let i = 8; let width = 0; let height = 0; let colour = -1; let depth = 0; let sawEnd = false; const idat: Buffer[] = [];
  for (let n = 0; i + 12 <= b.length; n++) {
    const len = b.readUInt32BE(i);
    if (len > b.length || i + 12 + len > b.length) return { ok: false, reason: "truncated" };
    const type = b.toString("ascii", i + 4, i + 8);
    const data = b.subarray(i + 8, i + 8 + len);
    if (crc32(b.subarray(i + 4, i + 8 + len)) !== b.readUInt32BE(i + 8 + len)) return { ok: false, reason: "crc_mismatch" };
    if (n === 0) { if (type !== "IHDR" || len !== 13) return { ok: false, reason: "no_header" }; width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; colour = data[9]!; }
    else if (type === "IHDR") return { ok: false, reason: "duplicate_header" };
    if (type === "IDAT") idat.push(Buffer.from(data));
    i += 12 + len;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd) return { ok: false, reason: "truncated" };
  if (i !== b.length) return { ok: false, reason: "trailing_data" };
  if (idat.length === 0) return { ok: false, reason: "no_pixels" };
  if (width < 1 || height < 1) return { ok: false, reason: "bad_size" };
  const channels = colour === 2 ? 3 : colour === 0 ? 1 : colour === 6 ? 4 : 0;
  if (channels && depth === 8) {
    let raw: Buffer;
    try { raw = inflateSync(Buffer.concat(idat)); } catch { return { ok: false, reason: "bad_pixel_data" }; }
    if (raw.length !== height * (1 + width * channels)) return { ok: false, reason: "wrong_pixel_count" };
  }
  return { ok: true, width, height };
}

export const sha256Hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
