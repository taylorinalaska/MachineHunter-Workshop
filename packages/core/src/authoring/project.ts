/**
 * The editable map project: what the Workshop saves and what the compiler
 * turns into a native MAP.
 *
 * A project keeps *authoring* data (floors, walls dragged along cell edges,
 * ramps, entities, behaviors) separate from the engine's representation.
 * The engine wants exactly one shared "cell definition" per cell; the compiler
 * composes those from the authoring data and de-duplicates them.
 *
 * Three things can occupy a cell, and they stack:
 *   1. a *prop*    - a ready-made cell definition from the project's library
 *                    (imported from a retail level), stored in `layer.cells`;
 *   2. a *surface* - an authored floor, split floor or ramp;
 *   3. *walls*     - authored along cell edges or diagonals, independent of
 *                    whatever fills the cells beside them.
 * A cell may also carry a *behavior* (teleporter, exit, hazard) that replaces
 * the behavior of whatever it is applied to, and *overlays*: further props
 * standing on top of all of the above. The engine still gets one definition
 * per cell; the compiler merges the pieces.
 */
import type { LevelId } from '../exe/tables.ts';
import type { Edge, TeleporterTarget, RampDirection, RampHalf } from '../map/definition-meta.ts';
import { type CellDefinition, type TextureCycle, type TextureScroll, emptyDefinition, lightingSize } from '../map/model.ts';
import { check } from '../util/binary.ts';
import type { PropModel } from './prop-model.ts';

export const PROJECT_FORMAT = 'mh-map-project';
export const PROJECT_VERSION = 6;

/** Lattice light value new layers start with (0..31; the engine halves it, then adds 4). */
export const DEFAULT_LIGHT = 14;
/**
 * Starting values for a breakable cell: the retail levels' most common
 * toughness, and the effect that throws rubble without hurting anyone
 * (26, their most common one, is a large explosion that damages what is near).
 */
export const DEFAULT_BREAKABLE = { toughness: 30, effect: 8 } as const;
export const MIN_LAYER_SIZE = 4;
export const MAX_LAYER_SIZE = 128;

/* --------------------------------------------------------------- surfaces */

/** Which corner of the cell the tile's top-left texel is pinned to: 0 = NW (upright), then clockwise. */
export type TextureTurn = 0 | 1 | 2 | 3;

export type Corner = 'nw' | 'ne' | 'se' | 'sw';

export interface FloorSurface {
  kind: 'floor';
  /** Terrain tile index, or null for an untextured (invisible but walkable) floor. */
  tile: number | null;
  turn: TextureTurn;
}

/** A floor cut along one diagonal; either half may be missing or painted differently. */
export interface SplitFloorSurface {
  kind: 'split';
  /** 'nw-se' is the "\" diagonal (halves 'ne' and 'sw'); 'ne-sw' is "/" (halves 'nw' and 'se'). */
  diagonal: 'nw-se' | 'ne-sw';
  halves: Partial<Record<Corner, { tile: number | null }>>;
}

export interface RampSurface {
  kind: 'ramp';
  /** The direction you walk to go up. */
  direction: RampDirection;
  half: RampHalf;
  tile: number | null;
  turn: TextureTurn;
  /**
   * Tiles for the faces under the ramp, by cell edge: the two triangular
   * sides that run alongside it and the tall end below its top edge. An edge
   * without an entry is left open.
   */
  sides: Partial<Record<Edge, number>>;
}

/**
 * A solid box standing on the cell: a crate, a plinth, a thick wall segment
 * or, at full height and width, a walkable floor on the layer above. With
 * `pillar` it is a centered square column with a configurable width.
 */
export interface BlockSurface {
  kind: 'block';
  /** Height in cells, up to one layer. */
  height: number;
  topTile: number | null;
  /** Tile per face; a face without an entry is left open. */
  sides: Partial<Record<Edge, number>>;
  pillar: boolean;
  /** Square width in cells; older pillars default to half width. Ignored for full blocks. */
  width?: number;
  /** Floor around a pillar; unused for full blocks. */
  floorTile: number | null;
}

