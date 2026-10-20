import { describe, expect, it } from 'vitest';
import {
  CLASS_EXIT,
  CLASS_TELEPORTER,
  CompileError,
  DEFINITION_MASK,
  type GameMap,
  type MapProject,
  OP_FLOOR,
  OP_SLOPE_X,
  TEXTURE_MASKED,
  TEXTURE_ADDITIVE,
  buildMhproject,
  cellIndex,
  compileProject,
  createLayer,
  createProject,
  decodeBehavior,
  decodeTerrainBank,
  definitionClass,
  deserializeProject,
  flagsOf,
  fromUtf8,
  makeWall,
  maskOf,
  openMhproject,
  parseMap,
  projectFromMap,
  readLevelTable,
  serializeProject,
  unzipStored,
  uvRotation,
  wallKey,
} from '../src/index.ts';
import { gameArchive, hasGameData, retailExe } from './game.ts';

const blankTiles = (count: number) => Array.from({ length: count }, (_, i) => new Uint8Array(4096).fill((i % 200) + 1));

function demoProject(): MapProject {
  const project = createProject({ name: 'Unit test map', baseLevel: 'MARS', width: 12, height: 10, tiles: blankTiles(8) });
  const ground = project.groups[0].layers[0];
  const upper = createLayer('Upper', 12, 10);
  project.groups[0].layers.push(upper);

  // A 6x5 room with a perimeter wall.
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 6; x++) ground.surfaces.set(cellIndex(ground, x, y), { kind: 'floor', tile: 2, turn: 0 });
  const wall = (ax: number, ay: number, bx: number, by: number) => {
    const w = makeWall(ax, ay, bx, by, 3);
    ground.walls.set(wallKey(w.x0, w.y0, w.x1, w.y1), w);
  };
  for (let x = 1; x <= 6; x++) {
    wall(x, 1, x + 1, 1);
    wall(x, 6, x + 1, 6);
  }
  for (let y = 1; y <= 5; y++) {
    wall(1, y, 1, y + 1);
    wall(7, y, 7, y + 1);
  }
  // An east-rising ramp to the upper layer, with its landing cell above.
  ground.surfaces.set(cellIndex(ground, 8, 3), { kind: 'ramp', direction: 'east', half: 'lower', tile: 4, turn: 1, sides: { north: 5, south: 6, east: 5 } });
  ground.surfaces.set(cellIndex(ground, 9, 3), { kind: 'ramp', direction: 'east', half: 'upper', tile: 4, turn: 1, sides: { north: 5, south: 6, east: 5 } });
  upper.surfaces.set(cellIndex(upper, 9, 3), { kind: 'landing', direction: 'east' });
  upper.surfaces.set(cellIndex(upper, 10, 3), { kind: 'floor', tile: 2, turn: 0 });
  // A split floor with one half and its diagonal wall.
  ground.surfaces.set(cellIndex(ground, 3, 7), { kind: 'split', diagonal: 'nw-se', halves: { ne: { tile: 2 } } });
  const diagonal = makeWall(3, 7, 4, 8, 3);
  ground.walls.set(wallKey(diagonal.x0, diagonal.y0, diagonal.x1, diagonal.y1), diagonal);
  // Behaviors.
  ground.behaviors.set(cellIndex(ground, 2, 2), { kind: 'teleporter', group: 0, layer: 1, x: 10, y: 3, facing: 4 });
  ground.behaviors.set(cellIndex(ground, 6, 5), { kind: 'exit' });
  // Entities: player start and two robots in the same row (out of X order on purpose).
  ground.entities.push({ id: project.nextId++, type: 1, behavior: 0, weapon: 0, bit8: 0, x: 3 * 256 + 128, y: 3 * 256 + 128, disabled: false, pathId: null, flagsRest: 0 });
  ground.entities.push({ id: project.nextId++, type: 3, behavior: 6, weapon: 1, bit8: 0, x: 5 * 256 + 10, y: 4 * 256 + 200, disabled: false, pathId: null, flagsRest: 0 });
  ground.entities.push({ id: project.nextId++, type: 4, behavior: 0, weapon: 0, bit8: 0, x: 2 * 256 + 10, y: 4 * 256 + 20, disabled: true, pathId: null, flagsRest: 0 });
  return project;
}

