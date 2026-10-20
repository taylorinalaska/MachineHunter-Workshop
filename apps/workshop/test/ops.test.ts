import { describe, expect, it } from 'vitest';
import { createLayer, createProject, TEXTURE_MASKED, serializeProject, deserializeProject, composeDefinition, ProjectComposer, flagsOf, RAMP_FLAGS, validateProject } from '@mh/core';
import { placeRamp, tileAt, paint, setFloor, createPath, linkTeleporter, placeBlock, removeGroup, removeLayer } from '../src/editor/ops.ts';

/** Three areas; the second has two layers. */
function threeAreas() {
  const p = createProject({ name: 'Test', baseLevel: 'MARS', width: 8, height: 8, tiles: [new Uint8Array(64 * 64)] });
  p.groups.push({ name: 'Two', layers: [createLayer('Ground', 8, 8), createLayer('Upper', 8, 8)] });
  p.groups.push({ name: 'Three', layers: [createLayer('Ground', 8, 8)] });
  return p;
}

const teleporterAt = (p: ReturnType<typeof threeAreas>, g: number, l: number, x: number, y: number) => p.groups[g].layers[l].behaviors.get(y * 8 + x);

describe('removing areas and layers', () => {
  it('keeps teleporters into later areas pointing at the same place', () => {
    const p = threeAreas();
    linkTeleporter(p, { group: 0, layer: 0, x: 1, y: 1 }, { group: 2, layer: 0, x: 3, y: 3 });
    linkTeleporter(p, { group: 0, layer: 0, x: 2, y: 2 }, { group: 1, layer: 0, x: 4, y: 4 });
    p.initialGroup = 2;
    expect(removeGroup(p, 1)).toBe(1);
    expect(teleporterAt(p, 0, 0, 1, 1)).toMatchObject({ kind: 'teleporter', group: 1, layer: 0, x: 3, y: 3 });
    // The teleporter into the removed area is gone, and so is its glow.
    expect(teleporterAt(p, 0, 0, 2, 2)).toBeUndefined();
    expect(p.groups[0].layers[0].entities.filter((e) => e.x >> 8 === 2 && e.y >> 8 === 2)).toHaveLength(0);
    expect(p.groups[0].layers[0].entities.filter((e) => e.x >> 8 === 1 && e.y >> 8 === 1)).toHaveLength(1);
    expect(p.initialGroup).toBe(1);
  });

  it('renumbers layers above a removed one, and drops paths on it', () => {
    const p = threeAreas();
    linkTeleporter(p, { group: 0, layer: 0, x: 1, y: 1 }, { group: 1, layer: 1, x: 3, y: 3 });
    const upper = createPath(p, 1, 1, 1);
    const ground = createPath(p, 1, 0, 1);
    expect(removeLayer(p, 1, 0)).toBe(0);
    expect(teleporterAt(p, 0, 0, 1, 1)).toMatchObject({ group: 1, layer: 0 });
    expect(p.paths.find((x) => x.id === upper.id)).toMatchObject({ group: 1, layer: 0 });
    expect(p.paths.find((x) => x.id === ground.id)).toBeUndefined();
  });
});

describe('pillars', () => {
  const options = { height: 0.5, topTile: 73, sideTile: 4, pillar: true, floorTile: 73 };

  it('keep the floor the cell had, not the top tile', () => {
    const layer = createLayer('Ground', 8, 8);
    layer.surfaces.set(2 * 8 + 2, { kind: 'floor', tile: 9, turn: 0 });
    placeBlock(layer, 2, 2, options);
    expect(layer.surfaces.get(2 * 8 + 2)).toMatchObject({ kind: 'block', pillar: true, topTile: 73, floorTile: 9 });
  });

  it('borrow a neighbor\'s floor on an empty cell, and the brush floor when there is none', () => {
    const layer = createLayer('Ground', 8, 8);
    layer.surfaces.set(3 * 8 + 2, { kind: 'floor', tile: 12, turn: 0 });
    placeBlock(layer, 2, 2, options);
    expect(layer.surfaces.get(2 * 8 + 2)).toMatchObject({ floorTile: 12 });
    placeBlock(layer, 6, 6, options);
    expect(layer.surfaces.get(6 * 8 + 6)).toMatchObject({ floorTile: 73 });
  });
});

