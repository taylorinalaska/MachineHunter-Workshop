/**
 * The game's indexed-color pipeline.
 *
 *   .PAL  256 x BGRx   source colors. Four files are stitched into one
 *                      composite source palette at level load:
 *                        0..15   CONTROL.PAL
 *                        16..47  OBJECTS.PAL
 *                        48..159 the level's own .PAL
 *                        160..255 SPRITES.PAL
 *   .PLT  256 x RGBx   the actual display palette for the level.
 *   .BRT  9 banks x 32 light rows x 256: source index -> display index.
 *                      Bank 0 is normal lighting (row 15 = full brightness),
 *                      banks 1..8 are colored lights.
 *   .RMP  256 x 256    additive blend of two display indices.
 *   .MSK  256 x 4      authoring-time "fullbright" mask used to build bank 0.
 *
 * Every texel and sprite pixel is a *source* index; what reaches the screen is
 * PLT[ BRT[bank][light][index] ].
 */
import { check } from '../util/binary.ts';

export const PALETTE_BYTES = 1024;
export const BRT_BANKS = 9;
export const BRT_LIGHT_LEVELS = 32;
export const BRT_BYTES = BRT_BANKS * BRT_LIGHT_LEVELS * 256;
export const RMP_BYTES = 256 * 256;
/** Light row that reproduces the source color unchanged. */
export const NEUTRAL_LIGHT = 15;

/** Composite source-palette ranges, in the order the level loader applies them. */
export const SOURCE_PALETTE_RANGES = [
  { file: 'CONTROL.PAL', first: 0, count: 16 },
  { file: 'OBJECTS.PAL', first: 16, count: 32 },
  { file: null, first: 48, count: 112 }, // the level's .PAL
  { file: 'SPRITES.PAL', first: 160, count: 96 },
] as const;

/** 256 RGB triples, three bytes per entry. */
export type Rgb256 = Uint8Array;

/** Decode a .PAL file (stored B,G,R,x) to RGB triples. */
export function decodePal(bytes: Uint8Array): Rgb256 {
  check(bytes.length === PALETTE_BYTES, `.PAL must be ${PALETTE_BYTES} bytes`);
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    out[i * 3] = bytes[i * 4 + 2];
    out[i * 3 + 1] = bytes[i * 4 + 1];
    out[i * 3 + 2] = bytes[i * 4];
  }
  return out;
}

/** Decode a .PLT file (stored R,G,B,x) to RGB triples. */
export function decodePlt(bytes: Uint8Array): Rgb256 {
  check(bytes.length === PALETTE_BYTES, `.PLT must be ${PALETTE_BYTES} bytes`);
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    out[i * 3] = bytes[i * 4];
    out[i * 3 + 1] = bytes[i * 4 + 1];
    out[i * 3 + 2] = bytes[i * 4 + 2];
  }
  return out;
}

export function encodePlt(rgb: Rgb256): Uint8Array {
  const out = new Uint8Array(PALETTE_BYTES);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
  }
  return out;
}

/** Stitch the composite source palette the way the level loader does. */
export function compositeSourcePalette(control: Rgb256, objects: Rgb256, level: Rgb256, sprites: Rgb256): Rgb256 {
  const out = new Uint8Array(768);
  const parts = [control, objects, level, sprites];
  SOURCE_PALETTE_RANGES.forEach((range, i) => {
    out.set(parts[i].subarray(range.first * 3, (range.first + range.count) * 3), range.first * 3);
  });
  return out;
}

/** Lowest index with the smallest squared RGB distance: the game's own quantiser. */
export function nearestIndex(palette: Rgb256, r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
      if (!distance) break;
    }
  }
  return best;
}

/** Caches nearest-color lookups; generating a BRT asks for the same colors repeatedly. */
export class PaletteQuantiser {
  private readonly cache = new Map<number, number>();
  constructor(readonly palette: Rgb256) {}
  nearest(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    let index = this.cache.get(key);
    if (index === undefined) {
      index = nearestIndex(this.palette, r, g, b);
      this.cache.set(key, index);
    }
    return index;
  }
}

/** RMP[dst][src] = nearest display index of the saturating sum of two display colors. */
export function generateRmp(plt: Rgb256): Uint8Array {
  const q = new PaletteQuantiser(plt);
  const out = new Uint8Array(RMP_BYTES);
  for (let dst = 0; dst < 256; dst++) {
    for (let src = 0; src < 256; src++) {
      out[dst * 256 + src] = q.nearest(
        Math.min(255, plt[dst * 3] + plt[src * 3]),
        Math.min(255, plt[dst * 3 + 1] + plt[src * 3 + 1]),
        Math.min(255, plt[dst * 3 + 2] + plt[src * 3 + 2]),
      );
    }
  }
  return out;
}

