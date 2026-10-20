/**
 * Sprite containers (.B).
 *
 *   uint32 frameCount
 *   uint32 frameOffset[frameCount]      absolute, ascending
 *   frames:
 *     uint32 scaleCode                  1 -> 64x64, 2 -> 32x32, 4 -> 16x16
 *     uint32 0xFFFFFFFF + raw pixels    (uncompressed), or
 *     uint32 decodedSize + RLE stream   (signed control byte: c < 0 copies -c
 *                                        literals, c >= 0 repeats the next byte c + 2 times)
 *
 * Pixels are source-palette indices, row-major; index 0 is transparent.
 * Actors are drawn top-down and rotated by the renderer, so a container holds
 * animation steps, not facing directions.
 */
import { ByteReader, ByteWriter, FormatError, check, concatBytes } from '../util/binary.ts';

export type SpriteScale = 1 | 2 | 4;
export type SpriteCodec = 'raw' | 'rle';

export interface SpriteFrame {
  scale: SpriteScale;
  /** side x side source-palette indices. */
  pixels: Uint8Array;
  /** How the frame was (or should be) stored. */
  codec: SpriteCodec;
}

export const spriteSide = (scale: SpriteScale): number => 64 / scale;

const RAW_MARKER = 0xffffffff;
export const MAX_SPRITE_FRAMES = 10000;

function decodeRle(r: ByteReader, start: number, end: number, expected: number): { pixels: Uint8Array; next: number } {
  const out = new Uint8Array(expected);
  let p = start;
  let at = 0;
  while (at < expected) {
    if (p >= end) throw new FormatError('Sprite RLE stream ended early');
    const control = r.i8(p++);
    if (control < 0) {
      const n = -control;
      if (p + n > end || at + n > expected) throw new FormatError('Sprite RLE literal run overruns the frame');
      out.set(r.slice(p, n), at);
      p += n;
      at += n;
    } else {
      const n = control + 2;
      if (p >= end || at + n > expected) throw new FormatError('Sprite RLE repeat run overruns the frame');
      out.fill(r.u8(p++), at, at + n);
      at += n;
    }
  }
  return { pixels: out, next: p };
}

/** Decode every frame. With `strict`, trailing bytes after a frame are an error. */
export function decodeSprites(bytes: Uint8Array, strict = true): SpriteFrame[] {
  const r = new ByteReader(bytes);
  check(bytes.length >= 8, 'Sprite container is truncated');
  const count = r.u32(0);
  const headerSize = 4 + count * 4;
  check(count > 0 && count <= MAX_SPRITE_FRAMES && headerSize <= bytes.length, 'Sprite container has an invalid frame table');
  const frames: SpriteFrame[] = [];
  let previous = headerSize;
  for (let i = 0; i < count; i++) {
    const offset = r.u32(4 + i * 4);
    const end = i + 1 < count ? r.u32(8 + i * 4) : bytes.length;
    check(offset >= headerSize && offset >= previous && offset + 8 <= end && end <= bytes.length, `Sprite frame ${i} has an invalid span`);
    const scale = r.u32(offset);
    check(scale === 1 || scale === 2 || scale === 4, `Sprite frame ${i} has unsupported scale code ${scale}`);
    const expected = spriteSide(scale) ** 2;
    const marker = r.u32(offset + 4);
    let used: number;
    let frame: SpriteFrame;
    if (marker === RAW_MARKER) {
      check(offset + 8 + expected <= end, `Sprite frame ${i}: raw pixels are truncated`);
      frame = { scale, pixels: bytes.slice(offset + 8, offset + 8 + expected), codec: 'raw' };
      used = 8 + expected;
    } else {
      check(marker === expected, `Sprite frame ${i}: decoded size ${marker} does not match its scale`);
      const { pixels, next } = decodeRle(r, offset + 8, end, expected);
      frame = { scale, pixels, codec: 'rle' };
      used = next - offset;
    }
    if (strict) check(offset + used === end, `Sprite frame ${i}: ${end - offset - used} trailing byte(s)`);
    frames.push(frame);
    previous = offset;
  }
  return frames;
}

function encodeRle(pixels: Uint8Array): Uint8Array {
  const w = new ByteWriter(pixels.length + 16);
  w.u32(pixels.length);
  const runAt = (i: number): number => {
    let run = 1;
    while (i + run < pixels.length && pixels[i + run] === pixels[i] && run < 129) run++;
    return run;
  };
  let i = 0;
  while (i < pixels.length) {
    const run = runAt(i);
    if (run >= 3) {
      w.u8(run - 2).u8(pixels[i]);
      i += run;
      continue;
    }
    // Literal run: extend until a worthwhile repeat starts or 128 bytes are gathered.
    const start = i;
    i += run;
    while (i < pixels.length && i - start < 128) {
      const next = runAt(i);
      if (next >= 3) break;
      const take = Math.min(next, 128 - (i - start));
      i += take;
      if (take < next) break;
    }
    const n = i - start;
    w.u8(-n & 0xff).bytes(pixels.subarray(start, i));
  }
  return w.finish();
}

function encodeFrame(frame: SpriteFrame, codec: SpriteCodec | 'auto' | 'preserve'): Uint8Array {
  const expected = spriteSide(frame.scale) ** 2;
  check(frame.pixels.length === expected, `Sprite frame has ${frame.pixels.length} pixels; scale ${frame.scale} needs ${expected}`);
  const raw = () => new ByteWriter(8 + expected).u32(frame.scale).u32(RAW_MARKER).bytes(frame.pixels).finish();
  const rle = () => concatBytes([new ByteWriter(4).u32(frame.scale).finish(), encodeRle(frame.pixels)]);
  const mode = codec === 'preserve' ? frame.codec : codec;
  if (mode === 'raw') return raw();
  if (mode === 'rle') return rle();
  const a = raw();
  const b = rle();
  return b.length < a.length ? b : a;
}

/** Build a container. `auto` picks the smaller encoding per frame. */
export function encodeSprites(frames: readonly SpriteFrame[], codec: SpriteCodec | 'auto' | 'preserve' = 'auto'): Uint8Array {
  check(frames.length > 0 && frames.length <= MAX_SPRITE_FRAMES, 'A sprite container needs 1..10000 frames');
  const chunks = frames.map((f) => encodeFrame(f, codec));
  const header = new ByteWriter(4 + chunks.length * 4);
  header.u32(chunks.length);
  let offset = 4 + chunks.length * 4;
  for (const chunk of chunks) {
    header.u32(offset);
    offset += chunk.length;
  }
  return concatBytes([header.finish(), ...chunks]);
}

/** Tight bounding box of the non-transparent pixels, or null for an empty frame. */
export function spriteBounds(frame: SpriteFrame): { x: number; y: number; width: number; height: number } | null {
  const side = spriteSide(frame.scale);
  let x0 = side;
  let y0 = side;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (frame.pixels[y * side + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