it('preserves see-through floors through painting, serialization and geometry composition', () => {
  const p = threeAreas();
  const layer = p.groups[0].layers[0];
  setFloor(layer, 1, 1, 2 | TEXTURE_MASKED, 1);
  expect(paint(layer, { kind: 'cell', x: 1, y: 1, face: 'top' }, 0, 1.5, 1.5)).toBe(true);
  const restored = deserializeProject(serializeProject(p));
  const floor = restored.groups[0].layers[0].surfaces.get(9)!;
  expect(floor).toMatchObject({ kind: 'floor', tile: TEXTURE_MASKED, turn: 1 });
  expect(composeDefinition({ surface: floor, walls: {}, diagonals: [] }, (tile) => tile).commands.some((c) => c.texture === TEXTURE_MASKED)).toBe(true);
});

it.each([0.25, 0.5, 0.75])('places and reopens a centered pillar of width %s, with correct texture picking', (width) => {
  const p = threeAreas();
  const layer = p.groups[0].layers[0];
  placeBlock(layer, 1, 1, { height: 0.75, width, pillar: true, topTile: 7, sideTile: 3, floorTile: 2 });
  const restored = deserializeProject(serializeProject(p)).groups[0].layers[0];
  const block = restored.surfaces.get(9)!;
  expect(block).toMatchObject({ width, height: 0.75, pillar: true });
  const def = composeDefinition({ surface: block, walls: {}, diagonals: [] }, (tile) => tile);
  const top = def.commands.find((c) => c.texture === 7)!;
  const xs = top.indices.map((i) => def.vertices[i * 3]);
  expect(Math.min(...xs)).toBe((1 - width) * 128);
  expect(Math.max(...xs)).toBe((1 + width) * 128);
  const target = { kind: 'cell', x: 1, y: 1, face: 'top' } as const;
  expect(tileAt(restored, 1.5, 1.5, target)).toBe(7);
  expect(tileAt(restored, 1.01, 1.01, target)).toBe(2);
  expect(tileAt(restored, 1.2, 1.5, target)).toBe(width === 0.75 ? 7 : 2);
  paint(restored, target, 6, 1.2, 1.5);
  expect(restored.surfaces.get(9)).toMatchObject(width === 0.75 ? { topTile: 6, floorTile: 2 } : { topTile: 7, floorTile: 6 });
});

describe('ramp layer transitions', () => {
  it.each(['east', 'west', 'north', 'south'] as const)('rebuilds %s landings after floor edits or late layer creation', (direction) => {
    const p = threeAreas();
    const group = p.groups[0];
    // Place the ramp first, then add an upper layer with a different origin.
    expect(placeRamp(p, 0, 0, 3, 3, direction, 0, null)).toBe(true);
    const upper = createLayer('Upper', 8, 8);
    upper.originX = 1;
    upper.originY = -1;
    group.layers.push(upper);
    const high = [...group.layers[0].surfaces.entries()].find(([, s]) => s.kind === 'ramp' && s.half === 'upper')!;
    const x = high[0] % 8 - upper.originX;
    const y = Math.floor(high[0] / 8) - upper.originY;
    const index = y * 8 + x;
    const composer = new ProjectComposer(p, { preview: true });
    const checkLanding = () => {
      const cells = composer.composeLayer(upper);
      const def = composer.definitions[cells[index]];
      expect(flagsOf(def.meta)).toBe(RAMP_FLAGS[direction].upper | 8);
      expect(def.commands).toHaveLength(0);
    };
    checkLanding();
    setFloor(upper, x, y, 0, 0);
    checkLanding();
    expect(upper.surfaces.get(index)?.kind).toBe('floor'); // compilation does not mutate the project
    // Removing the ramp must remove its derived transition on the next refresh.
    group.layers[0].surfaces.clear();
    const cells = composer.composeLayer(upper);
    expect(flagsOf(composer.definitions[cells[index]].meta)).toBe(1);
  });

  it('keeps a brushed landing open and removes orphaned transitions', () => {
    const p = threeAreas();
    p.groups[0].layers.push(createLayer('Upper', 8, 8));
    placeRamp(p, 0, 0, 3, 3, 'east', 0, null);
    const upper = p.groups[0].layers[1];
    expect(setFloor(upper, 4, 3, 0, 0)).toBe(true);
    const composer = new ProjectComposer(p, { preview: true });
    expect(flagsOf(composer.definitions[composer.composeLayer(upper)[28]].meta)).toBe(0x19);
    p.groups[0].layers[0].surfaces.clear();
    expect(flagsOf(composer.definitions[composer.composeLayer(upper)[28]].meta)).toBe(1);
    upper.surfaces.set(28, { kind: 'landing', direction: 'east' });
    expect(composer.composeLayer(upper)[28]).toBe(0);
  });
});

