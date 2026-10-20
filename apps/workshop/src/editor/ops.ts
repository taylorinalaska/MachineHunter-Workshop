/**
 * Editing operations on a project. Pure data manipulation: no UI, no undo
 * (callers wrap them in `useEditor.edit` / strokes).
 */
import {
  type BlockSurface,
  blockWidth,
  type CellBehaviorSpec,
  type CellDefinition,
  type Corner,
  EDGES,
  TEXTURE_MASKED,
  type Edge,
  type Entity,
  type MapProject,
  PATH_ZONE,
  type ProjectLayer,
  type ProjectPath,
  type RampDirection,
  type Surface,
  type TextureTurn,
  type Wall,
  allocateId,
  cellIndex,
  defaultRampTurn,
  inLayer,
  isDiagonalWall,
  buildPropDefinition,
  createPropModel,
  emptyDefinition,
  makeWall,
  type PropModel,
  rampFaceEdges,
  stripBehavior,
  wallKey,
} from '@mh/core';

/** Map type of the swirling glow the game shows on teleporter cells. */
export const TELEPORTER_GLOW_TYPE = 85;
export const PLAYER_START_TYPE = 1;

export interface Point {
  x: number;
  y: number;
}

/* ------------------------------------------------------------- surfaces */

export function setFloor(layer: ProjectLayer, x: number, y: number, tile: number, turn: TextureTurn): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  const current = layer.surfaces.get(index);
  if (current?.kind === 'floor' && current.tile === tile && current.turn === turn && !layer.cells[index]) return false;
  layer.surfaces.set(index, { kind: 'floor', tile, turn });
  layer.cells[index] = 0; // an authored floor replaces any prop in the cell
  return true;
}

export function eraseCell(layer: ProjectLayer, x: number, y: number): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  const had = layer.surfaces.delete(index) || layer.cells[index] !== 0 || layer.behaviors.has(index) || layer.overlays.has(index);
  layer.cells[index] = 0;
  layer.behaviors.delete(index);
  layer.overlays.delete(index);
  return had;
}

export function setProp(layer: ProjectLayer, x: number, y: number, definition: number): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  if (layer.cells[index] === definition && !layer.surfaces.has(index) && !layer.overlays.has(index)) return false;
  layer.cells[index] = definition;
  layer.surfaces.delete(index);
  layer.overlays.delete(index);
  return true;
}

/**
 * Stand a prop on top of whatever the cell already holds, keeping the floor,
 * block or prop underneath. In an empty cell the prop simply becomes the cell.
 */
export function addOverlayProp(layer: ProjectLayer, x: number, y: number, definition: number): boolean {
  if (!inLayer(layer, x, y) || !definition) return false;
  const index = cellIndex(layer, x, y);
  if (!layer.surfaces.has(index) && !layer.cells[index]) {
    layer.cells[index] = definition;
    return true;
  }
  if (!layer.surfaces.has(index) && layer.cells[index] === definition) return false;
  const overlay = layer.overlays.get(index) ?? { props: [] };
  if (overlay.props.includes(definition)) return false;
  overlay.props.push(definition);
  layer.overlays.set(index, overlay);
  return true;
}

/** Take the topmost stacked prop off a cell. */
export function removeTopOverlay(layer: ProjectLayer, x: number, y: number): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  const overlay = layer.overlays.get(index);
  if (!overlay?.props.length) return false;
  overlay.props.pop();
  if (!overlay.props.length) layer.overlays.delete(index);
  return true;
}