/**
 * Rebuild a .BRT from the composite source palette, the display palette and
 * the fullbright mask. Reproduces the retail files byte for byte.
 */
export function generateBrt(source: Rgb256, plt: Rgb256, fullbright: (index: number) => boolean): Uint8Array {
  const q = new PaletteQuantiser(plt);
  const out = new Uint8Array(BRT_BYTES);
  const scale = (c: number, factor: number) => Math.min(255, Math.floor((c * factor) / 16));
  for (let bank = 0; bank < BRT_BANKS; bank++) {
    for (let light = 0; light < BRT_LIGHT_LEVELS; light++) {
      const row = (bank * BRT_LIGHT_LEVELS + light) * 256;
      for (let i = 0; i < 256; i++) {
        const r = source[i * 3];
        const g = source[i * 3 + 1];
        const b = source[i * 3 + 2];
        if (bank === 0) {
          const factor = fullbright(i) ? 16 : light + 1;
          out[row + i] = q.nearest(scale(r, factor), scale(g, factor), scale(b, factor));
          continue;
        }
        const factor = Math.min(light + 1, 16);
        const gray = Math.floor((scale(r, factor) + scale(g, factor) + scale(b, factor)) / 3);
        const half = Math.floor(gray / 2);
        const tint: [number, number, number] = (
          [
            [gray, 0, 0], // red
            [gray, half, 0], // orange
            [gray, gray, 0], // yellow
            [0, gray, 0], // green
            [0, gray, gray], // cyan
            [0, 0, Math.min(255, gray * 2)], // blue
            [gray, 0, gray], // magenta
            [gray, gray, gray], // grayscale
          ] as [number, number, number][]
        )[bank - 1];
        out[row + i] = q.nearest(tint[0], tint[1], tint[2]);
      }
    }
  }
  return out;
}

/** Predicate over a .MSK file: an index is fullbright when its RGB triple is non-zero. */
export function fullbrightFromMsk(msk: Uint8Array): (index: number) => boolean {
  check(msk.length === PALETTE_BYTES, `.MSK must be ${PALETTE_BYTES} bytes`);
  return (i) => (msk[i * 4] | msk[i * 4 + 1] | msk[i * 4 + 2]) !== 0;
}

/** Everything needed to turn source indices into screen colors for one level. */
export class LevelPalette {
  readonly plt: Rgb256;
  readonly brt: Uint8Array;
  readonly rmp: Uint8Array | null;

  constructor(pltBytes: Uint8Array, brt: Uint8Array, rmp: Uint8Array | null = null) {
    check(brt.length === BRT_BYTES, `.BRT must be ${BRT_BYTES} bytes`);
    check(!rmp || rmp.length === RMP_BYTES, `.RMP must be ${RMP_BYTES} bytes`);
    this.plt = decodePlt(pltBytes);
    this.brt = brt;
    this.rmp = rmp;
  }

  /** Display index for a source index under a given light row and color bank. */
  displayIndex(sourceIndex: number, light = NEUTRAL_LIGHT, bank = 0): number {
    return this.brt[(bank * BRT_LIGHT_LEVELS + light) * 256 + sourceIndex];
  }

  /** 256 RGBA entries (alpha 255) for one light row; index 0 is not treated specially. */
  rgbaTable(light = NEUTRAL_LIGHT, bank = 0): Uint8Array {
    const out = new Uint8Array(1024);
    const row = (bank * BRT_LIGHT_LEVELS + light) * 256;
    for (let i = 0; i < 256; i++) {
      const d = this.brt[row + i];
      out[i * 4] = this.plt[d * 3];
      out[i * 4 + 1] = this.plt[d * 3 + 1];
      out[i * 4 + 2] = this.plt[d * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Expand indexed pixels to RGBA. `transparentIndex` (if given) becomes alpha 0. */
  toRgba(pixels: Uint8Array, transparentIndex: number | null = 0, light = NEUTRAL_LIGHT): Uint8ClampedArray {
    const table = this.rgbaTable(light);
    const out = new Uint8ClampedArray(pixels.length * 4);
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      if (p === transparentIndex) continue;
      out[i * 4] = table[p * 4];
      out[i * 4 + 1] = table[p * 4 + 1];
      out[i * 4 + 2] = table[p * 4 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
}