/** Effective square footprint, retaining the half-width default of older maps. */
export function blockWidth(block: Pick<BlockSurface, 'pillar' | 'width'>): number {
  return block.pillar ? Math.max(0.25, Math.min(0.75, block.width ?? 0.5)) : 1;
}

/**
 * The invisible cell directly above the upper half of a ramp. It continues the
 * slope's height into the layer above so actors arrive on that layer
 * smoothly; it must slope the same way as the ramp below it.
 */
export interface RampLandingSurface {
  kind: 'landing';
  direction: RampDirection;
}

export type Surface = FloorSurface | SplitFloorSurface | RampSurface | RampLandingSurface | BlockSurface;

/* ------------------------------------------------------------------ walls */

/**
 * A wall along one unit segment between two lattice points of a layer:
 * a cell edge (cardinal) or a cell diagonal. Endpoints are ordered (x, then y).
 */
export interface Wall {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Height in cells (1 = full layer; smaller values make rails and low walls). */
  height: number;
  tile: number | null;
  /** Diagonals only: which half of the cell is solid (0 or 1). Ignored for cardinal walls. */
  side: 0 | 1;
}

export function wallKey(x0: number, y0: number, x1: number, y1: number): string {
  return x0 < x1 || (x0 === x1 && y0 <= y1) ? `${x0},${y0},${x1},${y1}` : `${x1},${y1},${x0},${y0}`;
}

export function makeWall(ax: number, ay: number, bx: number, by: number, tile: number | null, height = 1, side: 0 | 1 = 0): Wall {
  const swap = !(ax < bx || (ax === bx && ay <= by));
  const [x0, y0, x1, y1] = swap ? [bx, by, ax, ay] : [ax, ay, bx, by];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  check([x0, y0, x1, y1].every(Number.isInteger) && dx <= 1 && dy <= 1 && dx + dy > 0, 'A wall spans one cell edge or one cell diagonal');
  return { x0, y0, x1, y1, height, tile, side };
}

export const isDiagonalWall = (w: Wall): boolean => w.x0 !== w.x1 && w.y0 !== w.y1;

/* ------------------------------------------------------------- behaviors */

export type CellBehaviorSpec =
  | ({ kind: 'teleporter' } & TeleporterTarget)
  | { kind: 'exit' }
  | { kind: 'hazard'; damage: number }
  /**
   * Can be shot to pieces. `toughness` is how much punishment it takes (retail
   * levels use 1 up to 60), `effect` picks the engine's destruction effect
   * (0..31; 8 is flying rubble, 26 a damaging explosion). What it turns into:
   * `result` 'floor' (the default) leaves a plain floor of tile `leaves`;
   * 'broken' keeps the cell as it is, solid and all, with tile `broken` on
   * its upright faces (walls, block sides, props), as the retail cracked
   * walls and broken windows do.
   */
  | { kind: 'breakable'; toughness: number; effect: number; leaves: number; result?: 'floor' | 'broken'; broken?: number }
  /**
   * A door: a panel a quarter of a cell thick across the middle of the cell,
   * standing on the cell's own floor, as the retail doors are. Walking into
   * the cell (or a switch) sinks it into the floor; it stays down about two
   * seconds and comes back up. `facing` is the way you walk through: 'ns'
   * north-south (the panel runs east-west) or 'ew'. `lock` 0 opens on touch;
   * 1..5 needs that key (the five access-channel pickups);
   * `SWITCH_CHANNEL_FIRST` and up opens only once the switch with that channel
   * has been stepped on, and on touch after that. Next to another door with
   * the same lock and facing, along the panel, it opens as a pair.
   */
  | { kind: 'door'; lock: number; tile: number; facing: 'ns' | 'ew'; style?: DoorStyle }
  /**
   * A trigger pad: stepping on it fires the trigger with this channel (see
   * `Trigger`). It opens, and unlocks, the doors with `lock === channel`, then
   * runs the trigger's actions.
   */
  | { kind: 'switch'; channel: number }
  /** Remove whatever behavior the underlying prop has. */
  | { kind: 'plain' };

/**
 * How a door's panel gets out of the way: 'rise' lifts it up past the ceiling
 * an eighth at a time, as the retail doors of ALIEN1 do; 'slide' draws it
 * sideways into the wall, as HOSP0's do (a double door parts in the middle);
 * 'sink' lowers it into the floor. Doors saved before styles existed sink.
 */