/** Remove one triangular half of a floor, splitting a full floor first if needed. */
export function cutFloorCorner(layer: ProjectLayer, x: number, y: number, corner: Corner): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  const s = layer.surfaces.get(index);
  if (!s) return false;
  const diagonal = corner === 'ne' || corner === 'sw' ? 'nw-se' : 'ne-sw';
  const other: Corner = ({ ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' } as const)[corner];
  if (s.kind === 'floor') {
    layer.surfaces.set(index, { kind: 'split', diagonal, halves: { [other]: { tile: s.tile } } });
    return true;
  }
  if (s.kind === 'split' && s.diagonal === diagonal && s.halves[corner]) {
    delete s.halves[corner];
    if (!Object.keys(s.halves).length) layer.surfaces.delete(index);
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- walls */

/** Unit wall segments along a straight cardinal or 45-degree run between two lattice points. */
export function wallRun(a: Point, b: Point): { x0: number; y0: number; x1: number; y1: number }[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) return [];
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const out = [];
  for (let i = 0; i < steps; i++) out.push({ x0: a.x + sx * i, y0: a.y + sy * i, x1: a.x + sx * (i + 1), y1: a.y + sy * (i + 1) });
  return out;
}

/** Snap a free endpoint to the nearest cardinal or diagonal direction from `start`. */
export function snapWallEnd(start: Point, x: number, y: number): Point {
  const dx = x - start.x;
  const dy = y - start.y;
  const angle = Math.atan2(dy, dx);
  const octant = Math.round(angle / (Math.PI / 4));
  const dirs: Point[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ];
  const d = dirs[((octant % 8) + 8) % 8];
  const diagonal = d.x !== 0 && d.y !== 0;
  const length = Math.round(diagonal ? (dx * d.x + dy * d.y) / 2 : dx * d.x + dy * d.y);
  return { x: start.x + d.x * Math.max(0, length), y: start.y + d.y * Math.max(0, length) };
}

const wallInLayer = (layer: ProjectLayer, w: { x0: number; y0: number; x1: number; y1: number }) => Math.min(w.x0, w.x1) >= 0 && Math.min(w.y0, w.y1) >= 0 && Math.max(w.x0, w.x1) <= layer.width && Math.max(w.y0, w.y1) <= layer.height;

export function addWalls(layer: ProjectLayer, segments: readonly { x0: number; y0: number; x1: number; y1: number }[], tile: number, height: number): number {
  let changed = 0;
  for (const s of segments) {
    if (!wallInLayer(layer, s)) continue;
    const wall = makeWall(s.x0, s.y0, s.x1, s.y1, tile, height);
    const key = wallKey(wall.x0, wall.y0, wall.x1, wall.y1);
    const existing = layer.walls.get(key);
    if (existing && existing.tile === tile && existing.height === height) continue;
    layer.walls.set(key, existing ? { ...existing, tile, height } : wall);
    changed++;
  }
  return changed;
}

export function removeWalls(layer: ProjectLayer, segments: readonly { x0: number; y0: number; x1: number; y1: number }[]): number {
  let changed = 0;
  for (const s of segments) if (layer.walls.delete(wallKey(s.x0, s.y0, s.x1, s.y1))) changed++;
  return changed;
}

function distanceToSegment(px: number, py: number, w: Wall): number {
  const vx = w.x1 - w.x0;
  const vy = w.y1 - w.y0;
  const t = Math.max(0, Math.min(1, ((px - w.x0) * vx + (py - w.y0) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (w.x0 + t * vx), py - (w.y0 + t * vy));
}

/** The authored wall closest to a point, within `reach` cells. */
export function nearestWall(layer: ProjectLayer, x: number, y: number, reach = 0.22): { key: string; wall: Wall } | null {
  let best: { key: string; wall: Wall } | null = null;
  let bestDistance = reach;
  for (const [key, wall] of layer.walls) {
    const d = distanceToSegment(x, y, wall);
    if (d <= bestDistance) {
      bestDistance = d;
      best = { key, wall };
    }
  }
  return best;
}

/* ---------------------------------------------------------------- rooms */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const normalizeRect = (a: Point, b: Point): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });

export function rectCells(layer: ProjectLayer, r: Rect): Point[] {
  const out: Point[] = [];
  for (let y = Math.max(0, r.y0); y <= Math.min(layer.height - 1, r.y1); y++) for (let x = Math.max(0, r.x0); x <= Math.min(layer.width - 1, r.x1); x++) out.push({ x, y });
  return out;
}

/** Wall segments around the outside of a rectangle of cells. */
export function rectPerimeter(r: Rect): { x0: number; y0: number; x1: number; y1: number }[] {
  const out = [];
  for (let x = r.x0; x <= r.x1; x++) {
    out.push({ x0: x, y0: r.y0, x1: x + 1, y1: r.y0 });
    out.push({ x0: x, y0: r.y1 + 1, x1: x + 1, y1: r.y1 + 1 });
  }
  for (let y = r.y0; y <= r.y1; y++) {
    out.push({ x0: r.x0, y0: y, x1: r.x0, y1: y + 1 });
    out.push({ x0: r.x1 + 1, y0: y, x1: r.x1 + 1, y1: y + 1 });
  }
  return out;
}

/** Floor a rectangle and wall its outline. Walls already inside the rectangle are left alone. */
export function buildRoom(layer: ProjectLayer, r: Rect, floorTile: number, turn: TextureTurn, wallTile: number, wallHeight: number): void {
  for (const c of rectCells(layer, r)) setFloor(layer, c.x, c.y, floorTile, turn);
  addWalls(layer, rectPerimeter(r), wallTile, wallHeight);
}

/* ---------------------------------------------------------------- ramps */

const RAMP_STEP: Record<RampDirection, Point> = { east: { x: 1, y: 0 }, west: { x: -1, y: 0 }, north: { x: 0, y: -1 }, south: { x: 0, y: 1 } };
export const RAMP_DIRECTIONS: RampDirection[] = ['east', 'south', 'west', 'north'];

/** The two cells a full-layer ramp occupies, low end first. */
export function rampFootprint(x: number, y: number, direction: RampDirection): [Point, Point] {
  const step = RAMP_STEP[direction];
  return [
    { x, y },
    { x: x + step.x, y: y + step.y },
  ];
}

/**
 * Place a full-layer ramp starting at (x, y) and rising in `direction`.
 * When a layer exists above, its cell over the top of the ramp becomes the
 * landing that carries actors onto it.
 */
export function placeRamp(project: MapProject, group: number, layerIndex: number, x: number, y: number, direction: RampDirection, tile: number, sideTile: number | null): boolean {
  const layers = project.groups[group].layers;
  const layer = layers[layerIndex];
  const [low, high] = rampFootprint(x, y, direction);
  if (!inLayer(layer, low.x, low.y) || !inLayer(layer, high.x, high.y)) return false;
  const turn = defaultRampTurn(direction);
  const put = (p: Point, half: 'lower' | 'upper') => {
    const index = cellIndex(layer, p.x, p.y);
    // The lower half has nothing under its top edge worth closing: the upper half continues from it.
    const edges = half === 'upper' ? rampFaceEdges(direction) : rampFaceEdges(direction).slice(0, 2);
    const sides: Partial<Record<Edge, number>> = {};
    if (sideTile !== null) for (const edge of edges) sides[edge] = sideTile;
    layer.surfaces.set(index, { kind: 'ramp', direction, half, tile, turn, sides });
    layer.cells[index] = 0;
  };
  put(low, 'lower');
  put(high, 'upper');
  const above = layers[layerIndex + 1];
  if (above) {
    const ax = high.x + layer.originX - above.originX;
    const ay = high.y + layer.originY - above.originY;
    if (inLayer(above, ax, ay)) {
      const index = cellIndex(above, ax, ay);
      above.surfaces.set(index, { kind: 'landing', direction });
      above.cells[index] = 0;
    }
  }
  return true;
}

/* --------------------------------------------------------------- blocks */

export interface BlockOptions {
  /** Height in cells (0.25 .. 1). */
  height: number;
  topTile: number | null;
  sideTile: number | null;
  /** A centered column instead of a full cell. */
  pillar: boolean;
  width?: number;
  /** Floor around a pillar. */
  floorTile: number | null;
}

/** The floor tile of a cell: its plain floor, or the floor around its pillar. */
function floorTileOf(layer: ProjectLayer, x: number, y: number): number | null {
  if (!inLayer(layer, x, y)) return null;
  const s = layer.surfaces.get(cellIndex(layer, x, y));
  if (s?.kind === 'floor') return s.tile;
  if (s?.kind === 'block' && s.pillar) return s.floorTile;
  return null;
}

/**
 * The floor a pillar stands on: the one already in the cell, else a
 * neighbor's, so the floor round it matches the room rather than the
 * pillar's top. Null when there is none to match.
 */
export function pillarFloor(layer: ProjectLayer, x: number, y: number): number | null {
  for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const tile = floorTileOf(layer, x + dx, y + dy);
    if (tile !== null) return tile;
  }
  return null;
}

/** Stand a solid block (or a pillar) on a cell, replacing whatever was there. */
export function placeBlock(layer: ProjectLayer, x: number, y: number, o: BlockOptions): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  const sides: BlockSurface['sides'] = {};
  if (o.sideTile !== null) for (const edge of EDGES) sides[edge] = o.sideTile;
  const current = layer.surfaces.get(index);
  const next: BlockSurface = { kind: 'block', height: o.height, topTile: o.topTile, sides, pillar: o.pillar, width: o.width ?? 0.5, floorTile: o.pillar ? pillarFloor(layer, x, y) ?? o.floorTile : null };
  if (current && !layer.cells[index] && JSON.stringify(current) === JSON.stringify(next)) return false;
  layer.surfaces.set(index, next);
  layer.cells[index] = 0;
  return true;
}