describe('compiling an authored map', () => {
  const project = demoProject();
  const compiled = compileProject(project);
  const map = parseMap(compiled.mapBytes, { lmp: compiled.lmpBytes });
  const defAt = (layer: number, x: number, y: number) => map.definitions[map.groups[0].layers[layer].cells[y * 12 + x] & DEFINITION_MASK];

  it('produces a loadable two-layer map', () => {
    expect(map.groups.length).toBe(1);
    expect(map.groups[0].layers.map((l) => [l.width, l.height])).toEqual([
      [12, 10],
      [12, 10],
    ]);
    expect(compiled.stats.objects).toBe(3);
    expect(map.info.incompleteDefinitions).toEqual([]);
  });

  it('de-duplicates definitions', () => {
    // Interior floor cells all share one definition.
    const interior = new Set<number>();
    for (let y = 2; y <= 4; y++) for (let x = 3; x <= 5; x++) interior.add(map.groups[0].layers[0].cells[y * 12 + x]);
    expect(interior.size).toBe(1);
    expect(map.definitions.length).toBeLessThan(24);
  });

  it('keeps perimeter wall collision outside the walkable room', () => {
    const corner = defAt(0, 1, 1);
    expect(flagsOf(corner.meta)).toBe(1);
    expect(maskOf(corner.meta)).toBe(0);
    const north = defAt(0, 1, 0), west = defAt(0, 0, 1);
    expect(maskOf(north.meta)).toBe(0x000f);
    expect(maskOf(west.meta)).toBe(0x1111);
    expect(north.commands.length).toBe(2);
    expect(north.automap).not.toBeNull();
    expect(west.automap).not.toBeNull();
  });

  it('encodes ramps with matching collision bands and an upright-uphill texture', () => {
    const lower = defAt(0, 8, 3);
    const upper = defAt(0, 9, 3);
    const landing = defAt(1, 9, 3);
    expect(flagsOf(lower.meta)).toBe(0x0009);
    expect(flagsOf(upper.meta)).toBe(0x0011);
    expect(flagsOf(landing.meta)).toBe(0x0019);
    expect(landing.commands.length).toBe(0);
    const slope = upper.commands.find((c) => c.op === OP_SLOPE_X)!;
    // Vertex receiving the tile's top-left texel sits on the high (east) edge.
    const pinned = slope.indices[uvRotation(slope.op)];
    expect([upper.vertices[pinned * 3], upper.vertices[pinned * 3 + 2]]).toEqual([256, -256]);
    // Side walls use generated cut tiles.
    expect(upper.commands.some((c) => c.texture !== null && c.texture & TEXTURE_MASKED)).toBe(true);
    expect(compiled.stats.generatedTiles).toBeGreaterThan(0);
    expect(decodeTerrainBank(compiled.terrainBytes!).length).toBe(8 + compiled.stats.generatedTiles);
  });

  it('makes the missing half of a split floor the solid side of its diagonal wall', () => {
    const cell = defAt(0, 3, 7);
    // "\" family; the NE half is floor, so the SW half (side 1) is solid.
    expect(flagsOf(cell.meta)).toBe(0x0183);
  });

  it('applies behaviors without disturbing collision', () => {
    const teleporter = defAt(0, 2, 2);
    expect(definitionClass(teleporter.meta)).toBe(CLASS_TELEPORTER);
    expect(decodeBehavior(teleporter.meta)).toEqual({ kind: 'teleporter', group: 0, layer: 1, x: 10, y: 3, facing: 4 });
    expect(flagsOf(teleporter.meta) & 0x0007).toBe(0x0001);
    expect(definitionClass(defAt(0, 6, 5).meta)).toBe(CLASS_EXIT);
  });

  it('links objects in row/X order with their placement bits', () => {
    const objects = map.groups[0].layers[0].objects;
    expect(objects.map((o) => o.typeWord & 0xff)).toEqual([1, 4, 3]);
    expect(objects[2].typeWord).toBe(3 | (6 << 9) | (1 << 14));
    expect(objects[1].flags & 1).toBe(1);
  });

  it('refuses maps the engine could not start', () => {
    const broken = demoProject();
    broken.groups[0].layers[0].entities = broken.groups[0].layers[0].entities.filter((e) => e.type !== 1);
    expect(() => compileProject(broken)).toThrow(CompileError);
    const bad = demoProject();
    bad.groups[0].layers[0].behaviors.set(0, { kind: 'teleporter', group: 2, layer: 0, x: 0, y: 0, facing: null });
    expect(() => compileProject(bad)).toThrow(/teleporter/i);
  });
});

