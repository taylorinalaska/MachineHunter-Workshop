/**
 * Project -> native MAP compiler.
 *
 * Walks every cell, composes the definition that represents what the author
 * put there, de-duplicates definitions, generates any cut ("masked") tiles,
 * and hands the result to the MAP/LMP writers.
 */
import { type LevelId, LEVEL_IDS, SINGLE_PLAYER_LEVEL_COUNT } from '../exe/tables.ts';
import { MAX_TILES, RETAIL_MAX_TILES, TILE_BYTES, TILE_SIZE, encodeTerrainBank } from '../gfx/terrain.ts';
import { CLASS_EXIT, CLASS_TELEPORTER, FLAG_GROUND, isDestructible, makeMeta, type Edge, decodeBehavior, definitionClass, withDestructible, withExit, withHazard, withSequence, withTeleporter, stripBehavior } from '../map/definition-meta.ts';
import {
  type CellDefinition,
  DEFINITION_MASK,
  type GameMap,
  MAX_DEFINITIONS,
  MAX_GROUPS,
  type MapObject,
  OBJECT_DISABLED,
  TEXTURED_OPS,
  TEXTURE_ADDITIVE,
  TEXTURE_INDEX_MASK,
  TEXTURE_MASKED,
  OP_FLOOR,
  emptyDefinition,
  makeTypeWord,
} from '../map/model.ts';
import { writeLmp, writeMap } from '../map/write.ts';
import { type CellDiagonal, type CellSpec, type CellWall, type TileMask, composeDefinition, maskKey, maskKeeps, mergeDefinitions, overlayDefinition, specKey } from './compose.ts';
import { PROP_FACE_WARNING, PROP_MAX_VERTICES, PROP_STEP_UNITS, PROP_STEPS, buildPropDefinition, type PropModel, createPropModel } from './prop-model.ts';
import { EFFECT_ID_COUNT, MAX_FRIENDS, MAX_EFFECT_EMITTERS, MAX_EFFECT_PARTICLES, CUSTOM_HEALTH_MAX, CUSTOM_PERCENT_MAX, CUSTOM_PERCENT_MIN, blockWidth, type CellBehaviorSpec, type TriggerFaces, wallKey, MAX_CUSTOM_ANIMATIONS, MAX_CUSTOM_TYPES, type MapProject, withLayerConnections, PATH_ZONE, type ProjectLayer, type Wall, isDiagonalWall, DOOR_STEPS, type DoorStyle, KEY_PICKUP_TYPES, KEY_COUNT, SWITCH_CHANNEL_FIRST, SWITCH_CHANNEL_LAST } from './project.ts';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface Issue {
  level: IssueLevel;
  message: string;
  /** Where the problem is, when it has a place. */
  at?: { group: number; layer: number; x: number; y: number };
}

export interface CompileOptions {
  /**
   * Source-palette index that looks like index 0 but is not transparent.
   * Needed when an opaque tile is cut to a shape: its index-0 pixels must stay
   * visible. The Workshop derives it from the level palette.
   */
  opaqueZeroIndex?: number;
  /** Map types the engine has descriptors for; unknown types are reported. */
  knownTypes?: ReadonlySet<number>;
}

/** A friendly character, found by the runtime by its type and where it is placed in its layer. */
export interface CompiledFriend {
  group: number;
  layer: number;
  x: number;
  y: number;
  type: number;
  follow: boolean;
}

/** A placed custom effect, run by the runtime. Positions are in map units within the area; z is the layer's height. */
export interface CompiledEffect {
  effect: number;
  group: number;
  layer: number;
  x: number;
  y: number;
  z: number;
}

/** What a trigger does, resolved for the runtime. Cells are layer cells; effect points are in map units within the area. */
export type CompiledTriggerAction =
  | { kind: 'break'; group: number; layer: number; x: number; y: number }
  | { kind: 'cell'; group: number; layer: number; x: number; y: number; definition: number }
  | { kind: 'effect'; group: number; x: number; y: number; z: number; effect: number }
  | { kind: 'reveal'; group: number; layer: number; x: number; y: number; type: number };

export interface CompiledTrigger {
  channel: number;
  once: boolean;
  actions: CompiledTriggerAction[];
}

/** One of the map's own sounds, to be played at a place by the runtime. */
export interface CompiledSound {
  /** `ProjectSound.id`. */
  sound: number;
  group: number;
  layer: number;
  /** Position in the area, 1/256 cell. */
  x: number;
  y: number;
  /** Seconds between plays, and the random extra added to each wait. */
  delay: number;
  random: number;
}

export interface CompiledMap {
  map: GameMap;
  mapBytes: Uint8Array;
  lmpBytes: Uint8Array;
  /** Replacement terrain bank, or null when the base level's bank is used unchanged. */
  terrainBytes: Uint8Array | null;
  /** Custom ambient sounds; these are not map objects. */
  sounds: CompiledSound[];
  /** Placed custom effects; these are not map objects either. */
  effects: CompiledEffect[];
  /** Friendly characters; these are ordinary map objects the runtime also looks after. */
  friends: CompiledFriend[];
  /** What trigger pads do, run by the runtime. */
  triggers: CompiledTrigger[];
  issues: Issue[];
  stats: { definitions: number; objects: number; tiles: number; generatedTiles: number; mapBytes: number; lmpBytes: number };
}

export class CompileError extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n') || 'The map could not be compiled');
    this.name = 'CompileError';
  }
}

/* ------------------------------------------------------------ retexture */

/**
 * A definition with another tile on some of its faces: 'walls' the upright
 * ones (walls, block and ramp sides, prop sides), 'floor' the level ones,
 * 'all' both. A face keeps its see-through and additive flags, so a broken
 * window stays a window.
 */
export function retextureDefinition(def: CellDefinition, tile: number, faces: TriggerFaces): CellDefinition {
  const index = tile & TEXTURE_INDEX_MASK;
  return {
    ...def,
    commands: def.commands.map((c) => {
      if (c.texture === null || !TEXTURED_OPS.has(c.op)) return c;
      const level = c.op === OP_FLOOR;
      if (faces !== 'all' && level !== (faces === 'floor')) return c;
      return { ...c, texture: index | (c.texture & (TEXTURE_MASKED | TEXTURE_ADDITIVE)) | (tile & (TEXTURE_MASKED | TEXTURE_ADDITIVE)) };
    }),
  };
}

/* ------------------------------------------------------------ tile bank */

/** The project's tiles plus cut variants generated on demand. */
class CompileTileBank {
  readonly tiles: Uint8Array[];
  private readonly cache = new Map<string, number>();
  generated = 0;

