/**
 * The game's own bitmap fonts, for faithful text previews.
 *
 * Glyph tables live in the executable: a pointer table at 0x00493068 selects
 * one table per text style, and each table holds a 4-byte record per character
 * code: source x, source y, advance width, height. The pixels come from
 * TEXT3.BMP, which the game reads in file row order (`decodeBmp` keeps that
 * order). The 15-pixel styles index the sheet directly;
 * the 8-pixel styles index a second page that starts 144 rows down.
 */
import { type IndexedBitmap, decodeBmp } from '@mh/core';
import type { GameData } from './gamedata.ts';

const STYLE_TABLE = 0x00493068;
const SMALL_PAGE_ROW = 144;

export interface Glyph {
  x: number;
  y: number;
  advance: number;
  height: number;
}

export class GameFont {
  private readonly sheet: IndexedBitmap;
  private readonly tables: number[];

  constructor(private readonly game: GameData) {
    this.sheet = decodeBmp(game.archive.read('TEXT3.BMP'));
    this.tables = Array.from({ length: 7 }, (_, i) => game.exe.u32(STYLE_TABLE + i * 4));
  }

  glyph(style: number, code: number): Glyph {
    const at = this.tables[style] + (code & 0x7f) * 4;
    const exe = this.game.exe;
    return { x: exe.u8(at), y: exe.u8(at + 1), advance: exe.u8(at + 2), height: exe.u8(at + 3) };
  }

  /** Styles 5 and 6 reuse the small glyphs with tighter spacing. */
  private advance(style: number, g: Glyph): number {
    return style >= 5 ? Math.max(1, g.advance - 2) : g.advance;
  }

  lineHeight(style: number): number {
    return this.glyph(style, 65).height;
  }

  measure(style: number, text: string): number {
    let width = 0;
    for (const ch of text) width += this.advance(style, this.glyph(style, ch.charCodeAt(0)));
    return width;
  }

  /**
   * Draw text into an RGBA image. `\n` starts a new line. Colors come from
   * the font sheet's own palette; index 0 is transparent.
   */
  draw(target: ImageData, style: number, text: string, x: number, y: number, align: 'left' | 'center' = 'left', lineSpacing = 2): void {
    const { sheet } = this;
    const small = this.lineHeight(style) <= 8;
    let cy = y;
    for (const line of text.split('\n')) {
      let cx = align === 'center' ? Math.round(x - this.measure(style, line) / 2) : x;
      for (const ch of line) {
        const code = ch.charCodeAt(0);
        const g = this.glyph(style, code);
        const advance = this.advance(style, g);
        if (code !== 32) {
          const cell = small ? 8 : 16;
          for (let gy = 0; gy < g.height; gy++) {
            const row = g.y + gy + (small ? SMALL_PAGE_ROW : 0);
            if (row < 0 || row >= sheet.height) continue;
            for (let gx = 0; gx < Math.min(cell, Math.max(advance, g.advance)); gx++) {
              const p = sheet.pixels[row * sheet.width + ((g.x + gx) & 0xff)];
              if (!p) continue;
              const tx = cx + gx;
              const ty = cy + gy;
              if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
              const at = (ty * target.width + tx) * 4;
              target.data[at] = sheet.palette[p * 3];
              target.data[at + 1] = sheet.palette[p * 3 + 1];
              target.data[at + 2] = sheet.palette[p * 3 + 2];
              target.data[at + 3] = 255;
            }
          }
        }
        cx += advance;
      }
      cy += this.lineHeight(style) + lineSpacing;
    }
  }
}

let cached: { game: GameData; font: GameFont } | null = null;

export function gameFont(game: GameData): GameFont {
  if (cached?.game !== game) cached = { game, font: new GameFont(game) };
  return cached.font;
}