/* ---------------------------------------------------------------- props */

/** Add a retail cell shape to the project's prop library (once) and return its library ID. */
export function importProp(project: MapProject, level: string, id: number, def: CellDefinition): number {
  const label = `${level} #${id}`;
  const existing = project.definitionSources.indexOf(label);
  if (existing > 0) return existing;
  // Behavior is dropped: its links point at other cells of the source level.
  project.definitions.push({ ...def, meta: stripBehavior(def.meta) });
  project.definitionSources.push(label);
  return project.definitions.length - 1;
}

/** Start a new prop. It gets a library slot of its own straight away so it can be placed. */
export function createModel(project: MapProject, tile: number): PropModel {
  const model = createPropModel(allocateId(project), project.definitions.length, `Prop ${project.models.length + 1}`, tile);
  // A starter box, so there is something to see and click on.
  model.parts.push({ shape: 'box', x: 4, y: 4, z: 0, w: 8, d: 8, h: 8, turn: 0, tile });
  project.definitions.push(buildPropDefinition(model));
  project.definitionSources.push(`model ${model.id}`);
  project.models.push(model);
  return model;
}

/** Remove a built prop and every copy of it placed in the map. Its library slot is kept, empty, so other IDs do not move. */
export function deleteModel(project: MapProject, id: number): void {
  const model = project.models.find((m) => m.id === id);
  if (!model) return;
  project.models = project.models.filter((m) => m.id !== id);
  project.definitions[model.definitionId] = emptyDefinition();
  project.definitionSources[model.definitionId] = null;
  for (const group of project.groups) {
    for (const layer of group.layers) {
      for (let i = 0; i < layer.cells.length; i++) if ((layer.cells[i] & 0x7ff) === model.definitionId) layer.cells[i] = 0;
      for (const [index, overlay] of layer.overlays) {
        overlay.props = overlay.props.filter((p) => p !== model.definitionId);
        if (!overlay.props.length) layer.overlays.delete(index);
      }
    }
  }
}

