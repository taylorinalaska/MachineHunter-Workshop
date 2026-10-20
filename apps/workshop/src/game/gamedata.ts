/**
 * Everything the Workshop knows about the user's copy of the game, decoded
 * on demand from DATA.ARC and the retail executable.
 */
import {
  type ActorDescriptor,
  type AnimationSource,
  Archive,
  type BodyFormAnimations,
  type CellDefinition,
  DEFINITION_MASK,
  type GameMap,
  LEVEL_IDS,
  type LevelId,
  LevelPalette,
  type LevelRecord,
  PeImage,
  type RetailBriefing,
  SINGLE_PLAYER_LEVEL_COUNT,
  type SoundEffect,
  type SpriteFrame,
  decodeSprites,
  decodeTerrainBank,
  formDescriptorVa,
  nearestIndex,
  objectBehavior,
  objectMapType,
  parseMap,
  readBodyFormAnimations,
  readBriefings,
  readDescriptor,
  readEntityType,
  readLevelTable,
  readSoundEffects,
  scanAnimationSources,
  spriteSide,
} from '@mh/core';
import bestiaryJson from '../../../../gamedata/bestiary.json';
import { api } from './api.ts';

/* ------------------------------------------------------------ bestiary */

export type EntityCategory = 'player' | 'robot' | 'creature' | 'human' | 'vehicle' | 'turret' | 'boss' | 'pickup' | 'objective' | 'effect' | 'marker' | 'decor';

export interface BestiaryEntity {
  type: number;
  name: string;
  nameSource: string;
  category: EntityCategory;
  form: number | null;
  sprite: string | null;
  spriteFrame: number | null;
  placements: number;
  maps: { level: string; count: number }[];
  behaviors: { selector: number; placements: number; pathLinked: number; weapons: number[]; note: string }[];
  pickup: { effect: string; operation: string; limit: string; eligibility: string; accessChannel: number | null } | null;
  emitter: { effects: string; cadence: string; notes: string } | null;
}

export interface BodyForm {
  form: number;
  name: string;
  maker: string;
  model: string;
  robotClass: string;
  weapon: string;
  brain: string;
  role: string;
  maxHealth: number;
  radius: number;
  linearAcceleration: number;
  forwardSpeedCap: number;
  reverseSpeedCap: number;
  turnSpeedCap: number;
  fireInterval: number[];
  energyCost: number[];
  projectiles: { powerLevel: number; variant: string; speed: number; radius: number; damage: number; behavior: string }[];
}

interface Bestiary {
  forms: BodyForm[];
  entities: BestiaryEntity[];
  robotBehaviorNotes: Record<string, string>;
  difficulty: { playerDamage: number[]; incomingDamage: number[] };
  ambientSounds: { level_index: number; map: string; selector: number; mode: number; sound_id: number; sample_name: string | null; base_delay: number; random_range: number; type39_retail_uses: number }[];
  campaign: { mission: number; title: string; level: string }[];
}

export const bestiary = bestiaryJson as unknown as Bestiary;

export const CATEGORY_LABELS: Record<EntityCategory, string> = {
  player: 'Player',
  robot: 'Robots',
  creature: 'Creatures',
  human: 'Humanoids',
  vehicle: 'Vehicles',
  turret: 'Turrets',
  boss: 'Bosses',
  pickup: 'Pickups',
  objective: 'Objectives',
  effect: 'Effects',
  marker: 'Markers',
  decor: 'Scenery',
};

/** Friendly names for the levels, from the manual's mission list. */
export const LEVEL_TITLES: Record<string, string> = Object.fromEntries([
  ...bestiary.campaign.map((c) => [c.level, c.title] as const),
  ['BOSS3MAP', 'Final Boss'],
  ['DMMARS1', 'Deathmatch: Excavations'],
  ['DMMILIT1', 'Deathmatch: Compound'],
  ['DMBARR1', 'Deathmatch: Barracks'],
  ['DMALIEN1', 'Deathmatch: Alien City'],
  ['DMLABS1', 'Deathmatch: Labs'],
  ['DMSWAMP1', 'Deathmatch: Swamp'],
  ['DMSEWER1', 'Deathmatch: Sewers'],
  ['DMASTER1', 'Deathmatch: Asteroid'],
]);

