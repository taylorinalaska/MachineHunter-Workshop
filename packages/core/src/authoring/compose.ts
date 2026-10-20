import { blockWidth } from './project.ts';
/**
 * Turns authored cell content (a surface plus the walls that land on the
 * cell) into one native cell definition: mesh, collision profile, automap.
 *
 * Texture mapping is not stored in the map: the renderer pins tile corners
 * (0,0) (63,0) (63,63) (0,63) to face vertices r, r+1, r+2, r+3, where r = 0
 * for floors (op 7) and 1 for walls, diagonals and slopes. Every face built
 * here orders its vertices to get an upright, unmirrored tile under that rule,
 * and the editor's preview applies the same rule, so what you see is what the
 * game draws.
 */
import {
  CLASS_ACTION,
  CLASS_MASK,
  COLLISION_DIAGONAL,
  COLLISION_MODE_MASK,
  COLLISION_OPEN,
  DIAGONAL_FLAGS,
  EDGE_MASK,
  type Edge,
  FLAG_GROUND,
  FLAG_SOLID,
  COLLISION_MASK,
  RAMP_BAND_MASK,
  RAMP_DIRECTION_MASK,
  RAMP_FLAGS,
  type RampDirection,
  type RampHalf,
  flagsOf,
  makeMeta,
  maskOf,
} from '../map/definition-meta.ts';
import {
  type CellDefinition,
  type FaceCommand,
  OP_DIAGONAL_A,
  OP_DIAGONAL_B,
  OP_FLOOR,
  OP_SLOPE_X,
  OP_SLOPE_Y,
  OP_WALL_X,
  OP_WALL_Y,
} from '../map/model.ts';
import type { Corner, Surface, TextureTurn } from './project.ts';

const U = 256;

/** Cell corners clockwise from north-west, as [x, y]. */
const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [U, 0],
  [U, U],
  [0, U],
];

/** Wall placed on a cell by the compiler. */
export interface CellWall {
  height: number;
  tile: number | null;
}
export interface CellDiagonal extends CellWall {
  /** 0: the "\" diagonal, 1: the "/" diagonal. */
  family: 0 | 1;
  /** Which half is solid. */
  side: 0 | 1;
}

export interface CellSpec {
  surface: Surface | null;
  walls: Partial<Record<Edge, CellWall>>;
  diagonals: CellDiagonal[];
}

/**
 * Shapes a generated tile can be cut to. Textured triangles and the sloped
 * sides of ramps are drawn as ordinary quads whose tile has transparent
 * pixels where the shape ends.
 */
export type TileMask =
  | { kind: 'corner'; corner: Corner }
  | { kind: 'slope'; from: number; to: number }
  /** Not a cut-out: the given part of the tile (in eighths of its side) enlarged to fill a tile of its own. */
  | { kind: 'crop'; u0: number; v0: number; u1: number; v1: number }
  /**
   * Not a cut-out: the tile at its natural size as it falls on a face. `uv` holds the texel
   * coordinates (any value; the tile repeats) of the new tile's top-left, top-right,
   * bottom-right and bottom-left corners.
   */
  | { kind: 'warp'; uv: [number, number][] };

/**
 * Returns the texture word for `tile` (itself a texture word) cut to `mask`,
 * generating the cut tile if needed. Cut-outs come back with TEXTURE_MASKED
 * set; a crop keeps the flags of the tile it was taken from.
 */
export type MaskedTileResolver = (tile: number, mask: TileMask) => number;

export const maskKey = (mask: TileMask): string =>
  mask.kind === 'corner' ? `c:${mask.corner}` : mask.kind === 'slope' ? `s:${mask.from}:${mask.to}` : mask.kind === 'warp' ? `w:${mask.uv.flat().join(':')}` : `r:${mask.u0}:${mask.v0}:${mask.u1}:${mask.v1}`;

/** Whether a pixel of a 64x64 tile survives a mask. */
export function maskKeeps(mask: TileMask, x: number, y: number): boolean {
  if (mask.kind === 'crop' || mask.kind === 'warp') return true;
  if (mask.kind === 'corner') {
    switch (mask.corner) {
      case 'nw':
        return x + y <= 63;
      case 'se':
        return x + y >= 64;
      case 'ne':
        return y <= x;
      default:
        return y > x;
    }
  }
  // Slope: heights are fractions of a layer at the left and right tile edges; keep what lies below the line.
  const height = mask.from + ((mask.to - mask.from) * x) / 63;
  return y + 1e-9 >= (1 - height) * 63;
}

