import type { ImageInfo } from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF = Buffer.from("RIFF", "ascii");
const WEBP = Buffer.from("WEBP", "ascii");

function readU32BE(buf: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buf.length) return null;
  return buf.readUInt32BE(offset);
}

function readU16BE(buf: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 2 > buf.length) return null;
  return buf.readUInt16BE(offset);
}

function readU32LE(buf: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buf.length) return null;
  return buf.readUInt32LE(offset);
}

function clampImageDimensions(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  // Hard cap to avoid pathological metadata; we never allocate based on this.
  const maxDim = 20_000;
  if (width > maxDim || height > maxDim) return null;
  return { width: Math.floor(width), height: Math.floor(height) };
}

function parsePngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 8 + 4 + 4 + 13) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunkType = buf.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") return null;
  const width = readU32BE(buf, 16);
  const height = readU32BE(buf, 20);
  if (width == null || height == null) return null;
  return clampImageDimensions(width, height);
}

function parseJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let offset = 2;

  // Walk segments until SOF marker.
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      // Invalid marker alignment.
      return null;
    }
    // Skip fill bytes 0xFF.
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) return null;
    const marker = buf[offset]!;
    offset++;

    // Standalone markers without length.
    if (marker === 0xd9) return null; // EOI before SOF
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    const segLen = readU16BE(buf, offset);
    if (segLen == null || segLen < 2) return null;
    const segStart = offset + 2;
    const segEnd = segStart + (segLen - 2);
    if (segEnd > buf.length) return null;

    const isSof =
      marker === 0xc0 || // SOF0
      marker === 0xc1 || // SOF1
      marker === 0xc2 || // SOF2
      marker === 0xc3 || // SOF3
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;

    if (isSof) {
      // SOF segment: [precision:1][height:2][width:2]...
      if (segStart + 1 + 2 + 2 > buf.length) return null;
      const height = readU16BE(buf, segStart + 1);
      const width = readU16BE(buf, segStart + 3);
      if (width == null || height == null) return null;
      return clampImageDimensions(width, height);
    }

    offset = segEnd;
  }

  return null;
}

function parseWebpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 16) return null;
  if (!buf.subarray(0, 4).equals(RIFF)) return null;
  if (!buf.subarray(8, 12).equals(WEBP)) return null;

  const chunkType = buf.subarray(12, 16).toString("ascii");
  const chunkSize = readU32LE(buf, 16);
  if (chunkSize == null) return null;
  const chunkDataOffset = 20;
  if (chunkDataOffset + chunkSize > buf.length) return null;

  if (chunkType === "VP8X") {
    // VP8X: [features:1][reserved:3][width-1:3][height-1:3]
    if (chunkDataOffset + 10 > buf.length) return null;
    const w0 = buf[chunkDataOffset + 4]!;
    const w1 = buf[chunkDataOffset + 5]!;
    const w2 = buf[chunkDataOffset + 6]!;
    const h0 = buf[chunkDataOffset + 7]!;
    const h1 = buf[chunkDataOffset + 8]!;
    const h2 = buf[chunkDataOffset + 9]!;
    const width = 1 + (w0 | (w1 << 8) | (w2 << 16));
    const height = 1 + (h0 | (h1 << 8) | (h2 << 16));
    return clampImageDimensions(width, height);
  }

  if (chunkType === "VP8L") {
    // VP8L: signature 0x2f then 4 bytes with width/height packed (14 bits each)
    if (chunkDataOffset + 5 > buf.length) return null;
    if (buf[chunkDataOffset] !== 0x2f) return null;
    const b0 = buf[chunkDataOffset + 1]!;
    const b1 = buf[chunkDataOffset + 2]!;
    const b2 = buf[chunkDataOffset + 3]!;
    const b3 = buf[chunkDataOffset + 4]!;
    const bits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return clampImageDimensions(width, height);
  }

  if (chunkType === "VP8 ") {
    // Lossy VP8 bitstream frame header: start code 0x9d 0x01 0x2a
    if (chunkDataOffset + 10 > buf.length) return null;
    const startCode = buf.subarray(chunkDataOffset + 3, chunkDataOffset + 6);
    if (!startCode.equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null;
    const widthRaw = buf.readUInt16LE(chunkDataOffset + 6);
    const heightRaw = buf.readUInt16LE(chunkDataOffset + 8);
    const width = widthRaw & 0x3fff;
    const height = heightRaw & 0x3fff;
    return clampImageDimensions(width, height);
  }

  return null;
}

export function detectImageInfo(buf: Buffer): ImageInfo | null {
  const png = parsePngSize(buf);
  if (png) {
    return {
      format: "png",
      contentType: "image/png",
      ext: "png",
      width: png.width,
      height: png.height,
    };
  }
  const jpeg = parseJpegSize(buf);
  if (jpeg) {
    return {
      format: "jpeg",
      contentType: "image/jpeg",
      ext: "jpg",
      width: jpeg.width,
      height: jpeg.height,
    };
  }
  const webp = parseWebpSize(buf);
  if (webp) {
    return {
      format: "webp",
      contentType: "image/webp",
      ext: "webp",
      width: webp.width,
      height: webp.height,
    };
  }
  return null;
}