/* ---------------------------------------------------------- level assets */

export interface LevelAssets {
  record: LevelRecord;
  palette: LevelPalette;
  tiles: Uint8Array[];
  /** Sprite container name loaded into each runtime slot for this level. */
  slots: Map<number, string>;
  /** A source index that looks like index 0 but is opaque; used when cutting tiles. */
  opaqueZeroIndex: number;
}

export interface EntityInfo extends BestiaryEntity {
  descriptor: ActorDescriptor | null;
  facingPolicy: number;
}

/** The scenery cell an entity always stands on in a level, and where on it. */
export interface EntityBase {
  /** Definition ID in the level's retail map. */
  definitionId: number;
  definition: CellDefinition;
  /** Position of the entity inside the cell, 1/256 cell. */
  offsetX: number;
  offsetY: number;
}

/** How the retail levels place an entity type, by behavior number. */
export interface PathHabits {
  /** Placements following a route (a list of points walked in order). */
  route: Map<number, number>;
  /** Placements given a wander zone. */
  zone: Map<number, number>;
  /** Placements with no path. */
  none: Map<number, number>;
}

export type AmbientProfile = Bestiary['ambientSounds'][number];

/**
 * Sprite containers a map replaces, by runtime slot (its custom enemies), for
 * drawing that map's entities. `key` must change whenever any of them does.
 */
export interface SlotLooks {
  key: string;
  slots: ReadonlyMap<number, SpriteFrame[]>;
}

/** Container names that stand for a map's replacement frames. */
const LOOK_PREFIX = '@look:';

/** Side of the canvas entity pictures and animation previews are composed on. */
export const SPRITE_STAGE = 64;

export class GameData {
  readonly levels: LevelRecord[];
  readonly briefings: RetailBriefing[];
  readonly sounds: SoundEffect[];
  readonly formAnimations: BodyFormAnimations[];
  readonly entities: EntityInfo[];
  private readonly entityByType = new Map<number, EntityInfo>();
  private readonly levelCache = new Map<string, LevelAssets>();
  private readonly spriteCache = new Map<string, SpriteFrame[]>();
  private readonly mapCache = new Map<string, GameMap>();
  private readonly imageCache = new Map<string, HTMLCanvasElement | null>();
  private readonly baseCache = new Map<string, EntityBase | null>();
  private scannedAnimations: AnimationSource[] | null = null;
  private habits: Map<number, PathHabits> | null = null;
  private slotContainers: Map<number, Set<string>> | null = null;

  constructor(
    readonly archive: Archive,
    readonly exe: PeImage,
  ) {
    this.levels = readLevelTable(exe);
    this.briefings = readBriefings(exe);
    this.sounds = readSoundEffects(exe);
    this.formAnimations = readBodyFormAnimations(exe);
    this.entities = bestiary.entities.map((e) => {
      const record = readEntityType(exe, e.type);
      // The player start has no descriptor of its own: the player spawns as form 1.
      const descriptor = record.descriptor ?? (e.form ? readDescriptor(exe, formDescriptorVa(e.form)) : null);
      return { ...e, descriptor, facingPolicy: record.facingPolicy };
    });
    for (const e of this.entities) this.entityByType.set(e.type, e);
  }

  static async load(onProgress?: (message: string) => void): Promise<GameData> {
    onProgress?.('Reading DATA.ARC…');
    const archiveBytes = await api.archive();
    onProgress?.('Reading the game executable…');
    const exeBytes = await api.retailExe();
    return new GameData(new Archive(archiveBytes), new PeImage(exeBytes));
  }

  entity(type: number): EntityInfo | undefined {
    return this.entityByType.get(type);
  }

  get knownTypes(): ReadonlySet<number> {
    return new Set(this.entityByType.keys());
  }

  levelRecord(id: string): LevelRecord {
    const record = this.levels[LEVEL_IDS.indexOf(id as LevelId)];
    if (!record) throw new Error(`Unknown level ${id}`);
    return record;
  }

  get singlePlayerLevels(): LevelRecord[] {
    return this.levels.slice(0, SINGLE_PLAYER_LEVEL_COUNT);
  }

