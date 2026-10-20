/**
 * Turns true-color pictures into the game's indexed pixels.
 *
 * A terrain tile holds *source* indices; what the player sees is the level's
 * display color for that index under the current light. Matching is done
 * against the colors shown at neutral light, and only indices that darken
 * properly are offered, so an imported texture is lit like the level's own.
 */
import { type LevelPalette, NEUTRAL_LIGHT } from './palette.ts';
import { TILE_BYTES, TILE_SIZE } from './terrain.ts';

export interface QuantizeOptions {
  /** Error-diffusion dithering; better for photographs, worse for flat pixel art. */
  dither?: boolean;
  /** Source indices that may be used. */
  allowed: readonly number[];
  /** RGB shown for each source index (768 bytes). */
  colors: Uint8Array;
}

/**
 * Source indices that respond to light the way ordinary terrain does: darker
 * in a dim row than at neutral light. Index 0 is left out because cut tiles
 * use it for "nothing here"; indices that keep their color in the dark are
 * the level's glowing colors.
 */
export function shadableIndices(palette: LevelPalette): number[] {
  const out: number[] = [];
  const luminance = (display: number) => palette.plt[display * 3] * 3 + palette.plt[display * 3 + 1] * 6 + palette.plt[display * 3 + 2];
  const dim = Math.floor(NEUTRAL_LIGHT / 3);
  for (let i = 1; i < 256; i++) {
    const neutral = luminance(palette.displayIndex(i, NEUTRAL_LIGHT));
    const dark = luminance(palette.displayIndex(i, dim));
    // Very dark colors cannot get measurably darker; keep them.
    if (neutral < 120 || dark < neutral * 0.8) out.push(i);
  }
  return out;
}

/** The RGB a level shows for each source index at neutral light. */
export function neutralColors(palette: LevelPalette): Uint8Array {
  const table = palette.rgbaTable(NEUTRAL_LIGHT);
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) out.set(table.subarray(i * 4, i * 4 + 3), i * 3);
  return out;
}

/** Map RGBA pixels (alpha ignored) onto the allowed indices. */
export function quantizeRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, options: QuantizeOptions): Uint8Array {
  const { colors, allowed } = options;
  const work = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) work[i * 3 + c] = rgba[i * 4 + c];
  const cache = new Map<number, number>();
  const nearest = (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b;
    let best = cache.get(key);
    if (best === undefined) {
      let bestDistance = Infinity;
      best = allowed[0];
      for (const index of allowed) {
        const dr = r - colors[index * 3];
        const dg = g - colors[index * 3 + 1];
        const db = b - colors[index * 3 + 2];
        // Weighted towards green, as the eye is.
        const distance = dr * dr * 3 + dg * dg * 6 + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      cache.set(key, best);
    }
    return best;
  };
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = clamp(work[i * 3]);
      const g = clamp(work[i * 3 + 1]);
      const b = clamp(work[i * 3 + 2]);
      const index = nearest(r, g, b);
      out[i] = index;
      if (!options.dither) continue;
      const error = [r - colors[index * 3], g - colors[index * 3 + 1], b - colors[index * 3 + 2]];
      const spread = (dx: number, dy: number, weight: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) return;
        for (let c = 0; c < 3; c++) work[(ny * width + nx) * 3 + c] += error[c] * weight;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return out;
}

/**
 * Cut an indexed picture whose sides are multiples of the tile size into
 * tiles, left to right, top to bottom.
 */
export function sliceTiles(pixels: Uint8Array, width: number, height: number): Uint8Array[] {
  const tiles: Uint8Array[] = [];
  for (let ty = 0; ty + TILE_SIZE <= height; ty += TILE_SIZE) {
    for (let tx = 0; tx + TILE_SIZE <= width; tx += TILE_SIZE) {
      const tile = new Uint8Array(TILE_BYTES);
      for (let y = 0; y < TILE_SIZE; y++) tile.set(pixels.subarray((ty + y) * width + tx, (ty + y) * width + tx + TILE_SIZE), y * TILE_SIZE);
      tiles.push(tile);
    }
  }
  return tiles;
}
