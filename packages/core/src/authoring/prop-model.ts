/**
 * Custom props built from simple parts: boxes, wedges, pyramids, roofs,
 * cylinders and cones, each placed, sized and turned inside one map cell and
 * one layer of height, with a texture per face.
 *
 * A model compiles to an ordinary cell definition, drawn and collided with
 * like the retail scenery. What the engine needs (see
 * research/notes/renderer_and_compiler_findings.md §1 and §15):
 *   - Faces are single-sided quads, front faces clockwise on screen. Faces
 *     that point down can never be seen from the game's camera above and are
 *     left out, as are faces hidden inside or against other parts.
 *   - There is no depth test inside a cell: faces are drawn in listed order,
 *     so they are sorted lowest first.
 *   - There are no textured triangles. A triangle is written as a quad with a
 *     fourth corner on its longest edge.
 *   - There are no texture coordinates: a face always shows one whole tile,
 *     pinned to its corners. With `mapping: 'scale'` the compiler bakes a
 *     tile per face that shows the texture at its natural size, lined up
 *     with the world, so it fits any slant or shape. `'stretch'` fits the
 *     whole tile to every face and costs no extra tiles.
 */
import { COLLISION_MASK, FLAG_GROUND, FLAG_SOLID, makeMeta } from '../map/definition-meta.ts';
import { type CellDefinition, type FaceCommand, OP_DIAGONAL_A, OP_DIAGONAL_B, OP_FLOOR, OP_SLOPE_X, OP_SLOPE_Y, OP_WALL_X, OP_WALL_Y, uvRotation } from '../map/model.ts';
import type { MaskedTileResolver } from './compose.ts';

/** Steps along each side of a cell (and up a layer) that parts snap to. */
export const PROP_STEPS = 16;
/** Map units per step (a cell is 256 units). */
export const PROP_STEP_UNITS = 256 / PROP_STEPS;
/** Faces the busiest retail cell uses. */
export const RETAIL_MAX_CELL_FACES = 22;
/** Above this a prop is reported as heavy: the game draws at most 2,047 faces a frame. */
export const PROP_FACE_WARNING = 48;
/** The cell renderer keeps about 258 vertices for one cell, the floor and walls under a prop included. */
export const PROP_MAX_VERTICES = 200;
/** A part whose bottom is at least this high (in steps) does not block movement: heads pass under it. */
export const PROP_OVERHEAD_STEPS = 8;

export const PART_SHAPES = ['box', 'wedge', 'pyramid', 'roof', 'cylinder', 'cone'] as const;
export type PartShape = (typeof PART_SHAPES)[number];

export interface PropPart {
  shape: PartShape;
  /** The box the part fills, in steps: x east, y south, z up from the floor. */
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Quarter turns clockwise seen from above: which way a wedge rises or a roof's ridge runs. */
  turn: 0 | 1 | 2 | 3;
  /** Sides of a cylinder or cone. */
  sides?: number;
  tile: number;
  /** Tiles of single faces, by the shape's face number (see `faceNames`). */
  faces?: Record<number, number>;
}

export interface PropModel {
  /** Unique within the project. */
  id: number;
  name: string;
  /** The library definition this model is compiled into. */
  definitionId: number;
  parts: PropPart[];
  /** Tile new parts start with. */
  tile: number;
  mapping: 'scale' | 'stretch';
  /** Moves the textures of every face by this many map units (x east, y south, z up). Not offered in the builder: sliding door panels carry their texture along. */
  textureShift?: [number, number, number];
  /**
   * 'auto' blocks the quarter-cells parts stand on, 'solid' the whole cell, 'none' nothing.
   * 'footprint' (not offered in the builder) is 'auto' with parts overhead blocking too.
   */
  collision: 'auto' | 'solid' | 'none' | 'footprint';
}

export function createPropModel(id: number, definitionId: number, name: string, tile: number): PropModel {
  return { id, name, definitionId, parts: [], tile, mapping: 'scale', collision: 'auto' };
}

export const DEFAULT_SIDES = 8;

/** Names of a shape's faces, by face number. */
export function faceNames(shape: PartShape): Record<number, string> {
  switch (shape) {
    case 'box':
      return { 0: 'Top', 1: 'North', 2: 'East', 3: 'South', 4: 'West' };
    case 'wedge':
      return { 0: 'Slope', 1: 'Back', 2: 'Side', 4: 'Side' };
    case 'pyramid':
      return { 1: 'North', 2: 'East', 3: 'South', 4: 'West' };
    case 'roof':
      return { 1: 'Slope', 2: 'Gable', 3: 'Slope', 4: 'Gable' };
    default:
      return { 0: shape === 'cone' ? 'Point' : 'Top' };
  }
}