  level(id: string): LevelAssets {
    let assets = this.levelCache.get(id);
    if (!assets) {
      const record = this.levelRecord(id);
      const r = record.resources;
      const palette = new LevelPalette(this.archive.read(r.plt), this.archive.read(r.brt), this.archive.read(r.rmp));
      const slots = new Map<number, string>();
      for (const s of record.sprites) slots.set(s.slot, this.archive.entries[s.archiveId].name);
      // Pick the opaque stand-in for index 0: the closest displayed color among indices 1..255.
      const shown = palette.rgbaTable();
      const candidates = new Uint8Array(768);
      for (let i = 0; i < 256; i++) candidates.set(shown.subarray(i * 4, i * 4 + 3), i * 3);
      candidates.set([255, 0, 255], 0); // exclude index 0 itself
      let opaqueZeroIndex = nearestIndex(candidates, shown[0], shown[1], shown[2]);
      if (opaqueZeroIndex === 0) opaqueZeroIndex = 255;
      assets = { record, palette, tiles: decodeTerrainBank(this.archive.read(r.terrain)), slots, opaqueZeroIndex };
      this.levelCache.set(id, assets);
    }
    return assets;
  }

  /** The parsed retail map of a level (with automap profiles). */
  levelMap(id: string): GameMap {
    let map = this.mapCache.get(id);
    if (!map) {
      const r = this.levelRecord(id).resources;
      map = parseMap(this.archive.read(r.map), { lmp: this.archive.read(r.lmp) });
      this.mapCache.set(id, map);
    }
    return map;
  }

  sprites(container: string): SpriteFrame[] {
    const key = container.toUpperCase();
    let frames = this.spriteCache.get(key);
    if (!frames && key.startsWith(LOOK_PREFIX.toUpperCase())) return [];
    if (!frames) {
      frames = this.archive.has(key) ? decodeSprites(this.archive.read(key)) : [];
      this.spriteCache.set(key, frames);
    }
    return frames;
  }

  /** A level in which a sprite container is loaded (for choosing a palette to show it with). */
  levelUsing(container: string, preferred?: string): string {
    const name = container.toUpperCase();
    const uses = (id: string) => [...this.level(id).slots.values()].some((n) => n.toUpperCase() === name);
    if (preferred && uses(preferred)) return preferred;
    return this.levels.find((l) => uses(l.id))?.id ?? preferred ?? 'MARS';
  }

  /**
   * The sprite layers that make up an entity standing still. Most actors are
   * drawn from two animation blocks (for robots: chassis, then torso/turret).
   */
  entityLayers(type: number, levelId: string, looks?: SlotLooks): { container: string; source: AnimationSource | null; frame: number }[] {
    const info = this.entity(type);
    if (!info) return [];
    const level = this.level(levelId);
    const layers: { container: string; source: AnimationSource | null; frame: number }[] = [];
    const add = (source: AnimationSource | null | undefined, slot: number) => {
      const container = level.slots.has(slot) ? (this.lookContainer(looks, slot) ?? level.slots.get(slot)) : undefined;
      if (source && container) layers.push({ container, source: { ...source, slot }, frame: source.frameBase + Math.max(0, source.startOffset) });
    };
    const d = info.descriptor;
    if (info.category === 'pickup' && info.sprite && info.spriteFrame !== null) {
      return [{ container: level.slots.get(d?.primaryAnimation?.slot ?? -1) ?? info.sprite, source: d?.primaryAnimation ?? null, frame: info.spriteFrame }];
    }
    if (d?.primaryAnimation) {
      // Controllable forms idle on their per-form record; it has no slot of its own.
      const idle = info.form ? this.formAnimations[info.form - 1]?.idleBody : null;
      add(idle ?? d.primaryAnimation, d.primaryAnimation.slot);
    }
    if (d?.secondaryAnimation) add(d.secondaryAnimation, d.secondaryAnimation.slot);
    if (!layers.length && info.sprite) layers.push({ container: info.sprite, source: null, frame: info.spriteFrame ?? 0 });
    return layers;
  }