class MeshBuilder {
  readonly vertices: number[] = [];
  readonly commands: FaceCommand[] = [];
  readonly automap: number[] = [];

  quad(op: number, texture: number, points: readonly (readonly [number, number, number])[], twoSided = false): number {
    const base = this.vertices.length / 3;
    for (const p of points) this.vertices.push(p[0], p[1], p[2]);
    this.commands.push({ op, texture, indices: [base, base + 1, base + 2, base + 3] });
    if (twoSided) this.commands.push({ op, texture, indices: [base + 3, base + 2, base + 1, base] });
    return base;
  }

  /** Draw the outline of a quad on the automap. */
  outline(base: number): void {
    for (let i = 0; i < 4; i++) this.automap.push(base + i, base + ((i + 1) & 3));
  }
}

/**
 * Outward-facing wall quad on a cell edge, ordered
 * [bottom-start, top-start, top-end, bottom-end]; the tile reads left to
 * right from start to end when looked at from outside the cell.
 */
function edgeQuad(edge: Edge, heightUnits: number): [number, number, number][] {
  const z = -heightUnits;
  switch (edge) {
    case 'west':
      return [[0, 0, 0], [0, 0, z], [0, U, z], [0, U, 0]];
    case 'east':
      return [[U, U, 0], [U, U, z], [U, 0, z], [U, 0, 0]];
    case 'north':
      return [[U, 0, 0], [U, 0, z], [0, 0, z], [0, 0, 0]];
    default:
      return [[0, U, 0], [0, U, z], [U, U, z], [U, U, 0]];
  }
}

const EDGE_OP: Record<Edge, number> = { west: OP_WALL_X, east: OP_WALL_X, north: OP_WALL_Y, south: OP_WALL_Y };
const BLOCK_EDGES: readonly Edge[] = ['north', 'east', 'south', 'west'];

const heightUnits = (cells: number): number => Math.max(1, Math.min(32767, Math.round(cells * U)));

/** Height of a ramp surface at each cell corner (NW, NE, SE, SW), in 1/256 cell. */
export function rampCornerHeights(direction: RampDirection, half: RampHalf): [number, number, number, number] {
  const low = half === 'upper' ? 128 : 0;
  const high = low + 128;
  switch (direction) {
    case 'east':
      return [low, high, high, low];
    case 'west':
      return [high, low, low, high];
    case 'south':
      return [low, low, high, high];
    default:
      return [high, high, low, low];
  }
}

/** Texture turn that puts the top of the tile at the top of the slope. */
export const defaultRampTurn = (direction: RampDirection): TextureTurn => ({ north: 0, east: 1, south: 2, west: 3 })[direction] as TextureTurn;

/** The two edges that run alongside a ramp. Its tall end is the edge named like its direction. */
export const RAMP_SIDES: Record<RampDirection, [Edge, Edge]> = { east: ['north', 'south'], west: ['north', 'south'], north: ['west', 'east'], south: ['west', 'east'] };

/** Every edge of a ramp cell that can carry a face: both sides, then the tall end. */
export const rampFaceEdges = (direction: RampDirection): Edge[] => [...RAMP_SIDES[direction], direction];

/** Cover the centered pillar footprint on the engine's 4x4 collision grid. */
function pillarMask(surface: Extract<Surface, { kind: 'block' }>): number {
  const lo = (1 - blockWidth(surface)) / 2;
  const hi = 1 - lo;
  let mask = 0;
  // The engine resolves collision in quarter cells; cover every overlapping square.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    if (x / 4 < hi && (x + 1) / 4 > lo && y / 4 < hi && (y + 1) / 4 > lo) mask |= 0x8000 >> (x + y * 4);
  }
  return mask;
}

/** Corner indices (into NW, NE, SE, SW) at the start and end of each outward-facing edge quad. */
const EDGE_CORNERS: Record<Edge, [number, number]> = { west: [0, 3], east: [2, 1], north: [1, 0], south: [3, 2] };

