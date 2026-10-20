/** Props built from parts, props stacked on cells, paths and custom sounds. */
import { describe, expect, it } from 'vitest';
import {
  CLASS_EXIT,
  DEFINITION_MASK,
  FLAG_DESTRUCTIBLE,
  type MapProject,
  OP_FLOOR,
  PATH_LOOP,
  PATH_ZONE,
  type PropPart,
  TEXTURE_INDEX_MASK,
  TEXTURE_MASKED,
  buildMhproject,
  buildPropDefinition,
  cellIndex,
  compileProject,
  createProject,
  createPropModel,
  decodeDestructible,
  decodeTerrainBank,
  definitionClass,
  deserializeProject,
  flagsOf,
  fromUtf8,
  maskOf,
  meshPropModel,
  parseMap,
  partsFromBlocks,
  serializeProject,
  turnPart,
  unzipStored,
} from '../src/index.ts';

const blankTiles = (count: number) => Array.from({ length: count }, (_, i) => new Uint8Array(4096).fill((i % 200) + 1));

function project(): MapProject {
  const p = createProject({ name: 'Prop test', baseLevel: 'MARS', width: 8, height: 8, tiles: blankTiles(8) });
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

const part = (shape: PropPart['shape'], x: number, y: number, z: number, w: number, d: number, h: number, extra: Partial<PropPart> = {}): PropPart => ({ shape, x, y, z, w, d, h, turn: 0, tile: 3, ...extra });

function model(parts: PropPart[], tile = 3) {
  const m = createPropModel(1, 1, 'Test', tile);
  m.parts = parts.map((p) => ({ ...p, tile }));
  return m;
}

/** Add a model to a project library and return it. */
function addModel(p: MapProject, m: ReturnType<typeof model>) {
  m.id = p.nextId++;
  m.definitionId = p.definitions.length;
  p.definitions.push(buildPropDefinition(m));
  p.definitionSources.push('model');
  p.models.push(m);
  return m;
}

type V = number[];
const minus = (a: V, b: V) => a.map((v, i) => v - b[i]);
const crossOf = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotOf = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('props built from parts', () => {
  it('turns a box into its top and four sides, the top drawn last', () => {
    const faces = meshPropModel(model([part('box', 4, 2, 0, 8, 12, 6)]));
    expect(faces.length).toBe(5);
    const top = faces[faces.length - 1];
    expect(top.op).toBe(OP_FLOOR);
    // 8 x 12 steps of 16 units, 6 steps high: z is negative upwards in the map.
    expect(top.points).toEqual([
      [64, 32, -96],
      [192, 32, -96],
      [192, 224, -96],
      [64, 224, -96],
    ]);
    // The tile lies on the top at natural size, lined up with the world.
    expect(top.uv).toEqual([
      [16, 8],
      [48, 8],
      [48, 56],
      [16, 56],
    ]);
  });

  it('gives every shape all the faces that can be seen from above', () => {
    const counts: Record<PropPart['shape'], number> = { box: 5, wedge: 4, pyramid: 4, roof: 4, cylinder: 8 + 3, cone: 8 };
    for (const [shape, count] of Object.entries(counts) as [PropPart['shape'], number][])
      for (const turn of [0, 1, 2, 3] as const) expect(meshPropModel(model([part(shape, 2, 3, 1, 10, 8, 9, { turn, sides: 8 })])).length, `${shape} turn ${turn}`).toBe(count);
  });

  it('winds every face the way the game draws front faces', () => {
    const shapes: PropPart['shape'][] = ['box', 'wedge', 'pyramid', 'roof', 'cylinder', 'cone'];
    for (const shape of shapes) {
      for (const turn of [0, 1, 2, 3] as const) {
        const m = model([part(shape, 2, 3, 1, 10, 8, 9, { turn })]);
        // A point inside every shape: below the middle of the box, which lies on a wedge's slope.
        const middle = [2 * 16 + 80, 3 * 16 + 64, -(16 + 52)];
        for (const f of meshPropModel(m)) {
          // In map coordinates the first three corners wind with their cross product pointing into the part.
          const n = crossOf(minus(f.points[1], f.points[0]), minus(f.points[2], f.points[0]));
          const centroid = [0, 1, 2].map((i) => f.points.reduce((s, p) => s + p[i], 0) / 4);
          expect(dotOf(n, minus(middle, centroid)), `${shape} turn ${turn}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('writes triangles as quads with a fourth corner on the longest edge', () => {
    const faces = meshPropModel(model([part('pyramid', 0, 0, 0, 16, 16, 8)]));
    expect(faces.length).toBe(4);
    for (const f of faces) {
      const [a, b, c, m] = f.points;
      // The first three are a real triangle; the fourth lies on the edge from the third back to the first.
      expect(Math.hypot(...crossOf(minus(b, a), minus(c, a)))).toBeGreaterThan(0);
      expect(crossOf(minus(m, c), minus(a, c)).map(Math.abs)).toEqual([0, 0, 0]);
      expect(m).not.toEqual(c);
    }
  });

  it('leaves out faces hidden against other parts and faces that point down', () => {
    // Two boxes side by side lose the sides they share.
    expect(meshPropModel(model([part('box', 0, 0, 0, 8, 8, 4), part('box', 8, 0, 0, 8, 8, 4)])).length).toBe(8);
    // A box on a box of the same size hides the lower top; the floating one's underside is never written.
    const stacked = meshPropModel(model([part('box', 0, 0, 0, 8, 8, 4), part('box', 0, 0, 4, 8, 8, 4)]));
    expect(stacked.length).toBe(9);
    expect(stacked.filter((f) => f.op === OP_FLOOR).length).toBe(1);
  });

  it('turns parts about their middle', () => {
    const p = part('wedge', 0, 0, 0, 10, 4, 4);
    turnPart(p);
    expect([p.x, p.y, p.w, p.d, p.turn]).toEqual([3, 0, 4, 10, 1]);
  });

  it('bakes textures at natural size and blocks the quarter-cells it stands in', () => {
    const p = project();
    const m = addModel(p, model([part('box', 0, 0, 0, 8, 8, 8)], 5));
    const ground = p.groups[0].layers[0];
    ground.cells[cellIndex(ground, 4, 4)] = m.definitionId;
    const { def, compiled } = definitionAt(p, 4, 4);
    expect(flagsOf(def.meta)).toBe(0x0005);
    expect(maskOf(def.meta)).toBe(0xcc00); // the north-west 2 x 2 quarter-cells
    expect(def.commands.length).toBe(5);
    // Every face is part of a tile, so each uses a baked tile and stays an ordinary opaque face.
    expect(compiled.stats.generatedTiles).toBeGreaterThan(0);
    expect(def.commands.every((c) => (c.texture! & TEXTURE_INDEX_MASK) >= 8 && !(c.texture! & TEXTURE_MASKED))).toBe(true);
    const bank = decodeTerrainBank(compiled.terrainBytes!);
    const top = def.commands.find((c) => c.op === OP_FLOOR)!;
    expect(bank[top.texture! & TEXTURE_INDEX_MASK].every((v) => v === 6)).toBe(true); // tile 5 is filled with index 6
    // Stretched mapping generates nothing.
    m.mapping = 'stretch';
    expect(compileProject(p).stats.generatedTiles).toBe(0);
    // A part overhead (a lintel) does not block.
    m.parts.push(part('box', 8, 8, 10, 8, 8, 2, { tile: 5 }));
    expect(maskOf(buildPropDefinition(m).meta)).toBe(0xcc00);
  });

  it('turns props saved as blocks into boxes, keeping their paint', () => {
    const voxels = new Uint8Array(512);
    for (let z = 0; z < 3; z++) for (let y = 1; y < 7; y++) for (let x = 2; x < 6; x++) voxels[x + y * 8 + z * 64] = 1;
    // Unpainted, it is one box.
    expect(partsFromBlocks(voxels, 3, new Map())).toEqual([{ shape: 'box', x: 4, y: 2, z: 0, w: 8, d: 12, h: 6, turn: 0, tile: 3 }]);
    // One block painted differently on top is kept apart, with its paint.
    const paint = new Map([[(2 + 1 * 8 + 2 * 64) * 5 + 0, 7]]);
    const parts = partsFromBlocks(voxels, 3, paint);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((p) => p.faces?.[0] === 7 && p.w === 2 && p.d === 2 && p.h === 2)).toBe(true);
    expect(parts.reduce((n, p) => n + (p.w * p.d * p.h) / 8, 0)).toBe(4 * 6 * 3);
  });
});

describe('stacked props', () => {
  it('keeps the floor under a prop and can make the stack shootable over an exit', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    const wall = addModel(p, model([part('box', 6, 0, 0, 2, 16, 16)], 4));
    const index = cellIndex(ground, 5, 5);
    ground.surfaces.set(index, { kind: 'floor', tile: 2, turn: 0 });
    ground.behaviors.set(index, { kind: 'exit' });
    ground.overlays.set(index, { props: [wall.definitionId], breakable: { toughness: 1, effect: 8 } });
    const { def, map } = definitionAt(p, 5, 5);
    // Floor first, then the wall's faces; the wall's footprint blocks one strip of the cell.
    expect(def.commands[0]).toMatchObject({ op: OP_FLOOR, texture: 2 });
    expect(def.commands.length).toBe(1 + 5);
    expect(flagsOf(def.meta) & 0x0007).toBe(0x0005);
    expect(maskOf(def.meta)).toBe(0x4444);
    // While it stands the cell is destructible and not an exit; what it leaves is the exit floor.
    expect(flagsOf(def.meta) & FLAG_DESTRUCTIBLE).toBeTruthy();
    expect(definitionClass(def.meta)).toBe(0);
    const under = map.definitions[decodeDestructible(def.meta)!.replaceWith];
    expect(definitionClass(under.meta)).toBe(CLASS_EXIT);
    expect(under.commands.length).toBe(1);
    // Without the breakable switch the exit stays an exit under the prop.
    ground.overlays.get(index)!.breakable = undefined;
    expect(definitionClass(definitionAt(p, 5, 5).def.meta)).toBe(CLASS_EXIT);
  });
});

describe('paths and sounds', () => {
  it('writes paths with their mode and links followers', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    const points = [
      [2, 2],
      [5, 2],
      [5, 5],
    ].map(([x, y]) => ({ x: x * 256 + 128, y: y * 256 + 128, tail0: 0, tail1: 0 }));
    p.paths.push({ id: 40, word0: PATH_LOOP, flag: false, group: 0, layer: 0, points });
    ground.entities.push({ id: p.nextId++, type: 3, behavior: 5, weapon: 0, bit8: 0, x: 640, y: 640, disabled: false, pathId: 40, flagsRest: 0 });
    const { map } = definitionAt(p, 0, 0);
    expect(map.paths.length).toBe(1);
    expect(map.paths[0].word0).toBe(PATH_LOOP);
    expect(map.paths[0].points.map((pt) => [pt.x, pt.y])).toEqual([
      [640, 640],
      [1408, 640],
      [1408, 1408],
    ]);
    expect(map.groups[0].layers[0].objects.find((o) => (o.typeWord & 0xff) === 3)!.pathIndex).toBe(0);
    p.paths[0].word0 = PATH_ZONE;
    p.paths[0].points.pop();
    // A zone with the wrong number of points is reported but still compiles: retail maps contain some.
    expect(compileProject(p).issues.some((i) => i.level === 'warning' && /three points/.test(i.message))).toBe(true);
  });

  it('hands custom sound emitters to the runtime instead of writing map objects', () => {
    const p = project();
    const ground = p.groups[0].layers[0];
    p.sounds.push({ id: 77, name: 'drip', wav: Uint8Array.of(82, 73, 70, 70) });
    ground.entities.push({ id: p.nextId++, type: 39, behavior: 0, weapon: 0, bit8: 0, x: 900, y: 300, disabled: false, pathId: null, flagsRest: 0, sound: { id: 77, delay: 2.5, random: 1 } });
    const compiled = compileProject(p);
    expect(compiled.stats.objects).toBe(1);
    expect(compiled.sounds).toEqual([{ sound: 77, group: 0, layer: 0, x: 900, y: 300, delay: 2.5, random: 1 }]);
    const files = unzipStored(buildMhproject(p).bytes);
    expect(files.get('runtime/sounds/77.wav')).toEqual(p.sounds[0].wav);
    expect(JSON.parse(fromUtf8(files.get('runtime/manifest.json')!)).sounds).toEqual([{ file: 'runtime/sounds/77.wav', group: 0, layer: 0, x: 900, y: 300, delay_ms: 2500, random_ms: 1000 }]);
    // Everything new survives a save and reload.
    ground.overlays.set(3, { props: [1], breakable: { toughness: 9, effect: 8 } });
    const restored = deserializeProject(serializeProject(p));
    expect(serializeProject(restored)).toBe(serializeProject(p));
    expect(restored.sounds[0].wav).toEqual(p.sounds[0].wav);
  });
});