  constructor(
    tiles: readonly Uint8Array[],
    private readonly opaqueZero: number,
    private readonly limit: number,
  ) {
    this.tiles = tiles.slice();
  }

  masked = (word: number, mask: TileMask): number => {
    const key = `${word}:${maskKey(mask)}`;
    let index = this.cache.get(key);
    if (index === undefined) {
      const source = this.tiles[word & TEXTURE_INDEX_MASK];
      if (!source) throw new CompileError([{ level: 'error', message: `Tile ${word & TEXTURE_INDEX_MASK} is not in the map's terrain bank` }]);
      if (this.tiles.length >= this.limit) throw new CompileError([{ level: 'error', message: `Cut floor and ramp tiles push the terrain bank past the ${MAX_TILES}-tile limit. Use fewer distinct tiles on split floors and ramp sides.` }]);
      if (mask.kind === 'warp') {
        // The tile as it lies on a face at natural size: each texel of the new tile is found by
        // blending the corners' coordinates, the way the renderer spreads a tile over a quad.
        const part = new Uint8Array(TILE_BYTES);
        const [tl, tr, br, bl] = mask.uv;
        const wrap = (n: number) => ((Math.floor(n) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
        for (let y = 0; y < TILE_SIZE; y++) {
          const t = (y + 0.5) / TILE_SIZE;
          for (let x = 0; x < TILE_SIZE; x++) {
            const s = (x + 0.5) / TILE_SIZE;
            const u = (tl[0] + (tr[0] - tl[0]) * s) * (1 - t) + (bl[0] + (br[0] - bl[0]) * s) * t;
            const v = (tl[1] + (tr[1] - tl[1]) * s) * (1 - t) + (bl[1] + (br[1] - bl[1]) * s) * t;
            part[y * TILE_SIZE + x] = source[wrap(v) * TILE_SIZE + wrap(u)];
          }
        }
        index = this.tiles.length;
        this.tiles.push(part);
        this.cache.set(key, index);
        this.generated++;
        return index | (word & ~TEXTURE_INDEX_MASK);
      }
      if (mask.kind === 'crop') {
        // Enlarge part of the tile; no pixels are removed, so the face stays an ordinary opaque one.
        const part = new Uint8Array(TILE_BYTES);
        const texels = TILE_SIZE / 8;
        for (let y = 0; y < TILE_SIZE; y++) {
          const sy = Math.min(TILE_SIZE - 1, Math.floor((mask.v0 + ((y + 0.5) / TILE_SIZE) * (mask.v1 - mask.v0)) * texels));
          for (let x = 0; x < TILE_SIZE; x++) {
            const sx = Math.min(TILE_SIZE - 1, Math.floor((mask.u0 + ((x + 0.5) / TILE_SIZE) * (mask.u1 - mask.u0)) * texels));
            part[y * TILE_SIZE + x] = source[sy * TILE_SIZE + sx];
          }
        }
        index = this.tiles.length;
        this.tiles.push(part);
        this.cache.set(key, index);
        this.generated++;
        return index | (word & ~TEXTURE_INDEX_MASK);
      }
      const sourceIsMasked = (word & TEXTURE_MASKED) !== 0;
      const cut = new Uint8Array(TILE_BYTES);
      for (let y = 0; y < TILE_SIZE; y++) {
        for (let x = 0; x < TILE_SIZE; x++) {
          const i = y * TILE_SIZE + x;
          if (!maskKeeps(mask, x, y)) continue;
          const pixel = source[i];
          cut[i] = pixel === 0 && !sourceIsMasked ? this.opaqueZero : pixel;
        }
      }
      index = this.tiles.length;
      this.tiles.push(cut);
      this.cache.set(key, index);
      this.generated++;
    }
    return mask.kind === 'crop' || mask.kind === 'warp' ? index | (word & ~TEXTURE_INDEX_MASK) : index | TEXTURE_MASKED | (word & TEXTURE_ADDITIVE);
  };
}

/* ----------------------------------------------------- wall rasterising */

interface CellOverlay {
  walls: Partial<Record<Edge, CellWall>>;
  diagonals: CellDiagonal[];
}

function isRampLike(layer: ProjectLayer, index: number): boolean {
  const s = layer.surfaces.get(index);
  return s?.kind === 'ramp' || s?.kind === 'landing';
}

/**
 * Decide which cell each wall belongs to. A wall on a shared edge prefers the
 * empty or solid cell outside the walkable floor, then a floor, then a prop, and avoids
 * ramps and cells that already hold a diagonal (those cannot carry edge
 * collision).
 */
/** The cell each wall is drawn in (by wall key), as the compiler places them. Breaking or retexturing that cell changes the wall. */
export function wallCells(layer: ProjectLayer, definitions: readonly CellDefinition[]): Map<string, number> {
  const owners = new Map<string, number>();
  rasteriseWalls(layer, definitions, owners);
  return owners;
}

function rasteriseWalls(layer: ProjectLayer, definitions: readonly CellDefinition[], owners?: Map<string, number>): Map<number, CellOverlay> {
  const overlays = new Map<number, CellOverlay>();
  const at = (index: number): CellOverlay => {
    let o = overlays.get(index);
    if (!o) overlays.set(index, (o = { walls: {}, diagonals: [] }));
    return o;
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < layer.width && y < layer.height;

  const walls = [...layer.walls.values()];
  // Diagonals first so edge walls can avoid the cells they claim.
  for (const wall of walls.filter(isDiagonalWall)) {
    const x = Math.min(wall.x0, wall.x1);
    const y = Math.min(wall.y0, wall.y1);
    if (!inside(x, y)) continue;
    const family: 0 | 1 = (wall.x1 - wall.x0) * (wall.y1 - wall.y0) > 0 ? 0 : 1;
    at(y * layer.width + x).diagonals.push({ family, side: diagonalSide(layer, y * layer.width + x, family, wall), height: wall.height, tile: wall.tile });
    owners?.set(wallKey(wall.x0, wall.y0, wall.x1, wall.y1), y * layer.width + x);
  }
  for (const wall of walls.filter((w) => !isDiagonalWall(w))) {
    const horizontal = wall.y0 === wall.y1;
    const candidates: { x: number; y: number; edge: Edge }[] = horizontal
      ? [
          { x: wall.x0, y: wall.y0 - 1, edge: 'south' },
          { x: wall.x0, y: wall.y0, edge: 'north' },
        ]
      : [
          { x: wall.x0 - 1, y: wall.y0, edge: 'east' },
          { x: wall.x0, y: wall.y0, edge: 'west' },
        ];
    const score = (c: { x: number; y: number }): number => {
      const index = c.y * layer.width + c.x;
      const prop = layer.cells[index] & DEFINITION_MASK;
      let n = 0;
      if (isRampLike(layer, index)) n += 100;
      if (overlays.get(index)?.diagonals.length) n += 80;
      const surface = layer.surfaces.get(index);
      // Keep the wall's quarter-cell collision outside the visible passage.
      // A one-cell corridor must not lose a quarter cell on both sides.
      if (surface?.kind === 'block' && !surface.pillar) n -= 10;
      else if (!surface && !prop && !layer.behaviors.has(index)) n -= 10;
      else if (!surface) n += prop ? 70 : 10;
      if (prop && !definitions[prop]?.complete) n += 1000;
      return n;
    };
    const best = candidates.filter((c) => inside(c.x, c.y)).sort((a, b) => score(a) - score(b) || a.y - b.y || a.x - b.x)[0];
    if (best) {
      at(best.y * layer.width + best.x).walls[best.edge] = { height: wall.height, tile: wall.tile };
      owners?.set(wallKey(wall.x0, wall.y0, wall.x1, wall.y1), best.y * layer.width + best.x);
    }
  }
  return overlays;
}

/**
 * Which half of a diagonal cell is solid. When the cell holds exactly one
 * half of a matching split floor, the missing half is the solid one.
 * Side 0 blocks the NE half of "\" and the SE half of "/".
 */
function diagonalSide(layer: ProjectLayer, index: number, family: 0 | 1, wall: Wall): 0 | 1 {
  const surface = layer.surfaces.get(index);
  if (surface?.kind === 'split' && surface.diagonal === (family === 0 ? 'nw-se' : 'ne-sw')) {
    const present = Object.keys(surface.halves);
    if (present.length === 1) return present[0] === (family === 0 ? 'ne' : 'se') ? 1 : 0;
  }
  return wall.side;
}

/* --------------------------------------------------------------- behavior */

/**
 * Which way each door's partner lies (the sequence pair byte): a door pairs
 * with an adjacent door of the same lock, east or south first, each door with
 * at most one other.
 */
function doorPairs(layer: ProjectLayer): Map<number, number> {
  const pairs = new Map<number, number>();
  const doorAt = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) return null;
    const b = layer.behaviors.get(y * layer.width + x);
    return b?.kind === 'door' ? b : null;
  };
  for (const [index, b] of [...layer.behaviors].sort((p, q) => p[0] - q[0])) {
    if (b.kind !== 'door' || pairs.has(index)) continue;
    const x = index % layer.width;
    const y = Math.floor(index / layer.width);
    // A north-south door's panel runs east-west: its partner is east of it; an east-west door's, south.
    const [dx, dy, here, there] = b.facing === 'ns' ? [1, 0, 1, 2] : [0, 1, 8, 4];
    const other = doorAt(x + dx, y + dy);
    const otherIndex = (y + dy) * layer.width + x + dx;
    if (other && other.lock === b.lock && other.facing === b.facing && !pairs.has(otherIndex)) {
      pairs.set(index, here);
      pairs.set(otherIndex, there);
    }
  }
  return pairs;
}

/**
 * A door panel, a quarter cell thick across the middle of the cell, `step`
 * eighths of the way open (0 = shut). Its footprint is the retail door mask
 * (0x0FF0 for a panel running east-west, 0x6666 north-south).
 *   - 'sink': the panel is 8 - step eighths tall. Two eighths or less no
 *     longer blocks, as the retail doors let the player through before they
 *     are quite gone.
 *   - 'slide': the panel 8 - step eighths long, drawn back into the side away
 *     from its partner (`pair`: 1 west, 2 east, 8 north, 4 south; a door on
 *     its own goes west or north), as in HOSP0. Its footprint, the quarters
 *     the panel still covers, is HOSP0's mask step for step. The texture moves
 *     with the panel.
 *   - 'rise': a full-height panel lifted `step` eighths, up past the ceiling,
 *     as in ALIEN1 (top 256, 288 ... 480 units). It blocks until the last
 *     step, as there. The tile is fitted to the panel so it moves with it.
 */
/** A shut door's panel on its own, for previews. */
export function doorPanelDefinition(tile: number, facing: 'ns' | 'ew', style: DoorStyle): CellDefinition {
  return buildPropDefinition(doorPanel(tile, facing, 0, style, 0));
}

function doorPanel(tile: number, facing: 'ns' | 'ew', step: number, style: DoorStyle, pair: number): PropModel {
  const m = createPropModel(0, 0, 'door', tile);
  const across = { x: facing === 'ns' ? 0 : 6, y: facing === 'ns' ? 6 : 0, w: facing === 'ns' ? PROP_STEPS : 4, d: facing === 'ns' ? 4 : PROP_STEPS, turn: 0 as const, tile };
  if (style === 'slide') {
    const length = (DOOR_STEPS - step) * 2;
    const toEnd = pair === 2 || pair === 4;
    const start = toEnd ? PROP_STEPS - length : 0;
    // The part of the panel still showing is its leading end, so its texture is shifted back by how far it has gone.
    const gone = step * 2 * PROP_STEP_UNITS * (toEnd ? -1 : 1);
    if (length > 0) m.parts.push({ shape: 'box', ...across, ...(facing === 'ns' ? { x: start, w: length } : { y: start, d: length }), z: 0, h: PROP_STEPS });
    m.textureShift = facing === 'ns' ? [gone, 0, 0] : [0, gone, 0];
  } else if (style === 'rise') {
    m.parts.push({ shape: 'box', ...across, z: step * 2, h: PROP_STEPS });
    m.mapping = 'stretch';
    m.collision = step < DOOR_STEPS - 1 ? 'footprint' : 'none';
  } else {
    const height = DOOR_STEPS - step;
    if (height > 0) m.parts.push({ shape: 'box', ...across, z: 0, h: height * 2 });
    if (height <= 2) m.collision = 'none';
  }
  return m;
}

function applyBehavior(meta: Uint8Array, behavior: Exclude<CellBehaviorSpec, { kind: 'breakable' } | { kind: 'door' }>): Uint8Array {
  switch (behavior.kind) {
    case 'teleporter':
      return withTeleporter(meta, behavior);
    case 'exit':
      return withExit(meta);
    case 'hazard':
      return withHazard(meta, behavior.damage);
    default:
      return stripBehavior(meta);
  }
}

/* ------------------------------------------------------------------ main */

/**
 * Composes cell definitions for a project's layers. The compiler uses one per
 * build; the editor keeps one alive to turn edits into preview geometry with
 * exactly the same rules (pass `preview` to lift the engine's size limits so
 * a session can accumulate stale definitions without failing).
 */
export class ProjectComposer {
  readonly definitions: CellDefinition[];
  private readonly bank: CompileTileBank;
  private readonly cache = new Map<string, number>();
  private readonly libraryCount: number;