function addSurface(mesh: MeshBuilder, surface: Surface, masked: MaskedTileResolver): void {
  if (surface.kind === 'floor') {
    if (surface.tile === null) return;
    const order = [0, 1, 2, 3].map((i) => CORNERS[(surface.turn + i) & 3]);
    mesh.quad(OP_FLOOR, surface.tile, order.map(([x, y]) => [x, y, 0] as const));
    return;
  }
  if (surface.kind === 'split') {
    const entries = Object.entries(surface.halves) as [Corner, { tile: number | null }][];
    // Two halves with the same tile are just an ordinary floor.
    if (entries.length === 2 && entries[0][1].tile !== null && entries[0][1].tile === entries[1][1].tile) {
      mesh.quad(OP_FLOOR, entries[0][1].tile, CORNERS.map(([x, y]) => [x, y, 0] as const));
      return;
    }
    for (const [corner, half] of entries) {
      if (half.tile === null) continue;
      mesh.quad(OP_FLOOR, masked(half.tile, { kind: 'corner', corner }), CORNERS.map(([x, y]) => [x, y, 0] as const));
    }
    return;
  }
  if (surface.kind === 'ramp') {
    const heights = rampCornerHeights(surface.direction, surface.half);
    if (surface.tile !== null) {
      // Slopes use rotation 1: the tile's top-left texel lands on the second vertex.
      const order = [-1, 0, 1, 2].map((i) => (surface.turn + i) & 3);
      const base = mesh.quad(
        surface.direction === 'east' || surface.direction === 'west' ? OP_SLOPE_X : OP_SLOPE_Y,
        surface.tile,
        order.map((c) => [CORNERS[c][0], CORNERS[c][1], -heights[c]] as const),
      );
      mesh.outline(base);
    }
    for (const edge of rampFaceEdges(surface.direction)) {
      const tile = surface.sides[edge];
      if (tile === undefined) continue;
      const [start, end] = EDGE_CORNERS[edge];
      // A face that reaches the full layer height is an ordinary wall; anything lower is a
      // full-height quad whose tile is cut to the slope, so the texture is not squashed.
      if (heights[start] >= U && heights[end] >= U) mesh.quad(EDGE_OP[edge], tile, edgeQuad(edge, U));
      else mesh.quad(EDGE_OP[edge], masked(tile, { kind: 'slope', from: heights[start] / U, to: heights[end] / U }), edgeQuad(edge, U));
    }
    return;
  }
  if (surface.kind === 'block') {
    const h = heightUnits(Math.min(1, surface.height));
    const lo = (1 - blockWidth(surface)) * U / 2;
    const hi = U - lo;
    if (surface.pillar && surface.floorTile !== null) mesh.quad(OP_FLOOR, surface.floorTile, CORNERS.map(([x, y]) => [x, y, 0] as const));
    if (surface.topTile !== null) {
      mesh.outline(mesh.quad(OP_FLOOR, surface.topTile, [[lo, lo, -h], [hi, lo, -h], [hi, hi, -h], [lo, hi, -h]]));
    }
    // Outward faces, each ordered bottom-start, top-start, top-end, bottom-end like `edgeQuad`.
    const faces: Record<Edge, [number, number, number][]> = {
      west: [[lo, lo, 0], [lo, lo, -h], [lo, hi, -h], [lo, hi, 0]],
      east: [[hi, hi, 0], [hi, hi, -h], [hi, lo, -h], [hi, lo, 0]],
      north: [[hi, lo, 0], [hi, lo, -h], [lo, lo, -h], [lo, lo, 0]],
      south: [[lo, hi, 0], [lo, hi, -h], [hi, hi, -h], [hi, hi, 0]],
    };
    for (const edge of BLOCK_EDGES) {
      const tile = surface.sides[edge];
      if (tile !== undefined) mesh.quad(EDGE_OP[edge], tile, faces[edge]);
    }
  }
}

function addWalls(mesh: MeshBuilder, spec: Pick<CellSpec, 'walls' | 'diagonals'>): void {
  for (const edge of ['north', 'east', 'south', 'west'] as const) {
    const wall = spec.walls[edge];
    if (!wall || wall.tile === null) continue;
    mesh.outline(mesh.quad(EDGE_OP[edge], wall.tile, edgeQuad(edge, heightUnits(wall.height)), true));
  }
  for (const d of spec.diagonals) {
    if (d.tile === null) continue;
    const z = -heightUnits(d.height);
    const points: [number, number, number][] = d.family === 0 ? [[0, 0, 0], [0, 0, z], [U, U, z], [U, U, 0]] : [[U, 0, 0], [U, 0, z], [0, U, z], [0, U, 0]];
    mesh.outline(mesh.quad(d.family === 0 ? OP_DIAGONAL_A : OP_DIAGONAL_B, d.tile, points, true));
  }
}

