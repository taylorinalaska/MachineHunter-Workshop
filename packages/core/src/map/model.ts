/**
 * In-memory model of a decompressed .MAP file.
 *
 * Coordinates are kept in the file's own fixed point: 256 units per cell.
 * A map is a list of independent *groups* (separate rooms/areas that share no
 * coordinate space; the engine supports at most three). Each group stacks
 * *layers* (layers). A layer is a grid of cells; each cell names one of the
 * map's shared *cell definitions*, which bundle a small mesh, a collision
 * profile and optional behavior.
 */

/** Units per cell for vertices, objects and path points. */
export const CELL_UNITS = 256;
/** A cell word's low 11 bits select its definition. */
export const DEFINITION_MASK = 0x07ff;
export const MAX_DEFINITIONS = 2048;
export const MAX_GROUPS = 3;
/** The engine's map buffer; a compiled map must fit. */
export const MAX_MAP_BYTES = 0x50000;
/** The engine's automap (.LMP) buffer. */
export const MAX_LMP_BYTES = 0x5000;
export const OBJECT_RECORD_BYTES = 36;
export const LAYER_DESCRIPTOR_BYTES = 0x80;

/* ---------------------------------------------------------- face commands */

/** Textured quad opcodes: wall (x constant), wall (y constant), floor, the two diagonals, the two slopes. */
export const OP_WALL_X = 5;
export const OP_WALL_Y = 6;
export const OP_FLOOR = 7;
export const OP_DIAGONAL_A = 10;
export const OP_DIAGONAL_B = 11;
export const OP_TRIANGLE = 12;
export const OP_SLOPE_Y = 13;
export const OP_SLOPE_X = 14;

export const TEXTURED_OPS: ReadonlySet<number> = new Set([5, 6, 7, 10, 11, 13, 14]);
/** Untextured four-vertex faces. */
export const FLAT_QUAD_OPS: ReadonlySet<number> = new Set([9, 15, 16]);

/** Texture word: low 14 bits pick the tile; 0x8000 makes index 0 transparent; 0x4000 selects additive "color add". */
export const TEXTURE_INDEX_MASK = 0x3fff;
export const TEXTURE_MASKED = 0x8000;
export const TEXTURE_ADDITIVE = 0x4000;

/**
 * One command of a definition's face stream.
 *   - textured quads: op 5/6/7/10/11/13/14, `texture` word, four vertex indices
 *   - flat quads:     op 9/15/16, four indices
 *   - triangle:       op 12, three indices
 *   - control:        op 1/18 (no payload) and op 2 (two payload words in `indices`)
 */
export interface FaceCommand {
  op: number;
  /** Texture word for textured quads, otherwise null. */
  texture: number | null;
  indices: number[];
}

export const isControlOp = (op: number): boolean => op === 1 || op === 2 || op === 18;

/**
 * Which vertex of a textured quad receives the tile's top-left texel.
 * The renderer assigns tile corners (0,0) (63,0) (63,63) (0,63) to vertices
 * r, r+1, r+2, r+3: r is 0 for floors and 1 for every wall/diagonal/slope.
 */
export const uvRotation = (op: number): number => (op === OP_FLOOR ? 0 : 1);

/* ------------------------------------------------------- cell definitions */

export interface CellDefinition {
  /** x, y, z triples in 1/256 cell. z is negative upwards. */
  vertices: Int16Array;
  commands: FaceCommand[];
  /**
   * 8 metadata bytes: flags word, collision-mask word, then two behavior
   * words. See `map/definition-meta.ts` for the decoded view.
   */
  meta: Uint8Array;
  /**
   * Automap profile: raw 16-bit words of the .LMP payload (vertex-index pairs
   * ending FFFF,FFFF), or null when the definition draws nothing on the automap.
   */
  automap: Uint16Array | null;
  /** False when the face stream contains an opcode this decoder does not know. */
  complete: boolean;
}

/* ----------------------------------------------------------------- objects */