  constructor(
    private readonly project: MapProject,
    private readonly options: CompileOptions & { preview?: boolean } = {},
  ) {
    this.definitions = project.definitions.slice();
    this.libraryCount = project.definitions.length;
    this.bank = new CompileTileBank(project.tiles, options.opaqueZeroIndex ?? 255, options.preview ? Infinity : MAX_TILES);
    // Props modeled in the Workshop are rebuilt here so their textures can be baked to scale.
    for (const model of project.models) {
      if (model.definitionId > 0 && model.definitionId < this.definitions.length) this.definitions[model.definitionId] = buildPropDefinition(model, this.bank.masked);
    }
  }

  /** Project tiles followed by any generated cut tiles. */
  get tiles(): readonly Uint8Array[] {
    return this.bank.tiles;
  }
  get generatedTiles(): number {
    return this.bank.generated;
  }

  /** The ID of definition `id` with tile `tile` on `faces` (added once). */
  retextured(id: number, tile: number, faces: TriggerFaces): number {
    return this.intern(`retex:${id}:${tile}:${faces}`, () => retextureDefinition(this.definitions[id], tile, faces));
  }

  private intern(key: string, make: () => CellDefinition): number {
    let id = this.cache.get(key);
    if (id === undefined) {
      if (!this.options.preview && this.definitions.length >= MAX_DEFINITIONS) {
        throw new CompileError([{ level: 'error', message: `The map needs more than ${MAX_DEFINITIONS} distinct cell definitions. Reuse materials and wall heights to bring the count down.` }]);
      }
      id = this.definitions.length;
      this.definitions.push(make());
      this.cache.set(key, id);
    }
    return id;
  }