const hasGround = (surface: Surface | null): boolean => !!surface && (surface.kind === 'floor' || (surface.kind === 'split' && Object.keys(surface.halves).length > 0));

function wallMask(walls: CellSpec['walls']): number {
  let mask = 0;
  for (const edge of Object.keys(walls) as Edge[]) if (walls[edge]) mask |= EDGE_MASK[edge];
  return mask;
}

/**
 * Collision flags for authored content. A cell has a single collision mode,
 * so a ramp takes precedence over a diagonal, which takes precedence over
 * edge walls.
 */
export function collisionFor(spec: CellSpec): { flags: number; mask: number } {
  const { surface } = spec;
  if (surface?.kind === 'ramp') return { flags: RAMP_FLAGS[surface.direction][surface.half], mask: 0 };
  if (surface?.kind === 'landing') return { flags: RAMP_FLAGS[surface.direction].upper | 0x08, mask: 0 };
  // A full block is a solid cell, as the retail levels' wall cells are; a pillar blocks only its footprint.
  if (surface?.kind === 'block') return surface.pillar ? { flags: FLAG_GROUND | COLLISION_MASK, mask: pillarMask(surface) | wallMask(spec.walls) } : { flags: FLAG_SOLID, mask: 0 };
  if (spec.diagonals.length) return { flags: DIAGONAL_FLAGS[spec.diagonals[0].family][spec.diagonals[0].side], mask: 0 };
  const mask = wallMask(spec.walls);
  return { flags: (hasGround(surface) ? FLAG_GROUND : 0) | (mask ? COLLISION_MASK : 0), mask };
}

function automapWords(pairs: readonly number[]): Uint16Array | null {
  return pairs.length ? Uint16Array.from([...pairs, 0xffff, 0xffff]) : null;
}

/** Canonical key for de-duplicating composed definitions. */
export function specKey(spec: CellSpec): string {
  const walls = (['north', 'east', 'south', 'west'] as const).map((e) => (spec.walls[e] ? `${e}:${spec.walls[e]!.height}:${spec.walls[e]!.tile}` : '')).join('|');
  const diagonals = spec.diagonals.map((d) => `${d.family}:${d.side}:${d.height}:${d.tile}`).join('|');
  return `${JSON.stringify(spec.surface)}#${walls}#${diagonals}`;
}

/** Compose a brand-new definition from authored content only. */
export function composeDefinition(spec: CellSpec, masked: MaskedTileResolver, outlineTop?: Extract<Surface, { kind: 'block' }>): CellDefinition {
  const mesh = new MeshBuilder();
  if (spec.surface) addSurface(mesh, spec.surface, masked);
  addWalls(mesh, spec);
  // Hidden tops still outline solid blocks on the native automap.
  if (outlineTop) {
    const drawn = mesh.commands.length;
    addSurface(mesh, { ...outlineTop, sides: {}, pillar: false, floorTile: null }, masked);
    mesh.commands.splice(drawn);
  }
  const { flags, mask } = collisionFor(spec);
  return { vertices: Int16Array.from(mesh.vertices), commands: mesh.commands, meta: makeMeta(flags, mask), automap: automapWords(mesh.automap), complete: true };
}

/**
 * Add authored walls to an existing (library) definition. The prop's own
 * collision is kept where it is special (solid, ramp, behavior-specific);
 * otherwise the wall strips are merged into its 4x4 mask.
 */
