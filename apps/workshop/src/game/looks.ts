/**
 * Custom enemies' looks: recoloring a type's retail frames, exporting them as
 * a picture to paint over and reading that picture back, and the replacement
 * sprites a map carries, for drawing it.
 */
import { type AnimationSource, type CustomAnimation, type LevelPalette, type MapProject, type SpriteFrame, decodeSprites, neutralColors, quantizeRgba, shadableIndices, spriteSide } from '@mh/core';
import type { EntityInfo, GameData, SlotLooks } from './gamedata.ts';
import { keyOfType } from '../editor/doors.ts';

/** The runtime slot whose sprites draw an entity type, and the container a level loads into it. */
export function typeSlot(game: GameData, type: number, level: string): { slot: number; container: string } | null {
  const slot = game.entity(type)?.descriptor?.primaryAnimation?.slot;
  if (slot === undefined) return null;
  const container = game.level(level).slots.get(slot);
  return container ? { slot, container } : null;
}

/** Other entity types drawn from the same slot: changing its look changes theirs too. */
export function slotSharers(game: GameData, slot: number, type: number): EntityInfo[] {
  return game.entities.filter((e) => e.type !== type && e.type !== 1 && (e.descriptor?.primaryAnimation?.slot === slot || e.descriptor?.secondaryAnimation?.slot === slot));
}

/** The name a map gives an entity type. */
export function typeName(game: GameData, project: MapProject | null | undefined, type: number): string {
  const key = keyOfType(type);
  return project?.customTypes.find((t) => t.type === type)?.name || (key ? `Key ${key}` : '') || game.entity(type)?.name || `Type ${type}`;
}

/** Source indices a replacement may use: those that light like the level's own, plus any the retail frames already use. */
function allowedIndices(palette: LevelPalette, frames: readonly SpriteFrame[]): number[] {
  const allowed = new Set(shadableIndices(palette));
  for (const f of frames) for (const p of f.pixels) if (p) allowed.add(p);
  allowed.delete(0);
  return [...allowed].sort((a, b) => a - b);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export interface Recolor {
  /** Degrees added to every color's hue. */
  hue: number;
  /** Percent of the original saturation. */
  saturation: number;
  /** Percent of the original lightness. */
  brightness: number;
}

/** Recolor frames within a level's palette. Transparent pixels stay transparent. */
export function recolorFrames(frames: readonly SpriteFrame[], palette: LevelPalette, look: Recolor): SpriteFrame[] {
  const colors = neutralColors(palette);
  const allowed = allowedIndices(palette, frames);
  const remap = new Uint8Array(256);
  const used = new Set<number>();
  for (const f of frames) for (const p of f.pixels) used.add(p);
  for (const index of used) {
    if (!index) continue;
    const [h, s, l] = rgbToHsl(colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2]);
    const [r, g, b] = hslToRgb((((h + look.hue) % 360) + 360) % 360, Math.min(1, (s * look.saturation) / 100), Math.min(1, (l * look.brightness) / 100));
    let best = allowed[0];
    let bestDistance = Infinity;
    for (const i of allowed) {
      const dr = r - colors[i * 3];
      const dg = g - colors[i * 3 + 1];
      const db = b - colors[i * 3 + 2];
      const distance = dr * dr * 3 + dg * dg * 6 + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    remap[index] = best;
  }
  return frames.map((f) => ({ ...f, pixels: f.pixels.map((p) => remap[p]) }));
}

/** Frames per row of an exported sheet; every frame gets a 64x64 cell, drawn at its own size in the top-left corner. */
const SHEET_COLUMNS = 16;
const CELL = 64;

export function sheetSize(count: number): { width: number; height: number } {
  return { width: Math.min(count, SHEET_COLUMNS) * CELL, height: Math.ceil(count / SHEET_COLUMNS) * CELL };
}

/** All frames on one picture, to paint over in an image editor. */
export function framesToSheet(frames: readonly SpriteFrame[], palette: LevelPalette): HTMLCanvasElement {
  const { width, height } = sheetSize(frames.length);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  frames.forEach((f, i) => {
    const side = spriteSide(f.scale);
    const rgba = palette.toRgba(f.pixels, 0);
    g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, side, side), (i % SHEET_COLUMNS) * CELL, Math.floor(i / SHEET_COLUMNS) * CELL);
  });
  return canvas;
}

/**
 * Read a sheet laid out like `framesToSheet` back into frames of the same
 * sizes as `template`. Pixels less than half opaque become transparent; the
 * rest are matched to the level's colors.
 */