  /**
   * How every entity type is placed across the retail levels: which behavior
   * numbers go with routes, with wander zones, and with no path at all. This is
   * the evidence for which behavior makes an entity follow a path.
   */
  pathHabits(type: number): PathHabits {
    if (!this.habits) {
      this.habits = new Map();
      for (const level of this.levels) {
        const map = this.levelMap(level.id);
        for (const group of map.groups) {
          for (const layer of group.layers) {
            for (const o of layer.objects) {
              const t = objectMapType(o);
              let h = this.habits.get(t);
              if (!h) this.habits.set(t, (h = { route: new Map(), zone: new Map(), none: new Map() }));
              const path = o.pathIndex >= 0 ? map.paths[o.pathIndex] : undefined;
              const bucket = !path ? h.none : path.word0 === 4 ? h.zone : h.route;
              const b = objectBehavior(o);
              bucket.set(b, (bucket.get(b) ?? 0) + 1);
            }
          }
        }
      }
    }
    return this.habits.get(type) ?? { route: new Map(), zone: new Map(), none: new Map() };
  }

  /** The behavior the retail levels most often pair with a route or zone for a type, with how often. */
  pathBehavior(type: number, kind: 'route' | 'zone'): { behavior: number; uses: number } | null {
    const best = [...this.pathHabits(type)[kind]].sort((a, b) => b[1] - a[1])[0];
    return best ? { behavior: best[0], uses: best[1] } : null;
  }

  /** The sounds an ambient emitter can pick from in a level, by behavior number. */
  ambientProfiles(levelId: string): AmbientProfile[] {
    return bestiary.ambientSounds.filter((p) => p.map === `${levelId}.MAP`).sort((a, b) => a.selector - b.selector);
  }

  /** Sprite containers each runtime slot holds in at least one level. */
  private containersBySlot(): Map<number, Set<string>> {
    if (!this.slotContainers) {
      this.slotContainers = new Map();
      for (const level of this.levels) {
        for (const s of level.sprites) {
          const name = this.archive.entries[s.archiveId]?.name.toUpperCase();
          if (!name) continue;
          let set = this.slotContainers.get(s.slot);
          if (!set) this.slotContainers.set(s.slot, (set = new Set()));
          set.add(name);
        }
      }
    }
    return this.slotContainers;
  }

  /**
   * Every animation record in the executable that draws from a sprite
   * container: the ones actors start with and the ones the game code switches
   * to (walking, attacking, dying). Which actor uses which is not recorded.
   */
  animationsFor(container: string): AnimationSource[] {
    const slots = this.containersBySlot();
    if (!this.scannedAnimations) this.scannedAnimations = scanAnimationSources(this.exe, new Set(slots.keys()));
    const name = container.toUpperCase();
    const frames = this.sprites(name).length;
    return this.scannedAnimations
      .filter((a) => slots.get(a.slot)?.has(name) && a.frameBase + Math.max(a.frameSpan, a.startOffset + 1) <= frames)
      .sort((a, b) => a.frameBase + Math.max(0, a.startOffset) - (b.frameBase + Math.max(0, b.startOffset)) || a.frameSpan - b.frameSpan || a.va - b.va);
  }

  /**
   * The scenery cell an entity type stands on in a level's own map, when
   * nearly every copy stands on the same raised cell at the same spot (the
   * alien torches on their stands, for instance).
   */
  entityBase(type: number, levelId: string): EntityBase | null {
    const key = `${type}:${levelId}`;
    if (this.baseCache.has(key)) return this.baseCache.get(key)!;
    // Only scenery has a stand. Emitters and sounds are often placed on raised cells too, but do not belong to them.
    if (this.entity(type)?.category !== 'decor') {
      this.baseCache.set(key, null);
      return null;
    }
    const map = this.levelMap(levelId);
    const cells = new Map<number, Map<number, number>>();
    let total = 0;
    for (const group of map.groups) {
      for (const layer of group.layers) {
        for (const o of layer.objects) {
          if (objectMapType(o) !== type) continue;
          const cx = o.x >> 8;
          const cy = o.y >> 8;
          if (cx < 0 || cy < 0 || cx >= layer.width || cy >= layer.height) continue;
          total++;
          const id = layer.cells[cy * layer.width + cx] & DEFINITION_MASK;
          let offsets = cells.get(id);
          if (!offsets) cells.set(id, (offsets = new Map()));
          const offset = ((o.x & 255) << 8) | (o.y & 255);
          offsets.set(offset, (offsets.get(offset) ?? 0) + 1);
        }
      }
    }
    let base: EntityBase | null = null;
    for (const [id, offsets] of cells) {
      const definition = map.definitions[id];
      const [offset, count] = [...offsets].sort((a, b) => b[1] - a[1])[0];
      let top = 0;
      for (let i = 2; i < definition.vertices.length; i += 3) top = Math.min(top, definition.vertices[i]);
      if (total >= 3 && count / total >= 0.6 && top <= -24) base = { definitionId: id, definition, offsetX: offset >> 8, offsetY: offset & 255 };
    }
    this.baseCache.set(key, base);
    return base;
  }