export function overlayDefinition(base: CellDefinition, spec: Pick<CellSpec, 'walls' | 'diagonals'>): CellDefinition {
  const mesh = new MeshBuilder();
  mesh.vertices.push(...base.vertices);
  mesh.commands.push(...base.commands.map((c) => ({ ...c, indices: [...c.indices] })));
  addWalls(mesh, spec);

  const meta = base.meta.slice();
  let flags = meta[0] | (meta[1] << 8);
  let mask = meta[2] | (meta[3] << 8);
  const special = flags & 0xa000; // solid or collision-skipping cells keep their profile
  const ramp = flags & 0x0018;
  const mode = flags & 0x0006;
  const isAction = (flags & 0x1e00) === 0x0e00; // word 1 is an object index for some actions
  if (!special && !ramp && !isAction) {
    const extra = wallMask(spec.walls);
    if (spec.diagonals.length && mode === 0) {
      flags = (flags & ~0x0186) | DIAGONAL_FLAGS[spec.diagonals[0].family][spec.diagonals[0].side];
    } else if (extra && (mode === 0 || mode === COLLISION_MASK)) {
      flags = (flags & ~0x0006) | COLLISION_MASK;
      mask |= extra;
    }
  }
  meta[0] = flags & 0xff;
  meta[1] = flags >> 8;
  if (!isAction) {
    meta[2] = mask & 0xff;
    meta[3] = mask >> 8;
  }

  // Extend a line-list automap profile with the new wall outlines; leave polygon profiles alone.
  let automap = base.automap;
  if (mesh.automap.length) {
    if (!automap) automap = automapWords(mesh.automap);
    else if (!(automap[0] === 1 && automap[1] === 0xffff)) automap = Uint16Array.from([...automap.subarray(0, automap.length - 2), ...mesh.automap, 0xffff, 0xffff]);
  }
  return { vertices: Int16Array.from(mesh.vertices), commands: mesh.commands, meta, automap, complete: base.complete };
}

/**
 * Stand further definitions on top of one: their faces are drawn after the
 * base's, and their collision is added to it where the base's own collision
 * mode allows (an open or strip-masked cell; ramps and diagonals keep theirs).
 * The base's behavior is kept.
 */
export function mergeDefinitions(base: CellDefinition, extras: readonly CellDefinition[]): CellDefinition {
  const vertices: number[] = [...base.vertices];
  const commands: FaceCommand[] = base.commands.map((c) => ({ ...c, indices: [...c.indices] }));
  const isPolygonProfile = (a: Uint16Array) => a[0] === 1 && a[1] === 0xffff;
  let automap = base.automap;
  let flags = flagsOf(base.meta);
  let mask = maskOf(base.meta);
  // For some trigger classes the mask word is an object index, not collision.
  const maskIsData = (flags & CLASS_MASK) === CLASS_ACTION;
  for (const extra of extras) {
    const offset = vertices.length / 3;
    vertices.push(...extra.vertices);
    for (const c of extra.commands) commands.push({ ...c, indices: c.indices.map((i) => i + offset) });
    if (extra.automap && !isPolygonProfile(extra.automap)) {
      const lines = [...extra.automap.subarray(0, extra.automap.length - 2)].map((i) => i + offset);
      if (!automap) automap = Uint16Array.from([...lines, 0xffff, 0xffff]);
      else if (!isPolygonProfile(automap)) automap = Uint16Array.from([...automap.subarray(0, automap.length - 2), ...lines, 0xffff, 0xffff]);
    }
    const extraFlags = flagsOf(extra.meta);
    if (flags & FLAG_SOLID) continue;
    if (extraFlags & FLAG_SOLID) {
      flags = (flags & ~(FLAG_GROUND | COLLISION_MODE_MASK | RAMP_BAND_MASK | RAMP_DIRECTION_MASK)) | FLAG_SOLID;
      if (!maskIsData) mask = 0;
      continue;
    }
    flags |= extraFlags & FLAG_GROUND;
    if (flags & RAMP_BAND_MASK) continue;
    const mode = flags & COLLISION_MODE_MASK;
    const extraMode = extraFlags & COLLISION_MODE_MASK;
    if (extraMode === COLLISION_MASK && maskOf(extra.meta) && !maskIsData && (mode === COLLISION_OPEN || mode === COLLISION_MASK)) {
      flags = (flags & ~COLLISION_MODE_MASK) | COLLISION_MASK;
      mask |= maskOf(extra.meta);
    } else if (extraMode === COLLISION_DIAGONAL && mode === COLLISION_OPEN) {
      flags = (flags & ~0x0186) | (extraFlags & 0x0186);
    }
  }
  const meta = base.meta.slice();
  meta[0] = flags & 0xff;
  meta[1] = flags >> 8;
  if (!maskIsData) {
    meta[2] = mask & 0xff;
    meta[3] = mask >> 8;
  }
  return { vertices: Int16Array.from(vertices), commands, meta, automap, complete: base.complete && extras.every((e) => e.complete) };
}
