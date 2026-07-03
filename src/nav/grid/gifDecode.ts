/**
 * Minimal, dependency-free GIF decoder (first frame only).
 *
 * The Unitopia overworld maps ship as palette-indexed GIF89a images. We only
 * need the pixel indices + palette to classify 12×12 terrain tiles, so this
 * parses the header, the global color table and the first image descriptor and
 * LZW-decompresses it — no animation, no interlacing beyond de-interlace, no
 * native image library (the project intentionally has none).
 */

export interface DecodedGif {
  width: number;
  height: number;
  palette: [number, number, number][];
  /** Row-major palette indices, length = width * height. */
  pixels: Uint8Array;
}

export function decodeGif(buf: Buffer): DecodedGif {
  const sig = buf.toString("ascii", 0, 3);
  if (sig !== "GIF") throw new Error("not a GIF");
  let p = 6;
  const width = buf.readUInt16LE(p); p += 2;
  const height = buf.readUInt16LE(p); p += 2;
  const packed = buf[p++]; p += 2; // skip bg color index + pixel aspect ratio
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 7);
  const palette: [number, number, number][] = [];
  if (gctFlag) {
    for (let i = 0; i < gctSize; i++) { palette.push([buf[p], buf[p + 1], buf[p + 2]]); p += 3; }
  }

  let pixels: Uint8Array | null = null;
  let localPalette: [number, number, number][] | null = null;
  let interlaced = false;
  let imgW = 0, imgH = 0;
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) { // extension: skip label + sub-blocks
      p++;
      while (buf[p] !== 0) p += buf[p] + 1;
      p++;
    } else if (b === 0x2c) { // image descriptor
      p += 4; // left/top
      imgW = buf.readUInt16LE(p); p += 2;
      imgH = buf.readUInt16LE(p); p += 2;
      const ipacked = buf[p++];
      interlaced = (ipacked & 0x40) !== 0;
      if (ipacked & 0x80) { // local color table — overrides the global one
        const lctSize = 2 << (ipacked & 7);
        localPalette = [];
        for (let i = 0; i < lctSize; i++) { localPalette.push([buf[p], buf[p + 1], buf[p + 2]]); p += 3; }
      }
      const minCode = buf[p++];
      const chunks: Buffer[] = [];
      while (buf[p] !== 0) { const s = buf[p++]; chunks.push(buf.subarray(p, p + s)); p += s; }
      p++;
      pixels = lzwDecode(Buffer.concat(chunks), minCode, imgW * imgH);
      break; // first frame is enough
    } else break;
  }
  if (!pixels) throw new Error("no image data in GIF");
  if (interlaced) pixels = deinterlace(pixels, imgW, imgH);
  return { width: imgW || width, height: imgH || height, palette: localPalette ?? palette, pixels };
}

function lzwDecode(data: Buffer, minCode: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let dict: number[][] = [];
  let next = eoi + 1;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = []; dict[eoi] = [];
    next = eoi + 1; codeSize = minCode + 1;
  };
  reset();
  let bitPos = 0, oi = 0;
  let prev: number[] | null = null;
  const total = data.length * 8;
  const read = () => {
    let v = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[bitPos >> 3] >> (bitPos & 7)) & 1;
      v |= bit << i; bitPos++;
    }
    return v;
  };
  while (bitPos + codeSize <= total) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < next && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const px of entry) { if (oi < pixelCount) out[oi++] = px; }
    if (prev) {
      dict[next++] = [...prev, entry[0]];
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

/** Reorder GIF interlaced rows (passes 0,4,2,1 offsets) into top-to-bottom. */
function deinterlace(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let row = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < h; y += step) {
      out.set(src.subarray(row * w, row * w + w), y * w);
      row++;
    }
  }
  return out;
}