/* ---------------------------------------------------------------- paint */

/** The top of a cell, or the face that looks out of one of its edges. */
export type Face = 'top' | Edge;

export type PaintTarget = { kind: 'wall'; key: string } | { kind: 'cell'; x: number; y: number; face: Face } | null;

/** A point on the visible geometry of a layer, as found by the viewport. */
export interface SurfaceHit {
  /** Cell that owns the face. */
  x: number;
  y: number;
  /** Where the pointer touches it, in cells. */
  px: number;
  py: number;
  face: Face;
}

/** What a click at a ground point would paint: a nearby wall wins over the floor beneath it. */
export function paintTargetAt(layer: ProjectLayer, x: number, y: number): PaintTarget {
  const wall = nearestWall(layer, x, y, 0.18);
  if (wall) return { kind: 'wall', key: wall.key };
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!inLayer(layer, cx, cy)) return null;
  const s = layer.surfaces.get(cellIndex(layer, cx, cy));
  if (!s || s.kind === 'landing') return null;
  return { kind: 'cell', x: cx, y: cy, face: 'top' };
}

/** What a click on a piece of visible geometry would paint. */
export function paintTargetFromHit(layer: ProjectLayer, hit: SurfaceHit): PaintTarget {
  if (hit.face !== 'top') {
    const wall = nearestWall(layer, hit.px, hit.py, 0.06);
    if (wall) return { kind: 'wall', key: wall.key };
  }
  if (!inLayer(layer, hit.x, hit.y)) return null;
  const s = layer.surfaces.get(cellIndex(layer, hit.x, hit.y));
  if (!s || s.kind === 'landing') return null;
  if (hit.face !== 'top' && !paintableEdges(s).includes(hit.face)) return null;
  return { kind: 'cell', x: hit.x, y: hit.y, face: hit.face };
}

/** Edges of a surface that can carry a painted face. */
export function paintableEdges(s: Surface): Edge[] {
  if (s.kind === 'ramp') return rampFaceEdges(s.direction);
  if (s.kind === 'block') return [...EDGES];
  return [];
}