describe('project files', () => {
  it('serialises and restores a project exactly', () => {
    const project = demoProject();
    project.briefing = { mode: 'custom', title: 'Test', text: 'LINE ONE\nLINE TWO', image: null };
    const restored = deserializeProject(serializeProject(project));
    expect(serializeProject(restored)).toBe(serializeProject(project));
    expect(compileProject(restored).mapBytes).toEqual(compileProject(project).mapBytes);
  });

  it('packages a playable .mhproject the runtime contract expects', () => {
    const project = demoProject();
    project.briefing = { mode: 'custom', title: 'Deep storage', text: 'Find the exit.\nMind the "robots".', image: null };
    const built = buildMhproject(project);
    expect(built.playable).toBe(true);
    const files = unzipStored(built.bytes);
    const manifest = JSON.parse(fromUtf8(files.get('manifest.json')!));
    expect(manifest.format).toBe('mhproject-v2');
    expect(manifest.runtime).toBe('runtime/manifest.json');
    const runtime = JSON.parse(fromUtf8(files.get('runtime/manifest.json')!));
    expect(runtime.format).toBe(1);
    expect(runtime.base_level).toBe('MARS');
    expect(runtime.initial_group).toBe(0);
    expect(runtime.assets).toEqual({ base: 'MARS', lmp: 'runtime/level.lmp', terrain: 'runtime/terrain.bin' });
    expect(runtime.briefing).toEqual({ mode: 'custom', text: 'FIND THE EXIT.\nMIND THE "ROBOTS".', title: 'DEEP STORAGE' });
    // The runtime's JSON reader rejects \u escapes in strings it copies.
    expect(fromUtf8(files.get('runtime/manifest.json')!)).not.toMatch(/\\u/);
    expect(files.get('runtime/level.map')).toEqual(built.compiled!.mapBytes);
    expect(serializeProject(openMhproject(built.bytes))).toBe(serializeProject(project));
  });

  it('still saves a project that does not compile', () => {
    const project = demoProject();
    project.groups[0].layers[0].entities = [];
    const built = buildMhproject(project);
    expect(built.playable).toBe(false);
    const files = unzipStored(built.bytes);
    expect(files.has('runtime/level.map')).toBe(false);
    expect(JSON.parse(fromUtf8(files.get('manifest.json')!)).build_error).toMatch(/player start/);
    expect(openMhproject(built.bytes).name).toBe('Unit test map');
  });
});

describe.skipIf(!hasGameData)('retail levels as projects', () => {
  const levels = hasGameData ? readLevelTable(retailExe()).slice(0, 17) : [];

  const cellsAndObjects = (map: GameMap) =>
    map.groups.map((g) => g.layers.map((l) => ({ cells: Array.from(l.cells), objects: l.objects.map((o) => [o.typeWord, o.x, o.y, o.pathIndex, o.flags]) })));

  it.each(levels.map((l) => [l.id, l] as const))('%s imports and recompiles without change', (_id, level) => {
    const arc = gameArchive();
    const original = parseMap(arc.read(level.resources.map), { lmp: arc.read(level.resources.lmp) });
    const project = projectFromMap(original, { name: level.id, baseLevel: level.id, tiles: decodeTerrainBank(arc.read(level.resources.terrain)), initialGroup: level.initialGroup });
    const compiled = compileProject(project);
    expect(compiled.terrainBytes).toBeNull();
    const again = parseMap(compiled.mapBytes, { lmp: compiled.lmpBytes });
    expect(cellsAndObjects(again)).toEqual(cellsAndObjects(original));
    expect(again.definitions.length).toBe(original.definitions.length);
    expect(again.paths).toEqual(original.paths);
    // And it survives a save/load cycle.
    expect(compileProject(deserializeProject(serializeProject(project))).mapBytes).toEqual(compiled.mapBytes);
  });
});


