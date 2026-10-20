/**
 * 8-bit uncompressed Windows BMP: the format of every retail UI bitmap and of
 * custom mission-briefing images (which must be exactly 220x160).
 *
 * The game copies the pixel rows to the screen in the order they are stored,
 * first row at the top, whatever the header's height sign says. (A standard
 * viewer shows these files upside down.) Both functions here use that order.
 */
import { ByteReader, ByteWriter, check } from '../util/binary.ts';

export interface IndexedBitmap {
  width: number;
  height: number;
  /** 256 RGB triples. */
  palette: Uint8Array;
  /** width x height indices in the order the game shows them: top row first (= file order). */
  pixels: Uint8Array;
}

export const BRIEFING_IMAGE_WIDTH = 220;
export const BRIEFING_IMAGE_HEIGHT = 160;

export function decodeBmp(bytes: Uint8Array): IndexedBitmap {
  const r = new ByteReader(bytes);
  check(bytes.length >= 54 && r.cstring(0, 2) === 'BM', 'Not a BMP file');
  const pixelOffset = r.u32(10);
  const headerSize = r.u32(14);
  const width = r.i32(18);
  const rawHeight = r.i32(22);
  const bpp = r.u16(28);
  const compression = r.u32(30);
  check(headerSize >= 40, 'Unsupported BMP header');
  check(bpp === 8 && compression === 0, 'Only uncompressed 8-bit BMP files are supported');
  check(width > 0 && width <= 4096 && rawHeight !== 0 && Math.abs(rawHeight) <= 4096, 'BMP dimensions are out of range');
  const height = Math.abs(rawHeight);
  const colors = r.u32(46) || 256;
  check(colors <= 256, 'BMP palette has more than 256 entries');
  const paletteAt = 14 + headerSize;
  const palette = new Uint8Array(768);
  for (let i = 0; i < colors; i++) {
    palette[i * 3] = r.u8(paletteAt + i * 4 + 2);
    palette[i * 3 + 1] = r.u8(paletteAt + i * 4 + 1);
    palette[i * 3 + 2] = r.u8(paletteAt + i * 4);
  }
  const stride = (width + 3) & ~3;
  check(pixelOffset + stride * height <= bytes.length, 'BMP pixel data is truncated');
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(bytes.subarray(pixelOffset + y * stride, pixelOffset + y * stride + width), y * width);
  return { width, height, palette, pixels };
}

/** Write an 8-bit BMP with a full 256-entry palette, rows in the game's order (top row first). */
export function encodeBmp(bitmap: IndexedBitmap): Uint8Array {
  const { width, height, palette, pixels } = bitmap;
  check(pixels.length === width * height, 'BMP pixel count does not match its dimensions');
  check(palette.length === 768, 'BMP palette must have 256 RGB entries');
  const stride = (width + 3) & ~3;
  const pixelOffset = 14 + 40 + 1024;
  const w = new ByteWriter(pixelOffset + stride * height);
  w.u8(0x42).u8(0x4d).u32(pixelOffset + stride * height).u32(0).u32(pixelOffset);
  w.u32(40).u32(width).u32(height).u16(1).u16(8).u32(0).u32(stride * height).u32(2835).u32(2835).u32(256).u32(0);
  for (let i = 0; i < 256; i++) w.u8(palette[i * 3 + 2]).u8(palette[i * 3 + 1]).u8(palette[i * 3]).u8(0);
  const padding = stride - width;
  for (let y = 0; y < height; y++) {
    w.bytes(pixels.subarray(y * width, (y + 1) * width));
    if (padding) w.zeros(padding);
  }
  return w.finish();
}

/** The same bitmap with its rows in the opposite order. */
export function flipBmpRows(bytes: Uint8Array): Uint8Array {
  const bitmap = decodeBmp(bytes);
  const pixels = new Uint8Array(bitmap.pixels.length);
  for (let y = 0; y < bitmap.height; y++) pixels.set(bitmap.pixels.subarray(y * bitmap.width, (y + 1) * bitmap.width), (bitmap.height - 1 - y) * bitmap.width);
  return encodeBmp({ ...bitmap, pixels });
}

export function bitmapToRgba(bitmap: IndexedBitmap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bitmap.pixels.length * 4);
  for (let i = 0; i < bitmap.pixels.length; i++) {
    const p = bitmap.pixels[i];
    out[i * 4] = bitmap.palette[p * 3];
    out[i * 4 + 1] = bitmap.palette[p * 3 + 1];
    out[i * 4 + 2] = bitmap.palette[p * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
