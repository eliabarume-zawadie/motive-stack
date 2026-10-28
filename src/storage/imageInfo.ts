/**
 * What a file REALLY is, read from its own bytes. The declared type and the file name are never trusted: a script saved as "logo.png" is refused, and the
 * type that is stored and later served comes from here. Only PNG, JPEG and WebP are accepted (no SVG: it can carry script). Dimensions come from the
 * headers; a file whose header cannot be read is refused rather than guessed.
 */
export interface ImageInfo { mime: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp"; width: number; height: number }

export const MAX_DIMENSION = 12000; // pixels per side: larger is almost certainly a mistake or a decompression bomb

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readImageInfo(b: Buffer): ImageInfo | null {
  const info = png(b) ?? jpeg(b) ?? webp(b);
  if (!info) return null;
  if (info.width < 1 || info.height < 1 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) return null;
  return info;
}

function png(b: Buffer): ImageInfo | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG)) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR" || b.readUInt32BE(8) !== 13) return null;
  return { mime: "image/png", ext: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1]!;
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]!; } // fill bytes
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // markers with no length
    if (m === 0xd9 || m === 0xda) return null; // end of image or start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const sof = (m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) return i + 9 <= b.length ? { mime: "image/jpeg", ext: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) } : null;
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return { mime: "image/webp", ext: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: "image/webp", ext: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { mime: "image/webp", ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
