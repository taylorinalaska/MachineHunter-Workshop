/** Per-face ramp sides, blocks, breakable cells, picture orientation, texture import, the animation scan. */
import { describe, expect, it } from 'vitest';
import {
  CompileError,
  DEFINITION_MASK,
  FLAG_DESTRUCTIBLE,
  LevelPalette,
  MAX_TILES,
  type MapProject,
  OP_FLOOR,
  OP_WALL_X,
  OP_WALL_Y,
  PROJECT_VERSION,
  RETAIL_MAX_TILES,
  TEXTURE_INDEX_MASK,
  TEXTURE_MASKED,
  cellIndex,
  compileProject,
  createProject,
  decodeBmp,
  decodeDestructible,
  deserializeProject,
  encodeBmp,
  flagsOf,
  flipBmpRows,
  maskOf,
  neutralColors,
  parseMap,
  quantizeRgba,
  readEntityType,
  readLevelTable,
  scanAnimationSources,
  serializeProject,
  shadableIndices,
  sliceTiles,
} from '../src/index.ts';
import { gameArchive, hasGameData, retailExe } from './game.ts';

const blankTiles = (count: number) => Array.from({ length: count }, (_, i) => new Uint8Array(4096).fill((i % 200) + 1));

function project(tiles = 8): MapProject {
  const p = createProject({ name: 'Feature test', baseLevel: 'MARS', width: 8, height: 8, tiles: blankTiles(tiles) });
  const ground = p.groups[0].layers[0];
  ground.surfaces.set(cellIndex(ground, 0, 0), { kind: 'floor', tile: 1, turn: 0 });
  ground.entities.push({ id: p.nextId++, type: 1, behavior: 0, weapon: 0, bit8: 0, x: 128, y: 128, disabled: false, pathId: null, flagsRest: 0 });
  return p;
}

function definitionAt(p: MapProject, x: number, y: number) {
  const compiled = compileProject(p);
  const map = parseMap(compiled.mapBytes, { lmp: compiled.lmpBytes });
  return { compiled, map, def: map.definitions[map.groups[0].layers[0].cells[y * 8 + x] & DEFINITION_MASK] };
}

/** The lateral position (x for north/south faces, y for east/west) every vertex of a face shares, or null. */
const faceOnEdge = (def: { vertices: Int16Array }, indices: number[], axis: 0 | 1, at: number) => indices.every((i) => def.vertices[i * 3 + axis] === at);

describe('ramp sides', () => {
  it('textures each side on its own', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 3, 3), { kind: 'ramp', direction: 'east', half: 'upper', tile: 2, turn: 1, sides: { north: 5, south: 6 } });
    const { def, compiled } = definitionAt(p, 3, 3);
    const walls = def.commands.filter((c) => c.op === OP_WALL_Y);
    expect(walls.length).toBe(2);
    const north = walls.find((c) => faceOnEdge(def, c.indices, 1, 0))!;
    const south = walls.find((c) => faceOnEdge(def, c.indices, 1, 256))!;
    // Each is a tile cut to the slope, generated from the tile chosen for that side.
    expect(north.texture! & TEXTURE_MASKED).toBeTruthy();
    expect(south.texture! & TEXTURE_MASKED).toBeTruthy();
    expect(north.texture).not.toBe(south.texture);
    const bank = compiled.terrainBytes!;
    const pixel = (word: number) => bank[4 + 10 * 4 + (word & TEXTURE_INDEX_MASK) * 4096 + 63 * 64 + 32];
    expect(compiled.stats.tiles).toBe(10);
    expect(pixel(north.texture!)).toBe(6); // tile 5 is filled with index 6
    expect(pixel(south.texture!)).toBe(7);
    // The tall end was not asked for, so it stays open.
    expect(def.commands.some((c) => c.op === OP_WALL_X)).toBe(false);
  });

  it('leaves an unpainted side open', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 3, 3), { kind: 'ramp', direction: 'north', half: 'lower', tile: 2, turn: 0, sides: { west: 4 } });
    const { def } = definitionAt(p, 3, 3);
    const walls = def.commands.filter((c) => c.op === OP_WALL_X);
    expect(walls.length).toBe(1);
    expect(faceOnEdge(def, walls[0].indices, 0, 0)).toBe(true);
  });

  it('upgrades version 1 projects, which had one tile for every side', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 3, 3), { kind: 'ramp', direction: 'east', half: 'upper', tile: 2, turn: 1, sides: {} });
    const pixels = Uint8Array.from({ length: 220 * 160 }, (_, i) => (i < 220 ? 9 : 0));
    p.briefing = { mode: 'custom', title: 'T', text: 'X', image: flipBmpRows(encodeBmp({ width: 220, height: 160, palette: new Uint8Array(768), pixels })) };
    const stored = JSON.parse(serializeProject(p));
    stored.version = 1;
    for (const [, surface] of stored.groups[0].layers[0].surfaces) {
      if (surface.kind !== 'ramp') continue;
      delete surface.sides;
      surface.sideTile = 5;
    }
    const restored = deserializeProject(JSON.stringify(stored));
    expect(restored.version).toBe(PROJECT_VERSION);
    expect(restored.groups[0].layers[0].surfaces.get(cellIndex(ground, 3, 3))).toMatchObject({ kind: 'ramp', sides: { north: 5, south: 5, east: 5 } });
    // Version 1 stored briefing pictures bottom row first; they are turned the right way up.
    expect(decodeBmp(restored.briefing.image!).pixels.subarray(0, 220).every((v) => v === 9)).toBe(true);
  });
});