  /**
   * A door's chain on top of the cell `open` (its floor and walls): the panel
   * at full height, then lower by an eighth each step, then the open cell,
   * which ends the sequence. Chains are not shared between doors with a
   * different lock or partner: the engine copies the first definition's lock
   * and partner bytes into the rest of its chain.
   */
  private composeDoor(openId: number, openKey: string, door: { lock: number; tile: number; facing: 'ns' | 'ew'; style?: DoorStyle }, pair: number): number {
    const style = door.style ?? 'sink';
    const tag = `${openKey}|${door.lock}:${pair}:${door.facing}:${door.tile}:${style}`;
    let next = openId;
    for (let k = DOOR_STEPS - 1; k >= 0; k--) {
      const after = next;
      next = this.intern(`door:${tag}:${k}`, () => {
        const panel = buildPropDefinition(doorPanel(door.tile, door.facing, k, style, pair), this.bank.masked);
        const merged = mergeDefinitions(this.definitions[openId], [panel]);
        return { ...merged, meta: withSequence(merged.meta, after, door.lock, pair) };
      });
    }
    return next;
  }

  /** Omit only faces buried in static, opaque full blocks. Dynamic neighbors
   * keep every face so destroying or replacing them cannot expose a hole. */
  private exposedSurface(layer: ProjectLayer, index: number, source: ProjectLayer): CellSpec['surface'] {
    const surface = layer.surfaces.get(index) ?? null;
    if (surface?.kind !== 'block' || blockWidth(surface) !== 1 || layer.behaviors.has(index)) return surface;
    const area = this.project.groups.find((g) => g.layers.includes(source));
    const dynamic = (l: ProjectLayer, i: number) => l.behaviors.has(i) || this.project.triggers.some((t) => t.actions.some((a) =>
      a.kind !== 'effect' && a.kind !== 'reveal' && this.project.groups[a.group]?.layers[a.layer] === (l === layer ? source : l) && a.x === i % l.width && a.y === Math.floor(i / l.width)));
    const opaque = (l: ProjectLayer, x: number, y: number, height: number) => {
      if (x < 0 || y < 0 || x >= l.width || y >= l.height) return false;
      const i = y * l.width + x, s = l.surfaces.get(i);
      return s?.kind === 'block' && blockWidth(s) === 1 && s.height >= height && !dynamic(l, i) &&
        s.topTile !== null && !(s.topTile & (TEXTURE_MASKED | TEXTURE_ADDITIVE)) &&
        (['north', 'east', 'south', 'west'] as const).every((e) => s.sides[e] !== undefined && !(s.sides[e]! & (TEXTURE_MASKED | TEXTURE_ADDITIVE)));
    };
    if (dynamic(layer, index)) return surface;
    const x = index % layer.width, y = Math.floor(index / layer.width);
    const sides = { ...surface.sides };
    for (const [edge, dx, dy] of [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]] as const) {
      if (opaque(layer, x + dx, y + dy, surface.height)) delete sides[edge];
    }
    const above = area?.layers[area.layers.indexOf(source) + 1];
    const covered = surface.height === 1 && above && opaque(above, x + layer.originX - above.originX, y + layer.originY - above.originY, 1);
    return { ...surface, sides, topTile: covered ? null : surface.topTile };
  }