/* ------------------------------------------------------------ geometry */

type Vec = [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: Vec): Vec => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l ? scale(a, 1 / l) : [0, 0, 0];
};

/** A convex polygon of a part, in map units with z up; `face` is the shape's face number. */
interface PartFace {
  face: number;
  points: Vec[];
  /** Unit outward normal. */
  normal: Vec;
}

/** Newell's normal of a polygon, in the direction its points wind counter-clockwise around. */
function polygonNormal(points: Vec[]): Vec {
  let n: Vec = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  return norm(n);
}

/** Wind a polygon so its normal points along `outward`. */
function facing(face: number, points: Vec[], outward: Vec): PartFace {
  let n = polygonNormal(points);
  if (dot(n, outward) < 0) {
    points = points.slice().reverse();
    n = scale(n, -1);
  }
  return { face, points, normal: n };
}

/**
 * The faces of a part, bottom included (it is needed to tell inside from
 * outside; it is never drawn). Built in the part's own frame, then turned
 * into its box.
 */
function partFaces(part: PropPart): PartFace[] {
  const U = PROP_STEP_UNITS;
  const odd = part.turn % 2 === 1;
  // The part's own width and depth before turning.
  const W = (odd ? part.d : part.w) * U;
  const D = (odd ? part.w : part.d) * U;
  const H = part.h * U;
  const local: { face: number; points: Vec[] }[] = [];
  const quad = (face: number, ...points: Vec[]) => local.push({ face, points });
  const bottomRect: Vec[] = [
    [0, 0, 0],
    [W, 0, 0],
    [W, D, 0],
    [0, D, 0],
  ];

  switch (part.shape) {
    case 'box':
      quad(0, [0, 0, H], [W, 0, H], [W, D, H], [0, D, H]);
      quad(1, [0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H]);
      quad(2, [W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]);
      quad(3, [0, D, 0], [W, D, 0], [W, D, H], [0, D, H]);
      quad(4, [0, 0, 0], [0, D, 0], [0, D, H], [0, 0, H]);
      quad(-1, ...bottomRect);
      break;
    case 'wedge':
      // Rises to the north.
      quad(0, [0, D, 0], [W, D, 0], [W, 0, H], [0, 0, H]);
      quad(1, [0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H]);
      quad(2, [W, 0, 0], [W, D, 0], [W, 0, H]);
      quad(4, [0, 0, 0], [0, D, 0], [0, 0, H]);
      quad(-1, ...bottomRect);
      break;
    case 'pyramid': {
      const apex: Vec = [W / 2, D / 2, H];
      quad(1, [0, 0, 0], [W, 0, 0], apex);
      quad(2, [W, 0, 0], [W, D, 0], apex);
      quad(3, [W, D, 0], [0, D, 0], apex);
      quad(4, [0, D, 0], [0, 0, 0], apex);
      quad(-1, ...bottomRect);
      break;
    }
    case 'roof':
      // The ridge runs east-west.
      quad(1, [0, 0, 0], [W, 0, 0], [W, D / 2, H], [0, D / 2, H]);
      quad(3, [0, D, 0], [W, D, 0], [W, D / 2, H], [0, D / 2, H]);
      quad(2, [W, 0, 0], [W, D, 0], [W, D / 2, H]);
      quad(4, [0, 0, 0], [0, D, 0], [0, D / 2, H]);
      quad(-1, ...bottomRect);
      break;
    case 'cylinder':
    case 'cone': {
      const n = Math.max(3, Math.min(12, part.sides ?? DEFAULT_SIDES));
      // Flat sides face north, east, south and west where the count allows.
      const ring = (z: number): Vec[] => Array.from({ length: n }, (_, k) => [W / 2 + (W / 2) * Math.cos(((k + 0.5) / n) * Math.PI * 2 - Math.PI / 2), D / 2 + (D / 2) * Math.sin(((k + 0.5) / n) * Math.PI * 2 - Math.PI / 2), z] as Vec);
      const base = ring(0);
      if (part.shape === 'cylinder') {
        const top = ring(H);
        for (let k = 0; k < n; k++) quad(k + 1, base[k], base[(k + 1) % n], top[(k + 1) % n], top[k]);
        // The top as a fan of quads (and a last triangle when the count is odd).
        for (let k = 1; k < n - 1; k += 2) quad(0, top[0], top[k], top[k + 1], ...(k + 2 < n ? [top[k + 2]] : []));
      } else {
        const apex: Vec = [W / 2, D / 2, H];
        for (let k = 0; k < n; k++) quad(k + 1, base[k], base[(k + 1) % n], apex);
      }
      quad(-1, ...base);
      break;
    }
  }

  // Turn into the part's box and move it into place.
  const ox = part.x * U;
  const oy = part.y * U;
  const oz = part.z * U;
  const w = part.w * U;
  const d = part.d * U;
  const turn = ([x, y, z]: Vec): Vec => {
    switch (part.turn) {
      case 1:
        return [ox + w - y, oy + x, oz + z];
      case 2:
        return [ox + w - x, oy + d - y, oz + z];
      case 3:
        return [ox + y, oy + d - x, oz + z];
      default:
        return [ox + x, oy + y, oz + z];
    }
  };
  // The average of a convex shape's corners lies strictly inside it (its box's middle can lie on a face: a wedge's slope).
  const corners = new Map<string, Vec>();
  for (const { points } of local) for (const p of points) corners.set(p.join(','), turn(p));
  const center = scale([...corners.values()].reduce(add, [0, 0, 0]), 1 / corners.size);
  return local.map(({ face, points }) => {
    const placed = points.map(turn);
    const middle = scale(placed.reduce(add, [0, 0, 0]), 1 / placed.length);
    // Every shape is convex, so the outward side is the one away from its inside (the bottom always faces down).
    return facing(face, placed, face === -1 ? [0, 0, -1] : sub(middle, center));
  });
}