const inPillar = (s: BlockSurface, u: number, v: number) => {
  const lo = (1 - blockWidth(s)) / 2;
  return u >= lo && u <= 1 - lo && v >= lo && v <= 1 - lo;
};

/** Paint one face. `x`, `y` are where the pointer is, in cells; they choose between the halves of a split floor. */
export function paint(layer: ProjectLayer, target: PaintTarget, tile: number, x: number, y: number): boolean {
  if (!target) return false;
  if (target.kind === 'wall') {
    const wall = layer.walls.get(target.key);
    // A see-through wall stays see-through with its new tile.
    const word = tile | ((wall?.tile ?? 0) & TEXTURE_MASKED);
    if (!wall || wall.tile === word) return false;
    wall.tile = word;
    return true;
  }
  const s = layer.surfaces.get(cellIndex(layer, target.x, target.y));
  if (!s) return false;
  if (target.face !== 'top') {
    if ((s.kind !== 'ramp' && s.kind !== 'block') || !paintableEdges(s).includes(target.face) || s.sides[target.face] === tile) return false;
    s.sides[target.face] = tile;
    return true;
  }
  if (s.kind === 'floor' || s.kind === 'ramp') {
    tile |= (s.tile ?? 0) & TEXTURE_MASKED;
    if (s.tile === tile) return false;
    s.tile = tile;
    return true;
  }
  if (s.kind === 'block') {
    const key = s.pillar && !inPillar(s, x - target.x, y - target.y) ? 'floorTile' : 'topTile';
    if (s[key] === tile) return false;
    s[key] = tile;
    return true;
  }
  if (s.kind === 'split') {
    const u = x - target.x;
    const v = y - target.y;
    const corner: Corner = s.diagonal === 'nw-se' ? (v <= u ? 'ne' : 'sw') : v <= 1 - u ? 'nw' : 'se';
    const half = s.halves[corner];
    if (!half || half.tile === tile) return false;
    half.tile = tile;
    return true;
  }
  return false;
}

/** The tile a paint target shows, for the eyedropper. */
export function tileAt(layer: ProjectLayer, x: number, y: number, target: PaintTarget = paintTargetAt(layer, x, y)): number | null {
  if (!target) return null;
  if (target.kind === 'wall') return layer.walls.get(target.key)?.tile ?? null;
  const s = layer.surfaces.get(cellIndex(layer, target.x, target.y));
  if (!s) return null;
  if (target.face !== 'top') return s.kind === 'ramp' || s.kind === 'block' ? (s.sides[target.face] ?? null) : null;
  if (s.kind === 'floor' || s.kind === 'ramp') return s.tile;
  if (s.kind === 'block') return s.pillar && !inPillar(s, x - target.x, y - target.y) ? s.floorTile : s.topTile;
  if (s.kind === 'split') return Object.values(s.halves)[0]?.tile ?? null;
  return null;
}

/** The lattice segment along one edge of a cell. */
export function edgeSegment(x: number, y: number, edge: Edge): { x0: number; y0: number; x1: number; y1: number } {
  switch (edge) {
    case 'north':
      return { x0: x, y0: y, x1: x + 1, y1: y };
    case 'south':
      return { x0: x, y0: y + 1, x1: x + 1, y1: y + 1 };
    case 'west':
      return { x0: x, y0: y, x1: x, y1: y + 1 };
    default:
      return { x0: x + 1, y0: y, x1: x + 1, y1: y + 1 };
  }
}

/* ------------------------------------------------------------- entities */

export function addEntity(project: MapProject, layer: ProjectLayer, type: number, x: number, y: number, behavior = 0, weapon = 0): Entity {
  const entity: Entity = {
    id: allocateId(project),
    type,
    behavior,
    weapon,
    bit8: 0,
    x: Math.max(0, Math.min(layer.width * 256 - 1, Math.round(x))),
    y: Math.max(0, Math.min(layer.height * 256 - 1, Math.round(y))),
    disabled: false,
    pathId: null,
    flagsRest: 0,
  };
  layer.entities.push(entity);
  return entity;
}

export function removeEntity(layer: ProjectLayer, id: number): boolean {
  const before = layer.entities.length;
  layer.entities = layer.entities.filter((e) => e.id !== id);
  return layer.entities.length !== before;
}

