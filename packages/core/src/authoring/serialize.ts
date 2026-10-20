/** Project <-> JSON. Binary arrays are stored as base64 so a project is one self-contained text file. */
import { LEVEL_IDS, type LevelId } from '../exe/tables.ts';
import { flipBmpRows } from '../gfx/bmp.ts';
import { TILE_BYTES } from '../gfx/terrain.ts';
import type { CellDefinition } from '../map/model.ts';
import { lightingSize } from '../map/model.ts';
import { check } from '../util/binary.ts';
import { rampFaceEdges } from './compose.ts';
import { type CellBehaviorSpec, type CellOverlay, type CustomType, type Entity, type MapProject, PROJECT_FORMAT, PROJECT_VERSION, type ProjectGroup, type RampSurface, type Surface, type Wall, wallKey } from './project.ts';
import { type PropModel, partsFromBlocks } from './prop-model.ts';

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const u16ToBytes = (a: Uint16Array | Int16Array): Uint8Array => {
  const out = new Uint8Array(a.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) view.setUint16(i * 2, a[i] & 0xffff, true);
  return out;
};
const bytesToU16 = (b: Uint8Array): Uint16Array => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Uint16Array.from({ length: b.length >> 1 }, (_, i) => view.getUint16(i * 2, true));
};
const bytesToI16 = (b: Uint8Array): Int16Array => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Int16Array.from({ length: b.length >> 1 }, (_, i) => view.getInt16(i * 2, true));
};

interface StoredDefinition {
  v: string;
  c: (number | null)[][];
  m: string;
  a: string | null;
  ok: boolean;
}

interface StoredLayer {
  name: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  cells: string;
  lighting: string;
  surfaces: [number, Surface][];
  walls: Wall[];
  behaviors: [number, CellBehaviorSpec][];
  /** Absent before version 3. */
  overlays?: [number, CellOverlay][];
  entities: Entity[];
}

interface StoredModel extends Omit<PropModel, 'parts'> {
  /** Absent before version 5. */
  parts?: PropModel['parts'];
  /** Before version 5: blocks on an 8x8x8 grid and their painted faces. */
  voxels?: string;
  paint?: [number, number][];
}

interface StoredProject extends Omit<MapProject, 'groups' | 'definitions' | 'tiles' | 'briefing' | 'models' | 'sounds' | 'customTypes' | 'effects' | 'triggers'> {
  /** Absent before version 4. */
  effects?: MapProject['effects'];
  /** Absent before version 6. */
  triggers?: MapProject['triggers'];
  briefing: Omit<MapProject['briefing'], 'image'> & { image: string | null };
  groups: { name: string; layers: StoredLayer[] }[];
  definitions: StoredDefinition[];
  tiles: string;
  /** Absent before version 3. */
  models?: StoredModel[];
  sounds?: { id: number; name: string; wav: string }[];
  /** Absent before version 4. */
  customTypes?: (Omit<CustomType, 'sprite'> & { sprite: { slot: number; data: string } | null })[];
}

export function serializeProject(project: MapProject): string {
  const tiles = new Uint8Array(project.tiles.length * TILE_BYTES);
  project.tiles.forEach((t, i) => tiles.set(t, i * TILE_BYTES));
  const stored: StoredProject = {
    ...project,
    briefing: { ...project.briefing, image: project.briefing.image ? toBase64(project.briefing.image) : null },
    groups: project.groups.map((g) => ({
      name: g.name,
      layers: g.layers.map((l) => ({
        name: l.name,
        width: l.width,
        height: l.height,
        originX: l.originX,
        originY: l.originY,
        cells: toBase64(u16ToBytes(l.cells)),
        lighting: toBase64(l.lighting),
        surfaces: [...l.surfaces].sort((a, b) => a[0] - b[0]),
        walls: [...l.walls.values()],
        behaviors: [...l.behaviors].sort((a, b) => a[0] - b[0]),
        overlays: [...l.overlays].sort((a, b) => a[0] - b[0]),
        entities: l.entities,
      })),
    })),
    models: project.models.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p })) })),
    sounds: project.sounds.map((s) => ({ id: s.id, name: s.name, wav: toBase64(s.wav) })),
    customTypes: project.customTypes.map((t) => ({ ...t, sprite: t.sprite ? { slot: t.sprite.slot, data: toBase64(t.sprite.data) } : null })),
    definitions: project.definitions.map((d) => ({
      v: toBase64(u16ToBytes(d.vertices)),
      c: d.commands.map((c) => [c.op, c.texture, ...c.indices]),
      m: toBase64(d.meta),
      a: d.automap ? toBase64(u16ToBytes(d.automap)) : null,
      ok: d.complete,
    })),
    tiles: toBase64(tiles),
  };
  return JSON.stringify(stored);
}

/** Version 1 ramps had one tile for all the faces under them. */
function migrateSurface(surface: Surface): Surface {
  if (surface.kind !== 'ramp' || surface.sides) return surface;
  const { sideTile, ...rest } = surface as RampSurface & { sideTile?: number | null };
  const sides: RampSurface['sides'] = {};
  if (sideTile !== null && sideTile !== undefined) for (const edge of rampFaceEdges(surface.direction)) sides[edge] = sideTile;
  return { ...rest, sides };
}