/** Inside test for one part: behind every face plane. */
function inside(faces: PartFace[], p: Vec): boolean {
  for (const f of faces) if (dot(f.normal, sub(p, f.points[0])) > -0.25) return false;
  return true;
}

/** A face of the finished model, in drawing order. */
export interface PropFace {
  /** Index of the part in `model.parts`. */
  part: number;
  /** The shape's face number. */
  face: number;
  tile: number;
  /** Corners in map units (z negative upwards), wound and ordered for the engine; 4 of them. */
  points: Vec[];
  op: number;
  /** Texture coordinates, in texels at natural scale, of the tile's corners: top-left, top-right, bottom-right, bottom-left. */
  uv: [number, number][];
}

const TEXEL_UNITS = 256 / 64;

/** Texture axes of a face, so neighboring faces line up and textures stand upright. */
function textureAxes(n: Vec): { u: Vec; v: Vec } {
  if (n[2] > 0.999) return { u: [1, 0, 0], v: [0, 1, 0] };
  const h = norm([n[0], n[1], 0]);
  const down: Vec = [0, 0, -1];
  return { u: [h[1], -h[0], 0], v: norm(sub(down, scale(n, dot(down, n)))) };
}

function opFor(n: Vec): number {
  if (n[2] > 0.999) return OP_FLOOR;
  if (Math.abs(n[2]) < 0.001) {
    if (Math.abs(n[0]) > 0.999) return OP_WALL_X;
    if (Math.abs(n[1]) > 0.999) return OP_WALL_Y;
    if (Math.abs(Math.abs(n[0]) - Math.abs(n[1])) < 0.001) return n[0] * n[1] < 0 ? OP_DIAGONAL_A : OP_DIAGONAL_B;
    return Math.abs(n[0]) > Math.abs(n[1]) ? OP_WALL_X : OP_WALL_Y;
  }
  return Math.abs(n[0]) > Math.abs(n[1]) ? OP_SLOPE_X : OP_SLOPE_Y;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/** A triangle as the engine's quad: a fourth corner on the longest edge, placed last so the first three stay a true triangle. */
function triangleAsQuad(points: Vec[]): Vec[] {
  let best = 0;
  for (let k = 0; k < 3; k++) {
    const len = (i: number) => {
      const e = sub(points[(i + 1) % 3], points[i]);
      return dot(e, e);
    };
    if (len(k) > len(best)) best = k;
  }
  // Rotate so the longest edge runs from the third corner back to the first.
  const [a, b, c] = [points[(best + 1) % 3], points[(best + 2) % 3], points[best]];
  const e = sub(a, c);
  // A point exactly on the edge, so the quad stays flat and convex.
  const g = gcd(gcd(e[0], e[1]), e[2]);
  const m: Vec = g >= 2 ? add(c, scale(e, Math.floor(g / 2) / g)) : c;
  return [a, b, c, m];
}

/**
 * The visible faces of a model, ready for the engine: hidden faces removed,
 * triangles made into quads, sorted lowest first.
 */
export function meshPropModel(model: PropModel): PropFace[] {
  const solids = model.parts.map(partFaces);
  const out: (PropFace & { top: number; flat: boolean })[] = [];
  model.parts.forEach((part, index) => {
    for (const f of solids[index]) {
      // Bottoms and anything facing down are never seen from above.
      if (f.face < 0 || f.normal[2] < -0.001) continue;
      // Hidden when every sample just in front of it lies inside other parts.
      const middle = scale(f.points.reduce(add, [0, 0, 0]), 1 / f.points.length);
      const samples = [middle, ...f.points.map((p) => add(p, scale(sub(middle, p), 0.15)))].map((p) => add(p, scale(f.normal, 1)));
      if (samples.every((p) => solids.some((other, j) => j !== index && inside(other, p)))) continue;

      const rounded = f.points.map((p) => p.map(Math.round) as Vec);
      let points = rounded.length === 3 ? triangleAsQuad(rounded) : rounded;
      const op = opFor(f.normal);
      const { u, v } = textureAxes(f.normal);
      const shift: Vec = model.textureShift ?? [0, 0, 0];
      const texel = (p: Vec): [number, number] => [dot(add(p, shift), u) / TEXEL_UNITS, dot(add(p, shift), v) / TEXEL_UNITS];
      const r = uvRotation(op);
      if (rounded.length === 4) {
        // Start the quad where the tile's top-left corner lands highest and furthest left, so stretched tiles stand upright.
        let shift = 0;
        let bestKey = Infinity;
        for (let s = 0; s < 4; s++) {
          const [tu, tv] = texel(points[(s + r) % 4]);
          const key = tv * 1e4 + tu;
          if (key < bestKey - 1e-6) [bestKey, shift] = [key, s];
        }
        points = points.map((_, k) => points[(k + shift) % 4]);
      }
      const uv = [0, 1, 2, 3].map((c) => texel(points[(c + r) % 4]));
      const tile = part.faces?.[f.face] ?? part.tile;
      out.push({ part: index, face: f.face, tile, op, uv, points: points.map(([x, y, z]) => [x, y, -z] as Vec), top: Math.max(...rounded.map((p) => p[2])), flat: op === OP_FLOOR });
    }
  });
  // No depth test inside a cell: lower faces first, and a level face after the sides that reach its height.
  out.sort((a, b) => a.top - b.top || Number(a.flat) - Number(b.flat) || a.part - b.part);
  return out.map(({ top: _top, flat: _flat, ...face }) => face);
}

/** 4x4 collision mask of the quarter-cells parts stand in (parts overhead are left out). */
export function propFootprintMask(model: PropModel): number {
  let mask = 0;
  for (const p of model.parts) {
    if ((p.z >= PROP_OVERHEAD_STEPS && model.collision !== 'footprint') || p.h <= 0) continue;
    const q = PROP_STEPS / 4;
    for (let qy = 0; qy < 4; qy++) for (let qx = 0; qx < 4; qx++) if (p.x < (qx + 1) * q && p.x + p.w > qx * q && p.y < (qy + 1) * q && p.y + p.d > qy * q) mask |= 0x8000 >> (qx + qy * 4);
  }
  return mask;
}

export const propIsEmpty = (model: PropModel): boolean => model.parts.length === 0;

/** Whether a face's baked tile would be the tile itself: one whole tile, upright and lined up. */
function wholeTile(uv: [number, number][]): boolean {
  const [tl, tr, br, bl] = uv;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const aligned = (x: number) => near(x / 64, Math.round(x / 64));
  return aligned(tl[0]) && aligned(tl[1]) && near(tr[0], tl[0] + 64) && near(tr[1], tl[1]) && near(br[0], tl[0] + 64) && near(br[1], tl[1] + 64) && near(bl[0], tl[0]) && near(bl[1], tl[1] + 64);
}

/**
 * Compile a model into a cell definition. `resolve` bakes the tiles for
 * 'scale' mapping; without it (or with 'stretch') faces use whole tiles.
 */
export function buildPropDefinition(model: PropModel, resolve?: MaskedTileResolver): CellDefinition {
  const vertices: number[] = [];
  const index = new Map<string, number>();
  const vertex = (p: Vec): number => {
    const key = p.join(',');
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length / 3;
      vertices.push(p[0], p[1], p[2]);
      index.set(key, i);
    }
    return i;
  };
  const commands: FaceCommand[] = [];
  const automap: number[] = [];
  for (const face of meshPropModel(model)) {
    const baked = model.mapping === 'scale' && resolve && !wholeTile(face.uv);
    const texture = baked ? resolve(face.tile, { kind: 'warp', uv: face.uv.map(([u, v]) => [Math.round(u * 8) / 8, Math.round(v * 8) / 8] as [number, number]) }) : face.tile;
    const indices = face.points.map(vertex);
    commands.push({ op: face.op, texture, indices });
    if (face.op === OP_FLOOR) for (let k = 0; k < 4; k++) automap.push(indices[k], indices[(k + 1) & 3]);
  }
  const mask = propFootprintMask(model);
  let flags = FLAG_GROUND;
  let collisionMask = 0;
  if (model.collision === 'solid' || (model.collision === 'auto' && mask === 0xffff)) flags = FLAG_SOLID;
  else if ((model.collision === 'auto' || model.collision === 'footprint') && mask) {
    flags = FLAG_GROUND | COLLISION_MASK;
    collisionMask = mask;
  }
  return {
    vertices: Int16Array.from(vertices),
    commands,
    meta: makeMeta(flags, collisionMask),
    automap: automap.length ? Uint16Array.from([...automap, 0xffff, 0xffff]) : null,
    complete: true,
  };
}