it('reports a missing upper floor and rejects a ramp transition blocked by a block', () => {
  const p = threeAreas();
  p.groups[0].layers.push(createLayer('Upper', 8, 8));
  placeRamp(p, 0, 0, 3, 3, 'east', 0, null);
  expect(validateProject(p).some((i) => i.message.includes('no upper-floor cell'))).toBe(true);
  const upper = p.groups[0].layers[1];
  setFloor(upper, 5, 3, 0, 0);
  expect(validateProject(p).some((i) => i.message.includes('no upper-floor cell'))).toBe(false);
  placeBlock(upper, 4, 3, { height: 1, topTile: 0, sideTile: 0, pillar: false, floorTile: null });
  expect(validateProject(p).some((i) => i.level === 'error' && i.message.includes('ramp transition is blocked'))).toBe(true);
});

describe('walkable full-height block tops', () => {
  it('provides upper-floor collision without drawing a duplicate face or mutating the map', () => {
    const p = threeAreas();
    const ground = p.groups[0].layers[0];
    const upper = createLayer('Upper', 8, 8);
    upper.originX = 1;
    upper.originY = -1;
    p.groups[0].layers.push(upper);
    placeBlock(ground, 3, 3, { height: 1, topTile: 0, sideTile: 0, pillar: false, floorTile: null });
    const composer = new ProjectComposer(p, { preview: true });
    const index = 4 * 8 + 2;
    const top = () => composer.definitions[composer.composeLayer(upper)[index]];
    expect(flagsOf(top().meta)).toBe(1);
    expect(top().commands).toHaveLength(0);
    expect(upper.surfaces.size).toBe(0);
    const restored = deserializeProject(serializeProject(p));
    const reopened = new ProjectComposer(restored, { preview: true });
    expect(flagsOf(reopened.definitions[reopened.composeLayer(restored.groups[0].layers[1])[index]].meta)).toBe(1);
    const block = ground.surfaces.get(27)!;
    if (block.kind !== 'block') throw new Error('Expected block');
    block.height = 0.75;
    expect(flagsOf(top().meta)).toBe(0);
    block.height = 1;
    setFloor(upper, 2, 4, 0, 1);
    expect(top().commands).toHaveLength(1); // explicit floors still take precedence
    upper.surfaces.clear();
    ground.surfaces.clear();
    expect(flagsOf(top().meta)).toBe(0);
  });

  it.each([{ height: 0.75, pillar: false, topTile: 0 }, { height: 1, pillar: true, topTile: 0 }, { height: 1, pillar: false, topTile: null }])('does not invent a full floor above %j', (shape) => {
    const p = threeAreas();
    p.groups[0].layers.push(createLayer('Upper', 8, 8));
    placeBlock(p.groups[0].layers[0], 3, 3, { ...shape, sideTile: 0, floorTile: null });
    const composer = new ProjectComposer(p, { preview: true });
    expect(composer.composeLayer(p.groups[0].layers[1])[27]).toBe(0);
  });

  it('accepts a full-height block top as the upper floor beyond a ramp', () => {
    const p = threeAreas();
    p.groups[0].layers.push(createLayer('Upper', 8, 8));
    placeRamp(p, 0, 0, 3, 3, 'east', 0, null);
    placeBlock(p.groups[0].layers[0], 5, 3, { height: 1, topTile: 0, sideTile: 0, pillar: false, floorTile: null });
    expect(validateProject(p).some((i) => i.message.includes('no upper-floor cell'))).toBe(false);
  });
});