export type DoorStyle = 'rise' | 'slide' | 'sink';

/** Door locks: 1..5 are the keys; switches use the channels after them, up to 31. */
export const KEY_COUNT = 5;
export const SWITCH_CHANNEL_FIRST = 6;
export const SWITCH_CHANNEL_LAST = 31;
/** Map types of the five key pickups, by key (the access-channel pickups 1..5). */
export const KEY_PICKUP_TYPES = [70, 72, 73, 71, 69] as const;
/** Steps a door takes to open; with the open floor at the end the chain stays within the engine's 16. */
export const DOOR_STEPS = 8;

/* --------------------------------------------------------------- triggers */

/** Which faces a texture change applies to: upright ones (walls, sides), level ones (floors, tops), or all. */
export type TriggerFaces = 'walls' | 'floor' | 'all';

/**
 * Something a trigger does, run by the Workshop runtime. Places are cells
 * of a layer, except effects, which stand at a point (`x`, `y` in 1/256 cell).
 */
export type TriggerAction =
  /** Break a breakable cell as if it had been shot to pieces: its effect, its sound, what it turns into. */
  | { kind: 'break'; group: number; layer: number; x: number; y: number }
  /** Give a cell's faces another tile; the cell otherwise stays as it is. */
  | { kind: 'retexture'; group: number; layer: number; x: number; y: number; tile: number; faces: TriggerFaces }
  /** Play one of the map's effects (`CustomEffect.id`) once, at a point. */
  | { kind: 'effect'; group: number; layer: number; x: number; y: number; effect: number }
  /** Make an entity that starts disabled appear (`Entity.id`). */
  | { kind: 'reveal'; group: number; layer: number; entity: number };

/**
 * What stepping on a trigger pad does. Pads are cells with the behavior
 * `{ kind: 'switch', channel }`; doors with `lock === channel` open too.
 */
export interface Trigger {
  /** `SWITCH_CHANNEL_FIRST`..`SWITCH_CHANNEL_LAST`. */
  channel: number;
  name: string;
  /** Fire only the first time a pad is stepped on; otherwise every time. */
  once: boolean;
  actions: TriggerAction[];
}

/**
 * Props standing on top of whatever else is in the cell. When `breakable`,
 * shooting the cell removes the overlays and leaves what is underneath,
 * behavior included: a wall across an exit, a crate over a teleporter.
 */
export interface CellOverlay {
  /** Library definition IDs, drawn in this order. */
  props: number[];
  breakable?: { toughness: number; effect: number };
}

/* --------------------------------------------------------------- entities */

export interface Entity {
  /** Unique within the project. Imported entities keep their retail pool index. */
  id: number;
  /** Map type (1 = player start). */
  type: number;
  /** Placement behavior selector, 0..31. For some types it doubles as the spawn facing. */
  behavior: number;
  /** Weapon selector, 0..3 (robots only). */
  weapon: number;
  /** Type-word bit 8; unknown meaning, preserved. */
  bit8: number;
  /** Position inside the layer, 1/256 cell. */
  x: number;
  y: number;
  /** Present in the map but not spawned until a trigger enables it. */
  disabled: boolean;
  /** `ProjectPath.id`, or null. */
  pathId: number | null;
  /** Other bits of the record's flag byte, preserved. */
  flagsRest: number;
  /**
   * Ambient sound emitters only: play one of the project's own sounds here
   * instead of a sound from the theme level's table. Delays are in seconds.
   */
  sound?: { id: number; delay: number; random: number };
  /**
   * This entity is a placed custom effect (`MapProject.effects`): the runtime
   * spawns its particles, so it is not written to the map as an object.
   */
  effect?: number;
  /**
   * A friendly character: it never takes the player as its target. With
   * `follow`, the runtime keeps moving its route to spots near the player, so
   * it needs a route (two points are enough) and the behavior that walks one.
   */
  friendly?: { follow: boolean };
}

/** Friendly characters per map (runtime/src/maps/MHFriends.h). */
export const MAX_FRIENDS = 16;