describe('blocks', () => {
  it('compiles a full block to a solid cell with a top and four sides', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 2, 2), { kind: 'block', height: 1, topTile: 3, sides: { north: 4, east: 4, south: 5, west: 4 }, pillar: false, floorTile: null });
    const { def } = definitionAt(p, 2, 2);
    expect(flagsOf(def.meta)).toBe(0x8000);
    expect(def.commands.map((c) => c.op).sort()).toEqual([OP_WALL_X, OP_WALL_X, OP_WALL_Y, OP_WALL_Y, OP_FLOOR].sort());
    const top = def.commands.find((c) => c.op === OP_FLOOR)!;
    expect(top.indices.every((i) => def.vertices[i * 3 + 2] === -256)).toBe(true);
    const south = def.commands.find((c) => c.op === OP_WALL_Y && faceOnEdge(def, c.indices, 1, 256))!;
    expect(south.texture).toBe(5);
    expect(def.automap).not.toBeNull();
  });

  it.each([0.25, 0.5, 0.75])('compiles width %s with matching geometry and collision coverage', (width) => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 2, 2), { kind: 'block', height: 0.5, width, topTile: 3, sides: { north: 4 }, pillar: true, floorTile: 1 });
    const { def } = definitionAt(p, 2, 2);
    expect(maskOf(def.meta)).toBe(width === 0.75 ? 0xffff : 0x0660);
    const top = def.commands.find((c) => c.texture === 3)!;
    const xs = top.indices.map((i) => def.vertices[i * 3]);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(width * 256);
  });

  it('compiles a pillar to a walkable cell with a blocked middle', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 2, 2), { kind: 'block', height: 0.5, topTile: 3, sides: { north: 4, east: 4, south: 4, west: 4 }, pillar: true, floorTile: 1 });
    const { def } = definitionAt(p, 2, 2);
    expect(flagsOf(def.meta)).toBe(0x0005);
    expect(maskOf(def.meta)).toBe(0x0660);
    expect(def.commands.filter((c) => c.op === OP_FLOOR).length).toBe(2);
    const xs = new Set(Array.from({ length: def.vertices.length / 3 }, (_, i) => def.vertices[i * 3]));
    expect([...xs].sort((a, b) => a - b)).toEqual([0, 64, 192, 256]);
    expect(Math.min(...Array.from({ length: def.vertices.length / 3 }, (_, i) => def.vertices[i * 3 + 2]))).toBe(-128);
  });
});

