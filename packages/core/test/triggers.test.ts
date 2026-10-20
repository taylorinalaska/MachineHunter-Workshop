/** Breakables that turn into a broken version of themselves, see-through walls, and triggers. */
import { describe, expect, it } from 'vitest';
import { type MapProject, TEXTURE_INDEX_MASK, TEXTURE_MASKED, buildMhproject, compileProject, createProject, decodeDestructible, deserializeProject, flagsOf, fromUtf8, serializeProject, unzipStored, validateProject, wallKey } from '../src/index.ts';

function room(): MapProject {
  const tiles = [0, 1, 2, 3].map((i) => new Uint8Array(64 * 64).fill(i + 1));
  const p = createProject({ name: 'Triggers', baseLevel: 'MARS', width: 8, height: 8, tiles });
  const layer = p.groups[0].layers[0];
  for (let i = 0; i < layer.cells.length; i++) layer.surfaces.set(i, { kind: 'floor', tile: 0, turn: 0 });
  layer.entities.push({ id: p.nextId++, type: 1, x: 128, y: 128, behavior: 0, weapon: 0, bit8: 0, pathId: null, disabled: false, flagsRest: 0 });
  return p;
}

const at = (p: MapProject, x: number, y: number) => y * p.groups[0].layers[0].width + x;
const cellDef = (c: ReturnType<typeof compileProject>, p: MapProject, x: number, y: number) => c.map.definitions[c.map.groups[0].layers[0].cells[at(p, x, y)] & 0x7ff];

describe('breakables', () => {
  it('can turn into a broken version of themselves: same shape, still solid, broken tile on the walls', () => {
    const p = room();
    const layer = p.groups[0].layers[0];
    layer.surfaces.set(at(p, 3, 3), { kind: 'block', height: 1, topTile: 0, sides: { north: 1, east: 1, south: 1, west: 1 }, pillar: false, floorTile: null });
    layer.behaviors.set(at(p, 3, 3), { kind: 'breakable', toughness: 20, effect: 8, leaves: 0, result: 'broken', broken: 2 });
    const c = compileProject(p);
    const before = cellDef(c, p, 3, 3);
    const after = c.map.definitions[decodeDestructible(before.meta)!.replaceWith];
    expect(after.commands.length).toBe(before.commands.length);
    expect(flagsOf(after.meta) & 0x8000).toBe(flagsOf(before.meta) & 0x8000);
    expect(decodeDestructible(after.meta)).toBeNull();
    // The sides take the broken tile; the top keeps its own.
    const tiles = (d: typeof after) => d.commands.map((cmd) => (cmd.op === 7 ? 'top' : cmd.texture! & TEXTURE_INDEX_MASK));
    expect(tiles(after).filter((t) => t !== 'top').every((t) => t === 2)).toBe(true);
    expect(after.commands.find((cmd) => cmd.op === 7)!.texture).toBe(before.commands.find((cmd) => cmd.op === 7)!.texture);
  });

  it('keep a see-through wall see-through when it breaks, as a broken window', () => {
    const p = room();
    const layer = p.groups[0].layers[0];
    layer.walls.set(wallKey(3, 3, 4, 3), { x0: 3, y0: 3, x1: 4, y1: 3, height: 1, tile: 1 | TEXTURE_MASKED, side: 0 });
    layer.behaviors.set(at(p, 3, 2), { kind: 'breakable', toughness: 1, effect: 8, leaves: 0, result: 'broken', broken: 3 });
    const c = compileProject(p);
    const before = cellDef(c, p, 3, 2);
    const wall = before.commands.find((cmd) => cmd.op !== 7)!;
    expect(wall.texture! & TEXTURE_MASKED).toBeTruthy();
    const after = c.map.definitions[decodeDestructible(before.meta)!.replaceWith];
    const broken = after.commands.find((cmd) => cmd.op !== 7)!;
    expect(broken.texture).toBe(3 | TEXTURE_MASKED);
  });
});

describe('triggers', () => {
  function triggered() {
    const p = room();
    const layer = p.groups[0].layers[0];
    layer.behaviors.set(at(p, 1, 1), { kind: 'switch', channel: 6 });
    layer.behaviors.set(at(p, 5, 5), { kind: 'breakable', toughness: 30, effect: 26, leaves: 0 });
    const hidden = { id: p.nextId++, type: 3, x: 6 * 256 + 128, y: 2 * 256 + 128, behavior: 0, weapon: 0, bit8: 0, pathId: null, disabled: true, flagsRest: 0 };
    layer.entities.push(hidden);
    p.effects.push({ id: 900, name: 'Boom', every: 30, particles: [{ fx: 0x7d, spread: 16 }] });
    p.triggers.push({
      channel: 6,
      name: 'Ambush',
      once: true,
      actions: [
        { kind: 'break', group: 0, layer: 0, x: 5, y: 5 },
        { kind: 'retexture', group: 0, layer: 0, x: 4, y: 4, tile: 2, faces: 'floor' },
        { kind: 'effect', group: 0, layer: 0, x: 5 * 256 + 128, y: 5 * 256 + 128, effect: 900 },
        { kind: 'reveal', group: 0, layer: 0, entity: hidden.id },
      ],
    });
    return { p, hidden };
  }

  it('go to the runtime with every action resolved', () => {
    const { p, hidden } = triggered();
    expect(validateProject(p).filter((i) => i.level !== 'info')).toEqual([]);
    const c = compileProject(p);
    const manifest = JSON.parse(fromUtf8(unzipStored(buildMhproject(p).bytes).get('runtime/manifest.json')!));
    expect(manifest.switches).toEqual([{ group: 0, layer: 0, x: 1, y: 1, channel: 6 }]);
    const [t] = manifest.triggers;
    expect(t).toMatchObject({ channel: 6, once: 1 });
    expect(t.actions[0]).toEqual({ kind: 'break', group: 0, layer: 0, x: 5, y: 5 });
    // The changed cell is a definition of its own: the same floor with tile 2.
    expect(t.actions[1]).toMatchObject({ kind: 'cell', group: 0, layer: 0, x: 4, y: 4 });
    const changed = c.map.definitions[t.actions[1].definition];
    expect(changed.commands[0].texture! & TEXTURE_INDEX_MASK).toBe(2);
    expect(cellDef(c, p, 4, 4).commands[0].texture! & TEXTURE_INDEX_MASK).toBe(0);
    expect(t.actions[2]).toEqual({ kind: 'effect', group: 0, layer: 0, x: 5 * 256 + 128, y: 5 * 256 + 128, z: 0, particles: [{ fx: 0x7d, spread: 16 }] });
    expect(t.actions[3]).toEqual({ kind: 'reveal', group: 0, layer: 0, x: hidden.x, y: hidden.y, type: 3 });
  });

  it('are checked', () => {
    const { p, hidden } = triggered();
    p.groups[0].layers[0].behaviors.delete(at(p, 5, 5));
    hidden.disabled = false;
    p.triggers[0].actions.push({ kind: 'effect', group: 0, layer: 0, x: 0, y: 0, effect: 12345 });
    const messages = validateProject(p).map((i) => i.message).join(' ');
    expect(messages).toMatch(/breaks a cell that is not breakable/);
    expect(messages).toMatch(/already there: set it to start disabled/);
    expect(messages).toMatch(/plays an effect that is not in the map/);
  });

  it('survive a save and reload', () => {
    const { p } = triggered();
    const restored = deserializeProject(serializeProject(p));
    expect(restored.triggers).toEqual(p.triggers);
  });
});