  /** Final cell words for a layer: one definition ID per cell. Cells naming a missing prop are reported through `onMissingProp`. */
  composeLayer(layer: ProjectLayer, onMissingProp?: (x: number, y: number, prop: number) => void): Uint16Array {
    const { definitions } = this;
    const sourceLayer = layer;
    const group = this.project.groups.find((g) => g.layers.includes(layer));
    if (group) layer = withLayerConnections(layer, group.layers[group.layers.indexOf(layer) - 1]);
    const overlays = rasteriseWalls(layer, definitions);
    const pairs = doorPairs(layer);
    const cells = new Uint16Array(layer.cells.length);
    for (let index = 0; index < cells.length; index++) {
      const prop = layer.cells[index] & DEFINITION_MASK;
      const surface = this.exposedSurface(layer, index, sourceLayer);
      const overlay = overlays.get(index);
      const behavior = layer.behaviors.get(index);
      const stacked = layer.overlays.get(index);
      if (!prop && !surface && !overlay && !behavior && !stacked) continue;
      let id = 0;
      let key = '';
      if (surface) {
        const spec: CellSpec = { surface, walls: overlay?.walls ?? {}, diagonals: overlay?.diagonals ?? [] };
        key = `s:${specKey(spec)}`;
        const original = layer.surfaces.get(index);
        const outlineTop = original?.kind === 'block' && surface.kind === 'block' && original.topTile !== null && surface.topTile === null ? original : undefined;
        id = this.intern(key, () => composeDefinition(spec, this.bank.masked, outlineTop));
      } else if (prop) {
        if (prop >= this.libraryCount) {
          onMissingProp?.(index % layer.width, Math.floor(index / layer.width), prop);
          continue;
        }
        id = prop;
        key = `p:${prop}`;
        if (overlay) {
          const spec = { surface: null, walls: overlay.walls, diagonals: overlay.diagonals };
          key = `p:${prop}+${specKey(spec)}`;
          id = this.intern(key, () => overlayDefinition(definitions[prop], spec));
        }
      } else if (overlay) {
        const spec: CellSpec = { surface: null, walls: overlay.walls, diagonals: overlay.diagonals };
        key = `s:${specKey(spec)}`;
        id = this.intern(key, () => composeDefinition(spec, this.bank.masked));
      }
      if (behavior?.kind === 'breakable') {
        // What is left once the cell is destroyed: a plain floor, keeping any walls that stand on the cell's edges.
        const rubble: CellSpec = { surface: { kind: 'floor', tile: behavior.leaves, turn: 0 }, walls: overlay?.walls ?? {}, diagonals: overlay?.diagonals ?? [] };
        const rubbleId = this.intern(`s:${specKey(rubble)}`, () => composeDefinition(rubble, this.bank.masked));
        const baseId = id;
        // 'broken': the same cell, solid and all, with the broken tile on its upright faces.
        const replaceWith =
          behavior.result === 'broken' && behavior.broken !== undefined
            ? this.intern(`${key}~broken:${behavior.broken}`, () => ({ ...retextureDefinition(definitions[baseId], behavior.broken!, 'walls'), meta: stripBehavior(definitions[baseId].meta) }))
            : rubbleId;
        // Shots from robots count too; the effect plays at the cell's center, as most retail breakables do.
        id = this.intern(`${key}@${JSON.stringify(behavior)}`, () => ({ ...definitions[baseId], meta: withDestructible(definitions[baseId].meta, { replaceWith, toughness: behavior.toughness, effect: behavior.effect, centerEffect: true }) }));
      } else if (behavior?.kind === 'door') {
        // A door on an empty cell opens onto ground with nothing drawn: no floor of its own.
        if (!id) {
          key = 'ground';
          id = this.intern(key, () => ({ ...emptyDefinition(), meta: makeMeta(FLAG_GROUND) }));
        }
        id = this.composeDoor(id, key, behavior, pairs.get(index) ?? 0);
      } else if (behavior) {
        const baseId = id;
        id = this.intern(`${key}@${JSON.stringify(behavior)}`, () => ({ ...definitions[baseId], meta: applyBehavior(definitions[baseId].meta, behavior) }));
      }
      if (stacked?.props.length) {
        const props = stacked.props.filter((p) => {
          if (p > 0 && p < this.libraryCount) return true;
          onMissingProp?.(index % layer.width, Math.floor(index / layer.width), p);
          return false;
        });
        if (props.length) {
          // What the cell is without the props on top, behavior and all: it is also what a breakable stack leaves behind.
          const underId = id;
          const b = stacked.breakable;
          id = this.intern(`${behavior ? `${key}@${JSON.stringify(behavior)}` : key}+o:${props.join(',')}${b ? `!${b.toughness}:${b.effect}` : ''}`, () => {
            const merged = mergeDefinitions(definitions[underId], props.map((p) => definitions[p]));
            return b ? { ...merged, meta: withDestructible(merged.meta, { replaceWith: underId, toughness: b.toughness, effect: b.effect, centerEffect: true }) } : merged;
          });
        }
      }
      cells[index] = id | (layer.cells[index] & ~DEFINITION_MASK);
    }
    return cells;
  }
}

function composeProject(project: MapProject, options: CompileOptions, issues: Issue[]) {
  const composer = new ProjectComposer(project, options);
  const pathIndex = new Map(project.paths.map((p, i) => [p.id, i]));
  const sounds: CompiledSound[] = [];
  const effects: CompiledEffect[] = [];
  const friends: CompiledFriend[] = [];
  const map: GameMap = {
    groups: [],
    definitions: composer.definitions,
    paths: project.paths.map((p) => ({ word0: p.word0, flag: p.flag, group: p.group, layer: p.layer, points: p.points.map((pt) => ({ ...pt })) })),
    textureScrolls: project.textureScrolls,
    textureCycles: project.textureCycles,
  };
  project.groups.forEach((group, g) => {
    const layers = group.layers.map((layer, l) => {
      const cells = composer.composeLayer(layer, (x, y, prop) => issues.push({ level: 'error', message: `A cell uses prop ${prop}, which is not in the project library`, at: { group: g, layer: l, x, y } }));
      // An emitter playing one of the map's own sounds is handled by the runtime, not by a map object.
      for (const e of layer.entities) if (e.sound) sounds.push({ sound: e.sound.id, group: g, layer: l, x: layer.originX * 256 + e.x, y: layer.originY * 256 + e.y, delay: e.sound.delay, random: e.sound.random });
      // So is a placed custom effect. Layers are 0x100 apart, upwards being negative.
      for (const e of layer.entities) if (e.friendly && !e.sound && e.effect === undefined) friends.push({ group: g, layer: l, x: e.x, y: e.y, type: e.type, follow: e.friendly.follow });
      for (const e of layer.entities) if (e.effect !== undefined) effects.push({ effect: e.effect, group: g, layer: l, x: layer.originX * 256 + e.x, y: layer.originY * 256 + e.y, z: -l * 256 });
      const objects: MapObject[] = layer.entities.filter((e) => !e.sound && e.effect === undefined).map((e) => ({
        typeWord: makeTypeWord(e.type, e.behavior, e.weapon, e.bit8),
        x: e.x,
        y: e.y,
        pathIndex: e.pathId === null ? -1 : (pathIndex.get(e.pathId) ?? -1),
        flags: (e.disabled ? OBJECT_DISABLED : 0) | (e.flagsRest & ~OBJECT_DISABLED),
        poolIndex: e.id,
      }));
      return { width: layer.width, height: layer.height, originX: layer.originX, originY: layer.originY, cells, lighting: layer.lighting, objects };
    });
    map.groups.push({ layers });
  });
  // Triggers: cells to change get their changed definition now, while definitions can still be added.
  const triggers: CompiledTrigger[] = project.triggers.map((t) => ({
    channel: t.channel,
    once: t.once,
    actions: t.actions.flatMap((a): CompiledTriggerAction[] => {
      const layer = project.groups[a.group]?.layers[a.layer];
      const cells = map.groups[a.group]?.layers[a.layer]?.cells;
      if (!layer || !cells) return [];
      if (a.kind === 'break') return [{ kind: 'break', group: a.group, layer: a.layer, x: a.x, y: a.y }];
      if (a.kind === 'retexture') {
        const definition = composer.retextured(cells[a.y * layer.width + a.x] & DEFINITION_MASK, a.tile, a.faces);
        return [{ kind: 'cell', group: a.group, layer: a.layer, x: a.x, y: a.y, definition }];
      }
      if (a.kind === 'effect') return [{ kind: 'effect', group: a.group, x: layer.originX * 256 + a.x, y: layer.originY * 256 + a.y, z: a.layer * 256, effect: a.effect }];
      const e = layer.entities.find((x) => x.id === a.entity);
      return e ? [{ kind: 'reveal', group: a.group, layer: a.layer, x: e.x, y: e.y, type: e.type }] : [];
    }),
  }));
  return { map, composer, sounds, effects, friends, triggers };
}