describe('block face visibility during compilation', () => {
  const block = () => ({kind: 'block' as const,height:1,topTile:0,sides:{north:0,east:0,south:0,west:0},pillar:false,floorTile:null});
  function setup() {
    const p = demoProject(), l = p.groups[0].layers[0];
    l.surfaces.set(3*12+3,block()); l.surfaces.set(3*12+4,block());
    return p;
  }
  const faces = (p: MapProject) => { const c=compileProject(p); return c.map.definitions[c.map.groups[0].layers[0].cells[3*12+3]&2047].commands.length; };
  it('omits a side buried against another opaque full block', () => {
    expect(faces(setup())).toBe(4);
  });
  it('keeps faces behind a breakable or trigger-replaced neighbor', () => {
    const p=setup(),l=p.groups[0].layers[0];
    l.behaviors.set(3*12+4,{kind:'breakable',toughness:10,effect:0,leaves:0});
    expect(faces(p)).toBe(5);
    l.behaviors.delete(3*12+4);
    p.triggers.push({name:'Break neighbor',channel:6,once:true,actions:[{kind:'break',group:0,layer:0,x:4,y:3}]});
    expect(faces(p)).toBe(5);
  });
  it('keeps faces behind narrow, shorter or see-through neighbors', () => {
    for(const patch of [{pillar:true,width:0.5},{height:0.5},{topTile:TEXTURE_MASKED},{topTile:TEXTURE_ADDITIVE}]) {
      const p=setup();Object.assign(p.groups[0].layers[0].surfaces.get(3*12+4)!,patch);
      expect(faces(p)).toBe(5);
    }
  });
  it('omits the top buried under a block on the next layer', () => {
    const p=setup();p.groups[0].layers[1].surfaces.set(3*12+3,block());
    expect(faces(p)).toBe(3);
    const c=compileProject(p),d=c.map.definitions[c.map.groups[0].layers[0].cells[3*12+3]&2047];
    expect(d.automap).not.toBeNull();
    expect([...d.automap!].filter((i)=>i!==0xffff).every((i)=>i<d.vertices.length/3)).toBe(true);
  });
});


it('preserves full width in one-cell corridors in both directions', () => {
  for (const ns of [true,false]) {
    const p=createProject({name:'Corridor',baseLevel:'MARS',width:8,height:8,tiles:blankTiles(1)}),l=p.groups[0].layers[0];
    for(let i=1;i<7;i++) {
      const x=ns?3:i,y=ns?i:3;
      l.surfaces.set(y*8+x,{kind:'floor',tile:0,turn:0});
      for(const offset of [0,1]) {
        const w=ns?makeWall(3+offset,i,3+offset,i+1,0):makeWall(i,3+offset,i+1,3+offset,0);
        l.walls.set(wallKey(w.x0,w.y0,w.x1,w.y1),w);
      }
    }
    l.entities.push({id:p.nextId++,type:1,x:3*256+128,y:3*256+128,behavior:0,weapon:0,bit8:0,pathId:null,disabled:false,flagsRest:0});
    const c=compileProject(p);
    for(let i=1;i<7;i++) {
      const index=ns?i*8+3:3*8+i,d=c.map.definitions[c.map.groups[0].layers[0].cells[index]&2047];
      expect(flagsOf(d.meta)).toBe(1);expect(maskOf(d.meta)).toBe(0);
    }
  }
});