export function deserializeProject(text: string): MapProject {
  const s = JSON.parse(text) as StoredProject;
  check(s && s.format === PROJECT_FORMAT, 'This is not a Machine Hunter Workshop map project');
  check(s.version <= PROJECT_VERSION, 'This project was saved by a newer version of the Workshop');
  check(LEVEL_IDS.includes(s.baseLevel as LevelId), `Unknown base level "${s.baseLevel}"`);
  const tileBytes = fromBase64(s.tiles);
  check(tileBytes.length % TILE_BYTES === 0, 'Project terrain data is damaged');
  const tiles: Uint8Array[] = [];
  for (let at = 0; at < tileBytes.length; at += TILE_BYTES) tiles.push(tileBytes.slice(at, at + TILE_BYTES));
  const definitions: CellDefinition[] = s.definitions.map((d) => ({
    vertices: bytesToI16(fromBase64(d.v)),
    commands: d.c.map(([op, texture, ...indices]) => ({ op: op as number, texture, indices: indices as number[] })),
    meta: fromBase64(d.m),
    automap: d.a ? bytesToU16(fromBase64(d.a)) : null,
    complete: d.ok,
  }));
  const groups: ProjectGroup[] = s.groups.map((g) => ({
    name: g.name,
    layers: g.layers.map((l) => {
      const cells = bytesToU16(fromBase64(l.cells));
      const lighting = fromBase64(l.lighting);
      check(cells.length === l.width * l.height && lighting.length === lightingSize(l.width, l.height), `Layer "${l.name}" is damaged`);
      return {
        name: l.name,
        width: l.width,
        height: l.height,
        originX: l.originX,
        originY: l.originY,
        cells,
        lighting,
        surfaces: new Map(l.surfaces.map(([index, surface]) => [index, migrateSurface(surface)])),
        walls: new Map(l.walls.map((w) => [wallKey(w.x0, w.y0, w.x1, w.y1), w])),
        behaviors: new Map(l.behaviors),
        overlays: new Map(l.overlays ?? []),
        entities: l.entities,
      };
    }),
  }));
  // Version 1 wrote briefing pictures bottom row first, which the game shows upside down.
  let image = s.briefing.image ? fromBase64(s.briefing.image) : null;
  if (image && s.version < 2) image = flipBmpRows(image);
  const models: PropModel[] = (s.models ?? []).map(({ voxels, paint, parts, ...m }) => ({ ...m, parts: parts ?? (voxels ? partsFromBlocks(fromBase64(voxels), m.tile, new Map(paint ?? [])) : []) }));
  const sounds = (s.sounds ?? []).map((sound) => ({ id: sound.id, name: sound.name, wav: fromBase64(sound.wav) }));
  const effects = s.effects ?? [];
  const triggers = s.triggers ?? [];
  const customTypes: CustomType[] = (s.customTypes ?? []).map((t) => ({ ...t, sprite: t.sprite ? { slot: t.sprite.slot, data: fromBase64(t.sprite.data) } : null }));
  return { ...s, version: PROJECT_VERSION, briefing: { ...s.briefing, image }, groups, definitions, tiles, models, sounds, customTypes, effects, triggers };
}

/** Deep copy; used for undo snapshots. */
export function cloneProject(project: MapProject): MapProject {
  return {
    ...project,
    briefing: { ...project.briefing },
    groups: project.groups.map((g) => ({
      name: g.name,
      layers: g.layers.map((l) => ({
        ...l,
        cells: l.cells.slice(),
        lighting: l.lighting.slice(),
        surfaces: new Map([...l.surfaces].map(([k, v]) => [k, structuredClone(v)])),
        walls: new Map([...l.walls].map(([k, v]) => [k, { ...v }])),
        behaviors: new Map([...l.behaviors].map(([k, v]) => [k, { ...v }])),
        overlays: new Map([...l.overlays].map(([k, v]) => [k, { props: [...v.props], breakable: v.breakable ? { ...v.breakable } : undefined }])),
        entities: l.entities.map((e) => ({ ...e, sound: e.sound ? { ...e.sound } : undefined })),
      })),
    })),
    // Library definitions and tiles are treated as immutable values and shared.
    definitions: project.definitions.slice(),
    definitionSources: project.definitionSources.slice(),
    tiles: project.tiles.slice(),
    paths: project.paths.map((p) => ({ ...p, points: p.points.map((pt) => ({ ...pt })) })),
    models: project.models.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p, ...(p.faces ? { faces: { ...p.faces } } : {}) })) })),
    // Sounds are immutable once added and are shared.
    sounds: project.sounds.slice(),
    effects: project.effects.map((e) => ({ ...e, particles: e.particles.map((p) => ({ ...p })) })),
    triggers: project.triggers.map((t) => ({ ...t, actions: t.actions.map((a) => ({ ...a })) })),
    // Sprite data is replaced, never edited in place, so it is shared.
    customTypes: project.customTypes.map((t) => ({ ...t, look: t.look ? { ...t.look } : null, animations: t.animations?.map((a) => ({ ...a })) })),
    textureScrolls: project.textureScrolls.map((t) => ({ ...t })),
    textureCycles: project.textureCycles.map((t) => ({ ...t, frames: t.frames.slice() })),
  };
}