/** Snap a position (1/256 cell) to the center of its cell, or to quarter cells when `fine`. */
/**
 * Where an entity dropped at (x, y) goes: the nearest cell center or cell
 * corner (the retail EXIT sign, for one, sits on a corner, centered on four
 * cells), or exactly there with `free`.
 */
export function snapPlacement(x: number, y: number, free: boolean): Point {
  if (free) return { x: Math.round(x), y: Math.round(y) };
  const center = { x: Math.floor(x / 256) * 256 + 128, y: Math.floor(y / 256) * 256 + 128 };
  const corner = { x: Math.round(x / 256) * 256, y: Math.round(y / 256) * 256 };
  return Math.hypot(x - corner.x, y - corner.y) < Math.hypot(x - center.x, y - center.y) ? corner : center;
}

export function snapEntity(x: number, y: number, fine: boolean): Point {
  if (fine) return { x: Math.round(x / 64) * 64, y: Math.round(y / 64) * 64 };
  return { x: Math.floor(x / 256) * 256 + 128, y: Math.floor(y / 256) * 256 + 128 };
}

/* ---------------------------------------------------------------- paths */

export function createPath(project: MapProject, group: number, layer: number, mode: number): ProjectPath {
  const path: ProjectPath = { id: allocateId(project), word0: mode, flag: false, group, layer, points: [] };
  project.paths.push(path);
  return path;
}

/** Delete a path and release everything that followed it. */
export function removePath(project: MapProject, id: number): void {
  project.paths = project.paths.filter((p) => p.id !== id);
  for (const group of project.groups) for (const layer of group.layers) for (const e of layer.entities) if (e.pathId === id) e.pathId = null;
}

export function pathFollowers(project: MapProject, id: number): Entity[] {
  return project.groups.flatMap((g) => g.layers.flatMap((l) => l.entities.filter((e) => e.pathId === id)));
}

/** Index of the path point within `reach` map units of a position, or -1. */
export function pathPointAt(path: ProjectPath, x: number, y: number, reach = 100): number {
  let best = -1;
  let bestDistance = reach;
  path.points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/** The path of a layer with a point nearest a position, within `reach` map units. */
export function nearestPath(project: MapProject, group: number, layer: number, x: number, y: number, reach = 70): ProjectPath | null {
  let best: ProjectPath | null = null;
  let bestDistance = reach;
  for (const path of project.paths) {
    if (path.group !== group || path.layer !== layer) continue;
    for (const p of path.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = path;
      }
    }
  }
  return best;
}

/**
 * The three points of a wander zone covering a rectangle (map units). The
 * engine pairs any of the three X values with any of the three Y values, so
 * points on the diagonal give a 3x3 grid of places spread over the rectangle.
 */
export function zonePoints(a: Point, b: Point): ProjectPath['points'] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0, tail0: 0, tail1: 0 },
    { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), tail0: 0, tail1: 0 },
    { x: x1, y: y1, tail0: 0, tail1: 0 },
  ];
}

export const isZone = (path: ProjectPath): boolean => path.word0 === PATH_ZONE;

/* ----------------------------------------------------------- behaviors */

export function setBehavior(layer: ProjectLayer, x: number, y: number, behavior: CellBehaviorSpec | null): boolean {
  if (!inLayer(layer, x, y)) return false;
  const index = cellIndex(layer, x, y);
  if (behavior) layer.behaviors.set(index, behavior);
  else if (!layer.behaviors.delete(index)) return false;
  return true;
}

/** Create a one-way teleporter from a cell to a destination cell, with the usual glow on the source. */
export function linkTeleporter(project: MapProject, from: { group: number; layer: number; x: number; y: number }, to: { group: number; layer: number; x: number; y: number }, withGlow = true): void {
  const source = project.groups[from.group].layers[from.layer];
  setBehavior(source, from.x, from.y, { kind: 'teleporter', group: to.group, layer: to.layer, x: to.x, y: to.y, facing: null });
  if (!withGlow) return;
  const cx = from.x * 256 + 128;
  const cy = from.y * 256 + 128;
  const hasGlow = source.entities.some((e) => (e.type === TELEPORTER_GLOW_TYPE || e.type === 86) && e.x >> 8 === from.x && e.y >> 8 === from.y);
  if (!hasGlow) addEntity(project, source, TELEPORTER_GLOW_TYPE, cx, cy);
}

