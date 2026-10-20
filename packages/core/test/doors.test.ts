import { describe, expect, it } from 'vitest';
import { CLASS_SEQUENCE, DOOR_STEPS, type MapProject, buildMhproject, compileProject, createProject, decodeBehavior, definitionClass, flagsOf, fromUtf8, maskOf, unzipStored, validateProject } from '../src/index.ts';

function room(): MapProject {
  const p = createProject({ name: 'Doors', baseLevel: 'MARS', width: 8, height: 8, tiles: [new Uint8Array(64 * 64), new Uint8Array(64 * 64)] });
  const layer = p.groups[0].layers[0];
  for (let i = 0; i < layer.cells.length; i++) layer.surfaces.set(i, { kind: 'floor', tile: 0, turn: 0 });
  layer.entities.push({ id: p.nextId++, type: 1, x: 128, y: 128, behavior: 0, weapon: 0, bit8: 0, pathId: null, disabled: false } as MapProject['groups'][0]['layers'][0]['entities'][0]);
  return p;
}

const at = (p: MapProject, x: number, y: number) => y * p.groups[0].layers[0].width + x;

describe('doors', () => {
  it('compile to a chain of panels that ends on the open floor', () => {
    const p = room();
    p.groups[0].layers[0].behaviors.set(at(p, 3, 3), { kind: 'door', lock: 2, tile: 1, facing: 'ns' });
    const c = compileProject(p);
    const defs = c.map.definitions;
    let id = c.map.groups[0].layers[0].cells[at(p, 3, 3)] & 0x7ff;
    const masks: number[] = [];
    for (let k = 0; k < DOOR_STEPS; k++) {
      const meta = defs[id].meta;
      expect(definitionClass(meta)).toBe(CLASS_SEQUENCE);
      const b = decodeBehavior(meta);
      expect(b).toMatchObject({ kind: 'sequence', gate: 2, pair: 0 });
      masks.push(maskOf(meta));
      id = (b as { next: number }).next;
    }
    // The end of the chain is the cell without its door.
    expect(definitionClass(defs[id].meta)).toBe(0);
    expect(id).toBe(c.map.groups[0].layers[0].cells[at(p, 2, 3)] & 0x7ff);
    // An east-west panel blocks the middle two rows, as the retail doors do, until it is nearly down.
    expect(masks[0]).toBe(0x0ff0);
    expect(masks[DOOR_STEPS - 1]).toBe(0);
  });

  it('can rise into the ceiling, as the retail doors of ALIEN1 do', () => {
    const p = room();
    p.groups[0].layers[0].behaviors.set(at(p, 3, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns', style: 'rise' });
    const c = compileProject(p);
    const defs = c.map.definitions;
    let id = c.map.groups[0].layers[0].cells[at(p, 3, 3)] & 0x7ff;
    const masks: number[] = [];
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (let k = 0; k < DOOR_STEPS; k++) {
      const def = defs[id];
      masks.push(maskOf(def.meta));
      // The panel's corners (the floor under it is at height 0).
      const zs: number[] = [];
      for (let i = 2; i < def.vertices.length; i += 3) if (def.vertices[i] !== 0) zs.push(-def.vertices[i]);
      tops.push(Math.max(...zs));
      bottoms.push(Math.min(...zs.filter((z) => z > 0), Infinity));
      id = (decodeBehavior(def.meta) as { next: number }).next;
    }
    // A full-height panel lifted an eighth (32 units) a step, up past the ceiling: the retail chain's heights.
    expect(tops).toEqual([256, 288, 320, 352, 384, 416, 448, 480]);
    expect(bottoms.slice(1)).toEqual([32, 64, 96, 128, 160, 192, 224]);
    // It blocks until the last step, as there.
    expect(masks.slice(0, DOOR_STEPS - 1).every((m) => m === 0x0ff0)).toBe(true);
    expect(masks[DOOR_STEPS - 1]).toBe(0);
  });

  it('can slide sideways into the wall, as the retail doors of HOSP0 do', () => {
    const p = room();
    const b = p.groups[0].layers[0].behaviors;
    // A double door, west and east halves, and a door on its own running north-south.
    b.set(at(p, 3, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns', style: 'slide' });
    b.set(at(p, 4, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns', style: 'slide' });
    b.set(at(p, 6, 5), { kind: 'door', lock: 0, tile: 1, facing: 'ew', style: 'slide' });
    const c = compileProject(p);
    const masks = (x: number, y: number) => {
      let id = c.map.groups[0].layers[0].cells[at(p, x, y)] & 0x7ff;
      const out: number[] = [];
      for (let k = 0; k < DOOR_STEPS; k++) {
        out.push(maskOf(c.map.definitions[id].meta));
        id = (decodeBehavior(c.map.definitions[id].meta) as { next: number }).next;
      }
      return out.map((m) => m.toString(16).padStart(4, '0'));
    };
    // HOSP0's chains, step for step: the halves part in the middle, each into its own side.
    expect(masks(3, 3)).toEqual(['0ff0', '0ff0', '0ee0', '0ee0', '0cc0', '0cc0', '0880', '0880']);
    expect(masks(4, 3)).toEqual(['0ff0', '0ff0', '0770', '0770', '0330', '0330', '0110', '0110']);
    expect(masks(6, 5)).toEqual(['6666', '6666', '6660', '6660', '6600', '6600', '6000', '6000']);
  });

  it('need no floor: on an empty cell the door opens onto ground with nothing drawn', () => {
    const p = room();
    const layer = p.groups[0].layers[0];
    layer.surfaces.delete(at(p, 3, 3));
    layer.behaviors.set(at(p, 3, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns', style: 'rise' });
    expect(validateProject(p).filter((i) => i.level === 'error')).toEqual([]);
    const c = compileProject(p);
    let id = c.map.groups[0].layers[0].cells[at(p, 3, 3)] & 0x7ff;
    for (let k = 0; k < DOOR_STEPS; k++) id = (decodeBehavior(c.map.definitions[id].meta) as { next: number }).next;
    // The open cell: walkable, no faces.
    expect(c.map.definitions[id].commands.length).toBe(0);
    expect(flagsOf(c.map.definitions[id].meta) & 0x0007).toBe(0x0001);
  });

  it('pair along the panel when they share a lock and a facing', () => {
    const p = room();
    const b = p.groups[0].layers[0].behaviors;
    b.set(at(p, 3, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns' });
    b.set(at(p, 4, 3), { kind: 'door', lock: 0, tile: 1, facing: 'ns' });
    b.set(at(p, 3, 5), { kind: 'door', lock: 0, tile: 1, facing: 'ew' });
    b.set(at(p, 3, 6), { kind: 'door', lock: 1, tile: 1, facing: 'ew' });
    const c = compileProject(p);
    const pair = (x: number, y: number) => (decodeBehavior(c.map.definitions[c.map.groups[0].layers[0].cells[at(p, x, y)] & 0x7ff].meta) as { pair: number }).pair;
    expect([pair(3, 3), pair(4, 3)]).toEqual([1, 2]);
    // Different locks do not pair.
    expect([pair(3, 5), pair(3, 6)]).toEqual([0, 0]);
  });

  it('give the runtime the switches and the doors they open', () => {
    const p = room();
    const b = p.groups[0].layers[0].behaviors;
    b.set(at(p, 3, 3), { kind: 'door', lock: 6, tile: 1, facing: 'ns' });
    b.set(at(p, 1, 1), { kind: 'switch', channel: 6 });
    const manifest = JSON.parse(fromUtf8(unzipStored(buildMhproject(p).bytes).get('runtime/manifest.json')!));
    expect(manifest.switches).toEqual([{ group: 0, layer: 0, x: 1, y: 1, channel: 6 }]);
    expect(manifest.doors).toEqual([{ group: 0, layer: 0, x: 3, y: 3, lock: 6, axis: 1 }]);
  });

  it('includes key-locked doors in runtime feedback even without switches', () => {
    const p = room();
    p.groups[0].layers[0].behaviors.set(at(p, 3, 3), { kind: 'door', lock: 1, tile: 1, facing: 'ns' });
    const manifest = JSON.parse(fromUtf8(unzipStored(buildMhproject(p).bytes).get('runtime/manifest.json')!));
    expect(manifest.doors).toEqual([{ group: 0, layer: 0, x: 3, y: 3, lock: 1, axis: 1 }]);
    expect(manifest.switches).toBeUndefined();
  });

  it('exports direction for every style and touch/key door even with side walls', () => {
    for (const style of ['rise', 'sink', 'slide'] as const) for (const facing of ['ns', 'ew'] as const) for (const lock of [0, 1, 2, 5]) {
      const p=room(),l=p.groups[0].layers[0];
      l.behaviors.set(at(p,3,3),{kind:'door',lock,tile:1,facing,style});
      l.walls.set('side',{x0:3,y0:3,x1:3,y1:4,height:1,tile:0,side:0});
      const manifest=JSON.parse(fromUtf8(unzipStored(buildMhproject(p).bytes).get('runtime/manifest.json')!));
      expect(manifest.doors).toEqual([{group:0,layer:0,x:3,y:3,lock,axis:facing==='ns'?1:2}]);
    }
  });

  it('are checked', () => {
    const p = room();
    const b = p.groups[0].layers[0].behaviors;
    b.set(at(p, 3, 3), { kind: 'door', lock: 7, tile: 1, facing: 'ns' });
    b.set(at(p, 4, 4), { kind: 'door', lock: 3, tile: 1, facing: 'ns' });
    p.groups[0].layers[0].surfaces.set(at(p, 5, 5), { kind: 'block', height: 1, topTile: 1, sides: {}, pillar: false, floorTile: null });
    b.set(at(p, 5, 5), { kind: 'door', lock: 0, tile: 1, facing: 'ns' });
    const messages = validateProject(p).map((i) => i.message).join(' ');
    expect(messages).toMatch(/no switch in the map opens it/);
    expect(messages).toMatch(/needs key 3, but the map has no key 3/);
    expect(messages).toMatch(/cannot stand on a block/);
  });
});