/**
 * An effect made for the map: one to three of the game's own particles,
 * spawned together every `every` game updates (30 a second), each scattered
 * up to `spread` map units (256 a cell) about the spot.
 */
export interface CustomEffect {
  id: number;
  name: string;
  every: number;
  particles: { fx: number; spread: number }[];
}

export const MAX_EFFECT_PARTICLES = 3;
/** Placed custom effects per map (runtime/src/maps/MHEffectEmitters.h). */
export const MAX_EFFECT_EMITTERS = 96;
/** The engine's effect table runs from 1 to 0xBC. */
export const EFFECT_ID_COUNT = 0xbd;
/** Marker type a placed custom effect carries in the editor (the smoke emitter's), never written to the map. */
export const CUSTOM_EFFECT_TYPE = 90;

/** A sound added to the map: a 22,050 Hz mono 8-bit WAV. */
export interface ProjectSound {
  id: number;
  name: string;
  wav: Uint8Array;
}

/**
 * A retail entity type made over for one map. The engine has a fixed set of
 * types, so this changes every copy of the type in the map: its look (the
 * sprite container in its runtime slot), its name in the Workshop and its
 * numbers. The runtime puts the game's own values back when the map ends.
 */
export interface CustomType {
  /** The retail map type. */
  type: number;
  name: string;
  /** Maximum health, or null for the retail value. */
  health: number | null;
  /** Percent of the retail value, 100 for unchanged. Robots only (their body sets these). */
  speed: number;
  fireRate: number;
  damage: number;
  /** Replacement sprite container (.B) for a runtime slot, or null for the retail look. */
  sprite: { slot: number; data: Uint8Array } | null;
  /** How the replacement look was made, so the editor can show and adjust it. */
  look: CustomLook | null;
  /** Retimed animation records. Absent in maps saved before animations could be edited. */
  animations?: CustomAnimation[];
}

/**
 * One of the type's animation records played differently: which frames of
 * its sprite file it shows and how. Records are the game's own (the
 * executable address of each). Only this type's actors play the change; other
 * types that use the same record keep the game's.
 */
export interface CustomAnimation {
  /** Executable address of the animation record. */
  record: number;
  /** First frame in the sprite file, and how many frames from there. */
  base: number;
  span: number;
  /** Frame within the span playback starts on. */
  start: number;
  /** Game updates each frame is held (30 a second). */
  ticks: number;
  /** 1 hold, 2 loop, 3 back and forth; 4..6 hand over to game code at the end and cannot be changed. */
  mode: number;
  reversed: boolean;
}

export const MAX_CUSTOM_ANIMATIONS = 16;

/** A recolor of the retail frames, or frames imported from a picture. */
export type CustomLook = { kind: 'recolor'; hue: number; saturation: number; brightness: number } | { kind: 'imported'; file: string };

/** Limits the runtime accepts (runtime/src/maps/MHEntityOverrides.h). */
/** The game keeps an actor's health in one byte of its map record, so more than 255 wraps round. */
export const CUSTOM_HEALTH_MAX = 255;
export const CUSTOM_PERCENT_MIN = 10;
export const CUSTOM_PERCENT_MAX = 500;
export const MAX_CUSTOM_TYPES = 16;

/** What a route's follower does at the last point: stop there. */
export const PATH_ONCE = 0;
/** Turn round and walk the points in reverse, forever. */
export const PATH_BACK_AND_FORTH = 1;
/** Go from the last point straight back to the first, forever. */
export const PATH_LOOP = 2;
/**
 * Not a route: three points whose X and Y values, in any combination, are the
 * nine places an entity wanders between.
 */
export const PATH_ZONE = 4;

/**
 * A list of points entities can be sent along. `word0` is the mode (one of the
 * PATH_ constants; the engine treats every value other than 0, 1 and 4 as a loop).
 */
export interface ProjectPath {
  id: number;
  word0: number;
  flag: boolean;
  /** Owning group/layer indices, or -1/-1 for a detached record. */
  group: number;
  layer: number;
  points: { x: number; y: number; tail0: number; tail1: number }[];
}

/* ------------------------------------------------------- layers and groups */