function validateCustomTypes(project: MapProject, options: CompileOptions, add: (level: IssueLevel, message: string) => void): void {
  const types = project.customTypes;
  if (types.length > MAX_CUSTOM_TYPES) add('error', `A map can customize at most ${MAX_CUSTOM_TYPES} entity types (this one has ${types.length}).`);
  const seen = new Set<number>();
  const slots = new Set<number>();
  const allRecords = new Set<number>();
  for (const t of types) {
    const label = `The custom enemy "${t.name}"`;
    if (seen.has(t.type)) add('error', `Entity type ${t.type} is customized twice.`);
    seen.add(t.type);
    if (t.type <= 1 || (options.knownTypes && !options.knownTypes.has(t.type))) add('error', `${label} is based on type ${t.type}, which cannot be customized.`);
    if (t.health !== null && (!Number.isInteger(t.health) || t.health < 1 || t.health > CUSTOM_HEALTH_MAX)) add('error', `${label} needs a health from 1 to ${CUSTOM_HEALTH_MAX}.`);
    for (const [what, value] of [['speed', t.speed], ['fire rate', t.fireRate], ['damage', t.damage]] as const) {
      if (!Number.isInteger(value) || value < CUSTOM_PERCENT_MIN || value > CUSTOM_PERCENT_MAX) add('error', `${label} needs a ${what} from ${CUSTOM_PERCENT_MIN}% to ${CUSTOM_PERCENT_MAX}%.`);
    }
    const records = new Set<number>();
    if ((t.animations?.length ?? 0) > MAX_CUSTOM_ANIMATIONS) add('error', `${label} changes more than ${MAX_CUSTOM_ANIMATIONS} animations.`);
    for (const a of t.animations ?? []) {
      if (records.has(a.record) || allRecords.has(a.record)) add('error', `${label} changes an animation that is already changed.`);
      records.add(a.record);
      const ok = [a.base, a.span, a.start, a.ticks, a.mode].every((n) => Number.isInteger(n) && n >= 0) && a.span >= 1 && a.start < a.span && a.ticks >= 1 && a.ticks <= 255 && a.mode >= 1 && a.mode <= 6;
      if (!ok) add('error', `${label} has an animation with impossible numbers (frames ${a.base}+${a.span}, start ${a.start}, ${a.ticks} updates a frame).`);
    }
    for (const r of records) allRecords.add(r);
    if (t.sprite) {
      if (slots.has(t.sprite.slot)) add('error', `${label} replaces sprite slot ${t.sprite.slot}, which another custom enemy already replaces.`);
      slots.add(t.sprite.slot);
    }
  }
}