  /** The stand-in container name for a slot a map replaces, with its frames registered; undefined when it is not replaced. */
  lookContainer(looks: SlotLooks | undefined, slot: number): string | undefined {
    const frames = looks?.slots.get(slot);
    if (!looks || !frames) return undefined;
    const name = `${LOOK_PREFIX}${looks.key}:${slot}`.toUpperCase();
    if (!this.spriteCache.has(name)) {
      // Recoloring makes a new look on every slider step; do not keep them all.
      const stale = [...this.spriteCache.keys()].filter((k) => k.startsWith(LOOK_PREFIX.toUpperCase()));
      if (stale.length > 48) {
        for (const k of stale) this.spriteCache.delete(k);
        for (const k of [...this.imageCache.keys()]) if (k.includes(LOOK_PREFIX.toUpperCase()) || k.startsWith('entity:@')) this.imageCache.delete(k);
      }
      this.spriteCache.set(name, frames);
    }
    return name;
  }

  /** RGBA canvas of one sprite frame under a level's palette, or null when unavailable. */
  frameImage(container: string, frameIndex: number, levelId: string): HTMLCanvasElement | null {
    const key = `${container.toUpperCase()}:${frameIndex}:${levelId}`;
    if (this.imageCache.has(key)) return this.imageCache.get(key)!;
    const frame = this.sprites(container)[frameIndex];
    let canvas: HTMLCanvasElement | null = null;
    if (frame) {
      const side = spriteSide(frame.scale);
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = side;
      const rgba = this.level(levelId).palette.toRgba(frame.pixels, 0);
      canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, side, side), 0, 0);
    }
    this.imageCache.set(key, canvas);
    return canvas;
  }

  /** Still image for an entity type (all its layers), drawn with a level's palette and sprite set. */
  entityImage(type: number, levelId: string, looks?: SlotLooks): HTMLCanvasElement | null {
    const key = looks ? `entity:@${looks.key}:${type}:${levelId}` : `entity:${type}:${levelId}`;
    if (this.imageCache.has(key)) return this.imageCache.get(key)!;
    const images: HTMLCanvasElement[] = [];
    for (const layer of this.entityLayers(type, levelId, looks)) {
      // A container that this level does not load is shown with a level that does.
      const paletteLevel = this.level(levelId).slots.get(layer.source?.slot ?? -1) ? levelId : this.levelUsing(layer.container, levelId);
      const image = this.frameImage(layer.container, layer.frame, paletteLevel);
      if (image) images.push(image);
    }
    let canvas: HTMLCanvasElement | null = null;
    if (images.length === 1) canvas = images[0];
    else if (images.length > 1) {
      // Frames come in several sizes; each is drawn at its own size about the shared center.
      const side = Math.max(...images.map((i) => i.width));
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = side;
      const g = canvas.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      for (const image of images) g.drawImage(image, (side - image.width) / 2, (side - image.height) / 2);
    }
    this.imageCache.set(key, canvas);
    return canvas;
  }

  /** Whether a level loads the sprites an entity type needs. */
  entityAvailableIn(type: number, levelId: string): boolean {
    const info = this.entity(type);
    if (!info) return false;
    if (!info.sprite) return true; // invisible helpers and effects need no container of their own
    const name = info.sprite.toUpperCase();
    // Hostages use a different container per level, all in the same slot.
    if (info.type === 15) return true;
    return [...this.level(levelId).slots.values()].some((n) => n.toUpperCase() === name);
  }
}