export interface ProjectLayer {
  name: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** Library definition per cell (0 = none), row-major. */
  cells: Uint16Array;
  /** Authored surfaces, keyed by cell index (y * width + x). */
  surfaces: Map<number, Surface>;
  /** Authored walls, keyed by `wallKey`. */
  walls: Map<string, Wall>;
  /** Authored behaviors, keyed by cell index. */
  behaviors: Map<number, CellBehaviorSpec>;
  /** Props stacked on top of the cell's other content, keyed by cell index. */
  overlays: Map<number, CellOverlay>;
  /** (width+1) x (height+1) pairs of [floor light, ceiling light]. */
  lighting: Uint8Array;
  entities: Entity[];
}

export interface ProjectGroup {
  name: string;
  layers: ProjectLayer[];
}

export interface Briefing {
  /** 'inherit' shows the base level's own briefing. */
  mode: 'inherit' | 'custom';
  title: string;
  /** Up to ~2,000 characters; the game does not wrap, so lines are explicit. */
  text: string;
  /** 220x160 8-bit BMP, or null to keep the base level's picture. */
  image: Uint8Array | null;
}

export interface MapProject {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  author: string;
  description: string;
  /** Retail level that supplies the palette, sprite set, music and mission slot. */
  baseLevel: LevelId;
  initialGroup: number;
  /** 'unconditional' opens the exit immediately; 'inherit' keeps the base level's mission rules. */
  exitRule: 'inherit' | 'unconditional';
  briefing: Briefing;
  groups: ProjectGroup[];
  /** Prop library; index is the ID used by `layer.cells`. Entry 0 is always empty. */
  definitions: CellDefinition[];
  /** Where each library definition came from, for display. Parallel to `definitions`. */
  definitionSources: (string | null)[];
  /** The map's terrain tiles (64x64 source indices each). */
  tiles: Uint8Array[];
  /** How many leading tiles are the unmodified bank of `baseLevel`; the rest are additions. */
  baseTileCount: number;
  /** Set once one of the base tiles has been replaced, so the map always ships its own bank. */
  tilesEdited?: boolean;
  paths: ProjectPath[];
  textureScrolls: TextureScroll[];
  textureCycles: TextureCycle[];
  /** Props modeled in the Workshop. Each owns one entry of `definitions`. */
  models: PropModel[];
  /** Sounds added to the map, for ambient emitters. */
  sounds: ProjectSound[];
  /** Retail entity types made over for this map. Absent before version 4. */
  customTypes: CustomType[];
  /** Effects made for this map. Absent before version 4. */
  effects: CustomEffect[];
  /** What trigger pads do, by channel. Absent before version 6. */
  triggers: Trigger[];
  nextId: number;
}

/* --------------------------------------------------------------- creation */

export function createLayer(name: string, width: number, height: number, light = DEFAULT_LIGHT): ProjectLayer {
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 256 && height <= 256, 'Layer dimensions are out of range');
  return {
    name,
    width,
    height,
    originX: 0,
    originY: 0,
    cells: new Uint16Array(width * height),
    surfaces: new Map(),
    walls: new Map(),
    behaviors: new Map(),
    overlays: new Map(),
    lighting: new Uint8Array(lightingSize(width, height)).fill(light),
    entities: [],
  };
}

export interface NewProjectOptions {
  name: string;
  baseLevel: LevelId;
  width: number;
  height: number;
  /** The base level's terrain tiles. */
  tiles: readonly Uint8Array[];
}

export function createProject(o: NewProjectOptions): MapProject {
  check(o.name.trim().length > 0, 'Give the map a name');
  check(o.width >= MIN_LAYER_SIZE && o.height >= MIN_LAYER_SIZE && o.width <= MAX_LAYER_SIZE && o.height <= MAX_LAYER_SIZE, `Map size must be ${MIN_LAYER_SIZE}..${MAX_LAYER_SIZE} cells`);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: o.name.trim().slice(0, 60),
    author: '',
    description: '',
    baseLevel: o.baseLevel,
    initialGroup: 0,
    exitRule: 'unconditional',
    briefing: { mode: 'inherit', title: '', text: '', image: null },
    groups: [{ name: 'Main area', layers: [createLayer('Ground', o.width, o.height)] }],
    definitions: [emptyDefinition()],
    definitionSources: [null],
    tiles: o.tiles.map((t) => t.slice()),
    baseTileCount: o.tiles.length,
    paths: [],
    textureScrolls: [],
    textureCycles: [],
    models: [],
    sounds: [],
    customTypes: [],
    effects: [],
    triggers: [],
    nextId: 1,
  };
}