/** Object flag byte (+0x0C): the object exists in the map but does not spawn until something enables it. */
export const OBJECT_DISABLED = 0x01;

export interface MapObject {
  /** Low byte: map type. Bits 9..13: behavior selector. Bits 14..15: weapon selector. */
  typeWord: number;
  /** Position inside the owning layer, 1/256 cell. */
  x: number;
  y: number;
  /** Index into `GameMap.paths`, or -1. */
  pathIndex: number;
  flags: number;
  /**
   * Identity used by "enable object" cells, which name their target by pool
   * index. Parsed objects carry their source index; the writer rewrites the
   * references to wherever each object finally lands. -1 = never referenced.
   * (The rest of the 36-byte record is runtime scratch and is zero on disk.)
   */
  poolIndex: number;
}

export const objectMapType = (o: Pick<MapObject, 'typeWord'>): number => o.typeWord & 0xff;
export const objectBehavior = (o: Pick<MapObject, 'typeWord'>): number => (o.typeWord >> 9) & 0x1f;
export const objectWeapon = (o: Pick<MapObject, 'typeWord'>): number => (o.typeWord >> 14) & 0x03;
export const makeTypeWord = (mapType: number, behavior = 0, weapon = 0, bit8 = 0): number =>
  (mapType & 0xff) | ((bit8 & 1) << 8) | ((behavior & 0x1f) << 9) | ((weapon & 3) << 14);

/* ------------------------------------------------------------------ layers */

export interface MapLayer {
  width: number;
  height: number;
  /** Position of the layer's cell (0,0) in its group's coordinate space, in cells. */
  originX: number;
  originY: number;
  /** width x height cell words, row-major. */
  cells: Uint16Array;
  /** (width+1) x (height+1) lattice of [floor light, ceiling light] byte pairs (0..31), or null. */
  lighting: Uint8Array | null;
  objects: MapObject[];
}

export interface MapGroup {
  layers: MapLayer[];
}

/* ------------------------------------------------- paths and texture fx */

export interface PathPoint {
  /** Position inside the path's layer, 1/256 cell. */
  x: number;
  y: number;
  tail0: number;
  tail1: number;
}

export interface MapPath {
  /** Endpoint/mode word; semantics are behavior-specific. */
  word0: number;
  /** Bit 15 of the stored count word. */
  flag: boolean;
  /** Owning group/layer; -1/-1 marks a detached record. */
  group: number;
  layer: number;
  points: PathPoint[];
}

/** Scrolls the pixels of one terrain tile every update. */
export interface TextureScroll {
  texture: number;
  axis: number;
  direction: number;
}

/** Cycles a terrain tile slot through a list of tiles. */
export interface TextureCycle {
  texture: number;
  period: number;
  counter: number;
  frames: number[];
}

export interface GameMap {
  groups: MapGroup[];
  /** Index is the definition ID; entry 0 is the empty cell. */
  definitions: CellDefinition[];
  paths: MapPath[];
  textureScrolls: TextureScroll[];
  textureCycles: TextureCycle[];
}

/* ----------------------------------------------------------------- helpers */

export function emptyDefinition(): CellDefinition {
  return { vertices: new Int16Array(0), commands: [], meta: new Uint8Array(8), automap: null, complete: true };
}

export function lightingSize(width: number, height: number): number {
  return (width + 1) * (height + 1) * 2;
}

/** Height of a layer's floor above its group's base, in 1/256 cell: layers are one cell apart. */
export const layerElevation = (layerIndex: number): number => layerIndex * CELL_UNITS;

/** Every object in pool order: group, layer, row, then ascending x. */
export function* allObjects(map: GameMap): Generator<{ object: MapObject; group: number; layer: number }> {
  for (let g = 0; g < map.groups.length; g++) {
    const layers = map.groups[g].layers;
    for (let l = 0; l < layers.length; l++) {
      for (const object of layers[l].objects) yield { object, group: g, layer: l };
    }
  }
}