/* ------------------------------------------------------------- editing */

/** Keep a part inside the cell and the layer, at least one step in each direction. */
export function clampPart(part: PropPart): void {
  const S = PROP_STEPS;
  part.w = Math.max(1, Math.min(S, Math.round(part.w)));
  part.d = Math.max(1, Math.min(S, Math.round(part.d)));
  part.h = Math.max(1, Math.min(S, Math.round(part.h)));
  part.x = Math.max(0, Math.min(S - part.w, Math.round(part.x)));
  part.y = Math.max(0, Math.min(S - part.d, Math.round(part.y)));
  part.z = Math.max(0, Math.min(S - part.h, Math.round(part.z)));
}

/** Turn a part a quarter clockwise about its middle. Faces keep their tiles. */
export function turnPart(part: PropPart): void {
  const cx = part.x + part.w / 2;
  const cy = part.y + part.d / 2;
  [part.w, part.d] = [part.d, part.w];
  part.x = Math.round(cx - part.w / 2);
  part.y = Math.round(cy - part.d / 2);
  part.turn = ((part.turn + 1) % 4) as PropPart['turn'];
  clampPart(part);
}

/* ------------------------------------------------- props from earlier versions */

/** Faces of the old 8x8x8 block props, in the order their paint keys used. */
const LEGACY_GRID = 8;