describe('breakable cells', () => {
  it('marks the cell destructible and points it at the floor it leaves', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    ground.surfaces.set(cellIndex(ground, 2, 2), { kind: 'block', height: 0.5, topTile: 3, sides: { north: 4, east: 4, south: 4, west: 4 }, pillar: false, floorTile: null });
    ground.behaviors.set(cellIndex(ground, 2, 2), { kind: 'breakable', toughness: 30, effect: 8, leaves: 6 });
    const { def, map } = definitionAt(p, 2, 2);
    expect(flagsOf(def.meta) & FLAG_DESTRUCTIBLE).toBeTruthy();
    // Collision is still the block's.
    expect(flagsOf(def.meta) & 0x8000).toBeTruthy();
    const d = decodeDestructible(def.meta)!;
    expect(d).toMatchObject({ toughness: 30, effect: 8, centerEffect: true, playerOnly: false, enablesObject: false });
    const rubble = map.definitions[d.replaceWith];
    expect(flagsOf(rubble.meta)).toBe(0x0001);
    expect(rubble.commands.map((c) => [c.op, c.texture])).toEqual([[OP_FLOOR, 6]]);
  });
});

describe('tile limits', () => {
  it('accepts banks past the retail limit and says they need the runtime', () => {
    const compiled = compileProject(project(RETAIL_MAX_TILES + 12));
    expect(compiled.stats.tiles).toBe(RETAIL_MAX_TILES + 12);
    expect(compiled.issues.some((i) => i.level === 'info' && /Workshop runtime/.test(i.message))).toBe(true);
  });

  it('refuses banks past the extended limit', () => {
    expect(() => compileProject(project(MAX_TILES + 1))).toThrow(CompileError);
  });
});

describe('pictures', () => {
  it('stores bitmap rows in the order the game shows them: top row first', () => {
    const pixels = Uint8Array.from({ length: 6 * 3 }, (_, i) => Math.floor(i / 6) + 1);
    const bytes = encodeBmp({ width: 6, height: 3, palette: new Uint8Array(768), pixels });
    const pixelOffset = new DataView(bytes.buffer).getUint32(10, true);
    expect(bytes[pixelOffset]).toBe(1); // first stored row is the top row
    expect(decodeBmp(bytes).pixels).toEqual(pixels);
    expect(decodeBmp(flipBmpRows(bytes)).pixels[0]).toBe(3);
  });

  it('quantises to the allowed colors only and cuts sheets into tiles', () => {
    const colors = new Uint8Array(768);
    colors.set([255, 0, 0], 10 * 3);
    colors.set([0, 0, 255], 20 * 3);
    colors.set([250, 5, 5], 30 * 3); // closer to red, but not allowed
    const rgba = new Uint8ClampedArray(128 * 64 * 4);
    for (let i = 0; i < 128 * 64; i++) rgba.set((i % 128) < 64 ? [240, 10, 10, 255] : [10, 10, 240, 255], i * 4);
    const pixels = quantizeRgba(rgba, 128, 64, { allowed: [10, 20], colors });
    const tiles = sliceTiles(pixels, 128, 64);
    expect(tiles.length).toBe(2);
    expect(tiles[0].every((v) => v === 10)).toBe(true);
    expect(tiles[1].every((v) => v === 20)).toBe(true);
  });
});

describe.runIf(hasGameData)('retail data', () => {
  it('finds the animation records the actor descriptors point at, and many more', () => {
    const exe = retailExe();
    const slots = new Set(readLevelTable(exe).flatMap((l) => l.sprites.map((s) => s.slot)));
    const records = scanAnimationSources(exe, slots);
    expect(records.length).toBeGreaterThan(300);
    const found = new Set(records.map((r) => `${r.slot}:${r.frameBase}:${r.frameSpan}`));
    let checked = 0;
    for (let type = 2; type < 140; type++) {
      const a = readEntityType(exe, type).descriptor?.primaryAnimation;
      if (!a || !slots.has(a.slot) || a.mode < 1 || a.mode > 6 || a.frameSpan < 1) continue;
      expect(found.has(`${a.slot}:${a.frameBase}:${a.frameSpan}`), `type ${type}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('offers only colors that darken with the light when importing textures', () => {
    const level = readLevelTable(retailExe())[0];
    const archive = gameArchive();
    const palette = new LevelPalette(archive.read(level.resources.plt), archive.read(level.resources.brt), archive.read(level.resources.rmp));
    const allowed = shadableIndices(palette);
    expect(allowed.length).toBeGreaterThan(100);
    expect(allowed).not.toContain(0);
    expect(neutralColors(palette).length).toBe(768);
  });
});