/* ---------------------------------------------------- areas and layers */

/** Where a reference to (group, layer) points once something was removed, or null when its target is gone. */
type Renumber = (group: number, layer: number) => { group: number; layer: number } | null;

/**
 * Fix every reference to an area or layer after one was removed: teleporters
 * and paths elsewhere keep pointing at the same place even though the indices
 * behind it shifted. A teleporter into the removed part is turned back into a
 * plain cell, glow included. Returns how many teleporters that was.
 */
function renumber(project: MapProject, to: Renumber): number {
  let lost = 0;
  for (const group of project.groups) {
    for (const layer of group.layers) {
      for (const [index, b] of [...layer.behaviors]) {
        if (b.kind !== 'teleporter') continue;
        const target = to(b.group, b.layer);
        if (target) {
          layer.behaviors.set(index, { ...b, ...target });
          continue;
        }
        layer.behaviors.delete(index);
        const x = index % layer.width;
        const y = Math.floor(index / layer.width);
        layer.entities = layer.entities.filter((e) => !((e.type === TELEPORTER_GLOW_TYPE || e.type === 86) && e.x >> 8 === x && e.y >> 8 === y));
        lost++;
      }
    }
  }
  for (const path of [...project.paths]) {
    if (path.group < 0) continue;
    const target = to(path.group, path.layer);
    if (target) Object.assign(path, target);
    else removePath(project, path.id);
  }
  return lost;
}

/** Delete a layer of an area. Returns how many teleporters elsewhere led onto it and were removed. */
export function removeLayer(project: MapProject, group: number, layer: number): number {
  project.groups[group].layers.splice(layer, 1);
  return renumber(project, (g, l) => (g !== group ? { group: g, layer: l } : l === layer ? null : { group: g, layer: l > layer ? l - 1 : l }));
}

/** Delete an area. Returns how many teleporters in other areas led into it and were removed. */
export function removeGroup(project: MapProject, group: number): number {
  project.groups.splice(group, 1);
  if (project.initialGroup > group) project.initialGroup--;
  else if (project.initialGroup === group) project.initialGroup = 0;
  return renumber(project, (g, l) => (g === group ? null : { group: g > group ? g - 1 : g, layer: l }));
}

/* ------------------------------------------------------------- lighting */

/** Move lattice lights within `radius` cells of a point towards `level`, strongest at the center. */
export function brushLight(layer: ProjectLayer, x: number, y: number, radius: number, level: number, strength = 0.5): boolean {
  let changed = false;
  const stride = layer.width + 1;
  for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(layer.height, Math.ceil(y + radius)); py++) {
    for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(layer.width, Math.ceil(x + radius)); px++) {
      const d = Math.hypot(px - x, py - y);
      if (d > radius) continue;
      const weight = strength * (1 - d / (radius + 0.001)) + 0.08;
      for (const plane of [0, 1]) {
        const at = (py * stride + px) * 2 + plane;
        const current = layer.lighting[at];
        let next = Math.round(current + (level - current) * Math.min(1, weight));
        if (next === current && current !== level) next = current + Math.sign(level - current);
        next = Math.max(0, Math.min(31, next));
        if (next !== current) {
          layer.lighting[at] = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function fillLight(layer: ProjectLayer, level: number): void {
  layer.lighting.fill(Math.max(0, Math.min(31, level)));
}

/* --------------------------------------------------------------- queries */

export interface CellSummary {
  surface: Surface | null;
  prop: number;
  behavior: CellBehaviorSpec | null;
  walls: Wall[];
  /** Props stacked on top, bottom first. */
  overlays: number[];
}

export function describeCell(layer: ProjectLayer, x: number, y: number): CellSummary {
  const index = cellIndex(layer, x, y);
  const walls = [...layer.walls.values()].filter((w) => {
    if (isDiagonalWall(w)) return Math.min(w.x0, w.x1) === x && Math.min(w.y0, w.y1) === y;
    if (w.y0 === w.y1) return w.x0 === x && (w.y0 === y || w.y0 === y + 1);
    return w.y0 === y && (w.x0 === x || w.x0 === x + 1);
  });
  return { surface: layer.surfaces.get(index) ?? null, prop: layer.cells[index] & 0x7ff, behavior: layer.behaviors.get(index) ?? null, walls, overlays: layer.overlays.get(index)?.props ?? [] };
}