export async function sheetToFrames(picture: Blob, template: readonly SpriteFrame[], palette: LevelPalette): Promise<SpriteFrame[]> {
  const bitmap = await createImageBitmap(picture);
  const { width, height } = sheetSize(template.length);
  if (bitmap.width < width || bitmap.height < height) {
    bitmap.close();
    throw new Error(`The picture is ${bitmap.width}×${bitmap.height}; it needs to be the ${width}×${height} sheet exported from here, with ${template.length} frames.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const options = { allowed: allowedIndices(palette, template), colors: neutralColors(palette) };
  return template.map((f, i) => {
    const side = spriteSide(f.scale);
    const rgba = g.getImageData((i % SHEET_COLUMNS) * CELL, Math.floor(i / SHEET_COLUMNS) * CELL, side, side).data;
    const pixels = quantizeRgba(rgba, side, side, options);
    for (let p = 0; p < pixels.length; p++) if (rgba[p * 4 + 3] < 128) pixels[p] = 0;
    return { ...f, pixels };
  });
}

/* ------------------------------------------------------------ animations */

/** An animation a type plays, as the custom enemy editor lists it. */
export interface TypeAnimation {
  label: string;
  /** The retail record. */
  source: AnimationSource;
  /** Modes 4..6 hand over to game code when they end; their mode cannot be changed. */
  modeLocked: boolean;
}

/**
 * The handful of animations a type plays. Robots appear with their
 * descriptor's two records and then switch, as they stop and move, to their
 * body's own tables (body and upper body standing and walking, upper body
 * firing and dying). Other types use their descriptor's records and whatever else the
 * game code switches them to that draws from the same sprites.
 */
export function typeAnimations(game: GameData, type: number, level: string): TypeAnimation[] {
  const info = game.entity(type);
  const d = info?.descriptor;
  if (!info || !d) return [];
  const out: TypeAnimation[] = [];
  const seen = new Set<number>();
  const add = (label: string, source: AnimationSource | null | undefined) => {
    if (!source || seen.has(source.va) || source.frameSpan < 1) return;
    seen.add(source.va);
    out.push({ label, source, modeLocked: source.mode >= 4 });
  };
  const forms = info.form && info.form > 1 ? game.formAnimations[info.form - 1] : null;
  if (forms) {
    // Checked in the game: an idle robot shows its descriptor's body, and one that stands and fires the standing upper body.
    add('Body when it appears', d.primaryAnimation);
    add('Body standing', forms.idleBody);
    add('Body walking', forms.moveBody);
    add('Upper body when it appears', d.secondaryAnimation);
    add('Upper body standing', forms.idleTurret);
    add('Upper body walking', forms.moveTurret);
    add('Upper body firing', forms.firing);
    add('Upper body dying', forms.dying);
    return out;
  }
  add(d.secondaryAnimation ? 'Body' : 'Standing', d.primaryAnimation);
  add('Upper body', d.secondaryAnimation);
  const slot = typeSlot(game, type, level);
  if (slot) {
    const others = game.animationsFor(slot.container).filter((a) => a.slot === slot.slot || a.slot === d.secondaryAnimation?.slot);
    for (const a of others.slice(0, 12)) add(a.mode >= 4 ? `Plays once (frames ${a.frameBase}–${a.frameBase + a.frameSpan - 1})` : `Frames ${a.frameBase}–${a.frameBase + a.frameSpan - 1}`, a);
  }
  return out;
}

/** A retail record with a map's changes applied, for previewing. */
export function retimed(source: AnimationSource, change: CustomAnimation | undefined): AnimationSource {
  if (!change) return source;
  return { ...source, frameBase: change.base, frameSpan: change.span, startOffset: change.start, tickReload: change.ticks, mode: change.mode, reversed: change.reversed };
}

/** The editable numbers of a retail record. */
export function animationOf(source: AnimationSource): CustomAnimation {
  return { record: source.va, base: source.frameBase, span: Math.max(1, source.frameSpan), start: Math.max(0, Math.min(source.startOffset, source.frameSpan - 1)), ticks: Math.max(1, source.tickReload), mode: source.mode, reversed: source.reversed };
}

/* ------------------------------------------------- a map's replacement sprites */

const decoded = new WeakMap<Uint8Array, { id: number; frames: SpriteFrame[] }>();
let nextDecodedId = 1;
const looksByKey = new Map<string, SlotLooks>();

/** The sprite slots a map's custom enemies replace, for drawing it; undefined when there are none. */
export function projectLooks(project: MapProject): SlotLooks | undefined {
  const parts: string[] = [];
  const slots = new Map<number, SpriteFrame[]>();
  for (const t of project.customTypes) {
    if (!t.sprite) continue;
    let entry = decoded.get(t.sprite.data);
    if (!entry) {
      entry = { id: nextDecodedId++, frames: decodeSprites(t.sprite.data) };
      decoded.set(t.sprite.data, entry);
    }
    slots.set(t.sprite.slot, entry.frames);
    parts.push(`${t.sprite.slot}=${entry.id}`);
  }
  if (!slots.size) return undefined;
  const key = parts.sort().join(',');
  let looks = looksByKey.get(key);
  if (!looks) {
    if (looksByKey.size > 32) looksByKey.clear();
    looks = { key, slots };
    looksByKey.set(key, looks);
  }
  return looks;
}