/** Problems that can be found without compiling. Cheap enough to run on every edit. */
export function validateProject(project: MapProject, options: CompileOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, message: string, at?: Issue['at']) => issues.push({ level, message, at });
  const levelIndex = LEVEL_IDS.indexOf(project.baseLevel as LevelId);
  if (levelIndex < 0) add('error', `Unknown base level "${project.baseLevel}"`);
  else if (levelIndex >= SINGLE_PLAYER_LEVEL_COUNT) add('error', 'Deathmatch arenas cannot be used as a base level: the game has no single-player route into them.');
  if (project.tiles.length > MAX_TILES) add('error', `The map has ${project.tiles.length} tiles; the limit is ${MAX_TILES}.`);
  if (!project.groups.length) add('error', 'The map has no areas.');
  const trackedDoors = project.groups.reduce((count, g) => count + g.layers.reduce((n, l) => n + [...l.behaviors.values()].filter((b) => b.kind === 'door').length, 0), 0);
  if (trackedDoors > 64) add('error', `The map has ${trackedDoors} doors; the runtime supports at most 64.`);
  if (project.groups.length > MAX_GROUPS) add('error', `The engine supports at most ${MAX_GROUPS} separate areas (this map has ${project.groups.length}).`);
  if (project.initialGroup < 0 || project.initialGroup >= project.groups.length) add('error', 'The starting area does not exist.');
  validateCustomTypes(project, options, add);
  for (const f of project.effects) {
    if (!f.particles.length || f.particles.length > MAX_EFFECT_PARTICLES) add('error', `The effect "${f.name}" needs one to ${MAX_EFFECT_PARTICLES} particles.`);
    if (!Number.isInteger(f.every) || f.every < 1 || f.every > 255) add('error', `The effect "${f.name}" needs a rate of 1 to 255 updates.`);
    for (const p of f.particles) if (!Number.isInteger(p.fx) || p.fx < 1 || p.fx >= EFFECT_ID_COUNT || p.spread < 0 || p.spread > 1024) add('error', `The effect "${f.name}" has a particle the game does not have.`);
  }
  let placedEffects = 0;
  let friendCount = 0;

  let exits = 0;
  /** Doors locked to a switch or a key, and the switches in the map, for the checks after the loop. */
  const doorLocks = new Map<number, Issue['at']>();
  const keyLocks = new Map<number, Issue['at']>();
  const switches = new Set<number>();
  project.groups.forEach((group, g) => {
    if (!group.layers.length) add('error', `Area "${group.name}" has no layers.`);
    group.layers.forEach((layer, l) => {
      const where = (x: number, y: number) => ({ group: g, layer: l, x, y });
      for (const e of layer.entities) {
        const cx = e.x >> 8;
        const cy = e.y >> 8;
        if (e.x < 0 || e.y < 0 || cx >= layer.width || cy >= layer.height) add('error', `An entity (type ${e.type}) lies outside its layer.`, where(cx, cy));
        if (options.knownTypes && !options.knownTypes.has(e.type)) add('error', `Entity type ${e.type} has no engine descriptor and would crash the game.`, where(cx, cy));
        if (e.pathId !== null && !project.paths.some((p) => p.id === e.pathId)) add('error', 'An entity follows a path that no longer exists.', where(cx, cy));
        if (e.sound && !project.sounds.some((s) => s.id === e.sound!.id)) add('error', 'A sound emitter plays a sound that is no longer in the map.', where(cx, cy));
        if (e.effect !== undefined && !project.effects.some((f) => f.id === e.effect)) add('error', 'A placed effect is no longer in the map.', where(cx, cy));
        if (e.effect !== undefined) placedEffects++;
        if (e.friendly) {
          friendCount++;
          if (e.type <= 1) add('error', 'The player start cannot be a friendly character.', where(cx, cy));
          else if (e.friendly.follow && e.pathId === null) add('warning', 'A friend that follows the player needs a route to walk; without one it stays put.', where(cx, cy));
          if (layer.entities.some((o) => o !== e && o.type === e.type && o.x === e.x && o.y === e.y)) add('error', 'A friendly character shares its exact spot with another of its kind; move one of them.', where(cx, cy));
        }
      }
      const checkTile = (word: number | null, x: number, y: number) => {
        if (word !== null && (word & TEXTURE_INDEX_MASK) >= project.tiles.length) add('error', `A surface uses tile ${word & TEXTURE_INDEX_MASK}, which is not in the terrain bank.`, where(x, y));
      };
      for (const [index, s] of layer.surfaces) {
        const x = index % layer.width;
        const y = Math.floor(index / layer.width);
        if (s.kind === 'floor') checkTile(s.tile, x, y);
        else if (s.kind === 'ramp') {
          if (s.half === 'upper') {
            const above = group.layers[l + 1];
            if (!above) add('warning', 'This ramp has no layer above it to climb onto.', where(x, y));
            else {
              const ax = x + layer.originX - above.originX;
              const ay = y + layer.originY - above.originY;
              if (ax < 0 || ay < 0 || ax >= above.width || ay >= above.height) add('warning', 'The layer above does not cover the top of this ramp.', where(x, y));
              else {
                const index = ay * above.width + ax;
                const top = above.surfaces.get(index);
                if (above.cells[index] || (top && top.kind !== 'floor' && top.kind !== 'landing')) add('error', 'The ramp transition is blocked by scenery on the layer above. Clear the cell directly above the upper ramp.', where(x, y));
                const step = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] }[s.direction];
                const ex = ax + step[0], ey = ay + step[1];
                if (ex < 0 || ey < 0 || ex >= above.width || ey >= above.height || (!above.cells[ey * above.width + ex] && !withLayerConnections(above, layer).surfaces.has(ey * above.width + ex))) add('warning', 'There is no upper-floor cell beyond the top of this ramp; the player can fall back down. Add a floor beyond the ramp.', where(x, y));
              }
            }
          }
          checkTile(s.tile, x, y);
          for (const tile of Object.values(s.sides)) checkTile(tile ?? null, x, y);
        } else if (s.kind === 'block') {
          checkTile(s.topTile, x, y);
          checkTile(s.floorTile, x, y);
          for (const tile of Object.values(s.sides)) checkTile(tile ?? null, x, y);
        } else if (s.kind === 'split') for (const half of Object.values(s.halves)) checkTile(half!.tile, x, y);
      }
      for (const w of layer.walls.values()) checkTile(w.tile, Math.min(w.x0, w.x1), Math.min(w.y0, w.y1));
      for (const [index, b] of layer.behaviors) {
        const x = index % layer.width;
        const y = Math.floor(index / layer.width);
        if (b.kind === 'exit') exits++;
        if (b.kind === 'breakable') checkTile(b.leaves, x, y);
        if (b.kind === 'door') {
          const under = layer.surfaces.get(index)?.kind;
          if (under === 'block' || under === 'ramp' || under === 'landing') add('error', `A door cannot stand on a ${under === 'block' ? 'block' : 'ramp'}.`, where(x, y));
          if (!Number.isInteger(b.lock) || b.lock < 0 || b.lock > SWITCH_CHANNEL_LAST) add('error', 'A door has a lock the game does not have.', where(x, y));
          else if (b.lock >= SWITCH_CHANNEL_FIRST) doorLocks.set(b.lock, where(x, y));
          else if (b.lock >= 1) keyLocks.set(b.lock, where(x, y));
        }
        if (b.kind === 'switch') {
          if (!Number.isInteger(b.channel) || b.channel < SWITCH_CHANNEL_FIRST || b.channel > SWITCH_CHANNEL_LAST) add('error', 'A switch has a channel the game does not have.', where(x, y));
          switches.add(b.channel);
        }
        if (b.kind !== 'teleporter') continue;
        const target = project.groups[b.group]?.layers[b.layer];
        if (!target || b.x < 0 || b.y < 0 || b.x >= target.width || b.y >= target.height) add('error', 'A teleporter leads outside the map.', where(x, y));
      }
      for (const word of layer.cells) if (definitionClass(project.definitions[word & DEFINITION_MASK]?.meta ?? new Uint8Array(8)) === CLASS_EXIT) exits++;
    });
  });

  for (const [lock, at] of doorLocks) if (!switches.has(lock)) add('warning', 'A door opens with a switch, but no switch in the map opens it.', at);
  for (const [key, at] of keyLocks) {
    const type = KEY_PICKUP_TYPES[key - 1];
    if (!project.groups.some((g) => g.layers.some((l) => l.entities.some((e) => e.type === type)))) add('warning', `A door needs key ${key}, but the map has no key ${key} to pick up.`, at);
  }

  for (const path of project.paths) {
    const at = path.group >= 0 && path.points.length ? { group: path.group, layer: Math.max(0, path.layer), x: path.points[0].x >> 8, y: path.points[0].y >> 8 } : undefined;
    // The engine reads three points of a zone. Retail levels hold a few zone records with other counts
    // (seemingly unused), so this is advice, not a failure.
    if (path.word0 === PATH_ZONE && path.points.length !== 3) add('warning', 'A wander zone needs three points; drag its rectangle again.', at);
    else if (path.points.length < 2) add('warning', 'A path with fewer than two points does nothing.', at);
  }
  // Triggers: one per channel, each with a pad, acting on places that exist.
  const pads = new Set<number>();
  project.groups.forEach((g) => g.layers.forEach((l) => l.behaviors.forEach((b) => b.kind === 'switch' && pads.add(b.channel))));
  const channels = new Set<number>();
  for (const t of project.triggers) {
    const label = `The trigger "${t.name}"`;
    if (t.channel < SWITCH_CHANNEL_FIRST || t.channel > SWITCH_CHANNEL_LAST) add('error', `${label} has a channel the game does not have.`);
    if (channels.has(t.channel)) add('error', `Two triggers share channel ${t.channel}.`);
    channels.add(t.channel);
    if (!pads.has(t.channel) && t.actions.length) add('warning', `${label} has no pad to step on, so it never fires.`);
    for (const a of t.actions) {
      const layer = project.groups[a.group]?.layers[a.layer];
      const at = { group: a.group, layer: a.layer, x: 'x' in a ? (a.kind === 'effect' ? a.x >> 8 : a.x) : 0, y: 'y' in a ? (a.kind === 'effect' ? a.y >> 8 : a.y) : 0 };
      if (!layer) {
        add('error', `${label} acts on a layer that is not in the map.`);
        continue;
      }
      if (a.kind === 'break') {
        const index = a.y * layer.width + a.x;
        if (layer.behaviors.get(index)?.kind !== 'breakable' && !layer.overlays.get(index)?.breakable) add('warning', `${label} breaks a cell that is not breakable, so nothing happens there.`, at);
      } else if (a.kind === 'retexture') {
        if (a.x >= layer.width || a.y >= layer.height) add('error', `${label} changes a cell outside its layer.`, at);
      } else if (a.kind === 'effect') {
        if (!project.effects.some((f) => f.id === a.effect)) add('error', `${label} plays an effect that is not in the map.`, at);
      } else {
        const e = layer.entities.find((x) => x.id === a.entity);
        if (!e) add('error', `${label} reveals an entity that is no longer in the map.`);
        else if (!e.disabled) add('warning', `${label} reveals an entity that is already there: set it to start disabled.`, { group: a.group, layer: a.layer, x: e.x >> 8, y: e.y >> 8 });
      }
    }
  }

  for (const model of project.models) {
    const definition = project.definitions[model.definitionId];
    const faces = definition?.commands.length ?? 0;
    const vertices = (definition?.vertices.length ?? 0) / 3;
    if (vertices > PROP_MAX_VERTICES) add('error', `The prop "${model.name}" has ${vertices} corners; the game handles about ${PROP_MAX_VERTICES} in one cell. Remove some parts.`);
    else if (faces > PROP_FACE_WARNING) add('warning', `The prop "${model.name}" has ${faces} faces. Many copies on screen can make the game skip drawing some.`);
  }

  const starts = project.groups[project.initialGroup]?.layers.flatMap((l) => l.entities.filter((e) => e.type === 1 && !e.disabled)) ?? [];
  if (!starts.length) add('error', 'The starting area needs a player start.');
  else if (starts.length > 1) add('warning', 'The starting area has more than one player start; the game picks one.');
  if (!exits) add('info', 'The map has no exit cells, so it can only be left from the pause menu.');
  if (friendCount > MAX_FRIENDS) add('error', `The map has ${friendCount} friendly characters; the game looks after at most ${MAX_FRIENDS}.`);
  if (placedEffects > MAX_EFFECT_EMITTERS) add('error', `The map places ${placedEffects} effects; the game runs at most ${MAX_EFFECT_EMITTERS}.`);
  if (project.briefing.mode === 'custom') {
    if (project.briefing.text.length > 2000) add('error', 'The briefing text is longer than the 2,000 characters the game can hold.');
    if (project.briefing.title.length > 120) add('error', 'The briefing title is longer than 120 characters.');
    if (/[^\x20-\x7e\n]/.test(project.briefing.text + project.briefing.title)) add('warning', 'The briefing contains characters the game font may not have; stick to plain capitals, digits and basic punctuation.');
  }
  return issues;
}