export function allocateId(project: MapProject): number {
  return project.nextId++;
}

export const cellIndex = (layer: Pick<ProjectLayer, 'width'>, x: number, y: number): number => y * layer.width + x;
export const inLayer = (layer: Pick<ProjectLayer, 'width' | 'height'>, x: number, y: number): boolean => x >= 0 && y >= 0 && x < layer.width && y < layer.height;

/** Grow or shrink a layer, keeping content anchored at its top-left corner. */
export function resizeLayer(layer: ProjectLayer, width: number, height: number, light = DEFAULT_LIGHT): void {
  check(width >= 1 && height >= 1 && width <= 256 && height <= 256, 'Layer dimensions are out of range');
  const cells = new Uint16Array(width * height);
  const lighting = new Uint8Array(lightingSize(width, height)).fill(light);
  const surfaces = new Map<number, Surface>();
  const behaviors = new Map<number, CellBehaviorSpec>();
  const overlays = new Map<number, CellOverlay>();
  for (let y = 0; y < Math.min(height, layer.height); y++) {
    for (let x = 0; x < Math.min(width, layer.width); x++) {
      const from = y * layer.width + x;
      const to = y * width + x;
      cells[to] = layer.cells[from];
      const s = layer.surfaces.get(from);
      if (s) surfaces.set(to, s);
      const b = layer.behaviors.get(from);
      if (b) behaviors.set(to, b);
      const o = layer.overlays.get(from);
      if (o) overlays.set(to, o);
    }
  }
  for (let y = 0; y <= Math.min(height, layer.height); y++) {
    for (let x = 0; x <= Math.min(width, layer.width); x++) {
      const from = (y * (layer.width + 1) + x) * 2;
      const to = (y * (width + 1) + x) * 2;
      lighting[to] = layer.lighting[from];
      lighting[to + 1] = layer.lighting[from + 1];
    }
  }
  for (const [key, wall] of layer.walls) {
    if (Math.max(wall.x0, wall.x1) > width || Math.max(wall.y0, wall.y1) > height) layer.walls.delete(key);
  }
  layer.entities = layer.entities.filter((e) => e.x < width * 256 && e.y < height * 256);
  Object.assign(layer, { width, height, cells, lighting, surfaces, behaviors, overlays });
}

/** Derive walkable block tops and ramp transitions without mutating editing data.
 * The lower layer already draws a block's top; its upper floor needs collision only.
 */
export function withLayerConnections(layer: ProjectLayer, below?: ProjectLayer): ProjectLayer {
  const landings = new Map<number, RampDirection>();
  const blockTops: number[] = [];
  if (below) for (const [index, surface] of below.surfaces) {
    const ramp = surface.kind === 'ramp' && surface.half === 'upper';
    const block = surface.kind === 'block' && !surface.pillar && surface.height >= 1 && surface.topTile !== null;
    if (!ramp && !block) continue;
    const x = index % below.width + below.originX - layer.originX;
    const y = Math.floor(index / below.width) + below.originY - layer.originY;
    if (!inLayer(layer, x, y)) continue;
    if (surface.kind === 'ramp') landings.set(cellIndex(layer, x, y), surface.direction);
    else blockTops.push(cellIndex(layer, x, y));
  }
  const surfaces = new Map(layer.surfaces);
  for (const [index, surface] of surfaces) if (surface.kind === 'landing' && !landings.has(index)) surfaces.delete(index);
  for (const index of blockTops) if (!layer.cells[index] && !surfaces.has(index)) surfaces.set(index, { kind: 'floor', tile: null, turn: 0 });
  for (const [index, direction] of landings) {
    const surface = surfaces.get(index);
    // Solid objects need an explicit edit; do not silently remove someone's scenery.
    if (!layer.cells[index] && (!surface || surface.kind === 'floor' || surface.kind === 'landing')) surfaces.set(index, { kind: 'landing', direction });
  }
  return { ...layer, surfaces };
}