/**
 * Turn a prop saved by an earlier version (blocks on an 8x8x8 grid with
 * painted faces) into boxes, merging blocks whose faces are painted alike.
 */
export function partsFromBlocks(voxels: Uint8Array, tile: number, paint: Map<number, number>): PropPart[] {
  const G = LEGACY_GRID;
  const at = (x: number, y: number, z: number) => x + y * G + z * G * G;
  const keyOf = (i: number) => [0, 1, 2, 3, 4].map((f) => paint.get(i * 5 + f) ?? tile).join(',');
  const used = new Uint8Array(voxels.length);
  const parts: PropPart[] = [];
  const free = (x: number, y: number, z: number, key: string) => x < G && y < G && z < G && voxels[at(x, y, z)] !== 0 && !used[at(x, y, z)] && keyOf(at(x, y, z)) === key;
  for (let z = 0; z < G; z++) {
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = at(x, y, z);
        if (!voxels[i] || used[i]) continue;
        const key = keyOf(i);
        let x1 = x + 1;
        while (free(x1, y, z, key)) x1++;
        let y1 = y + 1;
        rows: while (y1 < G) {
          for (let k = x; k < x1; k++) if (!free(k, y1, z, key)) break rows;
          y1++;
        }
        let z1 = z + 1;
        layers: while (z1 < G) {
          for (let j = y; j < y1; j++) for (let k = x; k < x1; k++) if (!free(k, j, z1, key)) break layers;
          z1++;
        }
        for (let c = z; c < z1; c++) for (let b = y; b < y1; b++) for (let a = x; a < x1; a++) used[at(a, b, c)] = 1;
        const tiles = key.split(',').map(Number);
        const faces: Record<number, number> = {};
        tiles.forEach((t, f) => {
          if (t !== tile) faces[f] = t;
        });
        parts.push({ shape: 'box', x: x * 2, y: y * 2, z: z * 2, w: (x1 - x) * 2, d: (y1 - y) * 2, h: (z1 - z) * 2, turn: 0, tile, ...(Object.keys(faces).length ? { faces } : {}) });
      }
    }
  }
  return parts;
}