/** Compile a project. Throws `CompileError` when the result would not be loadable. */
export function compileProject(project: MapProject, options: CompileOptions = {}): CompiledMap {
  const issues = validateProject(project, options);
  if (issues.some((i) => i.level === 'error')) throw new CompileError(issues);
  const { map, composer, sounds, effects, friends, triggers } = composeProject(project, options, issues);
  const bank = { tiles: composer.tiles, generated: composer.generatedTiles };
  if (issues.some((i) => i.level === 'error')) throw new CompileError(issues);

  // Every textured face must name a tile that exists once cut tiles are added.
  for (const def of map.definitions) {
    for (const c of def.commands) {
      if (TEXTURED_OPS.has(c.op) && ((c.texture ?? 0) & TEXTURE_INDEX_MASK) >= bank.tiles.length) {
        throw new CompileError([...issues, { level: 'error', message: `A prop uses tile ${(c.texture ?? 0) & TEXTURE_INDEX_MASK}, which is not in the terrain bank (${bank.tiles.length} tiles).` }]);
      }
    }
  }
  // Teleporters authored on props: check their destinations too.
  map.groups.forEach((group, g) =>
    group.layers.forEach((layer, l) => {
      layer.cells.forEach((word, index) => {
        const meta = map.definitions[word & DEFINITION_MASK].meta;
        if (definitionClass(meta) !== CLASS_TELEPORTER) return;
        const b = decodeBehavior(meta);
        if (b.kind !== 'teleporter') return;
        const target = map.groups[b.group]?.layers[b.layer];
        if (!target || b.x >= target.width || b.y >= target.height) issues.push({ level: 'warning', message: 'A teleporter cell points outside the map.', at: { group: g, layer: l, x: index % layer.width, y: Math.floor(index / layer.width) } });
      });
    }),
  );

  let mapBytes: Uint8Array;
  let lmpBytes: Uint8Array;
  try {
    const written = writeMap(map);
    mapBytes = written.bytes;
    lmpBytes = writeLmp(map.definitions);
    if (written.unresolvedObjectReferences.length) issues.push({ level: 'warning', message: `${written.unresolvedObjectReferences.length} trigger cell(s) refer to objects that are not in the map.` });
  } catch (e) {
    throw new CompileError([...issues, { level: 'error', message: (e as Error).message }]);
  }
  if (bank.tiles.length > RETAIL_MAX_TILES) issues.push({ level: 'info', message: `The map uses ${bank.tiles.length} tiles. The original game holds ${RETAIL_MAX_TILES}; the Workshop runtime lifts that to ${MAX_TILES}, so this map needs it (it is installed with the Workshop).` });
  const terrainChanged = bank.tiles.length !== project.baseTileCount || project.tilesEdited === true;
  return {
    map,
    mapBytes,
    lmpBytes,
    terrainBytes: terrainChanged ? encodeTerrainBank(bank.tiles) : null,
    sounds,
    effects,
    friends,
    triggers,
    issues,
    stats: {
      definitions: map.definitions.length,
      objects: map.groups.reduce((n, g) => n + g.layers.reduce((m, l) => m + l.objects.length, 0), 0),
      tiles: bank.tiles.length,
      generatedTiles: bank.generated,
      mapBytes: mapBytes.length,
      lmpBytes: lmpBytes.length,
    },
  };
}
