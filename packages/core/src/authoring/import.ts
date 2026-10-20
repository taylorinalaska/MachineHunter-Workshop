/** Turn a native map (for example a retail level) into an editable project. */
import type { LevelId } from '../exe/tables.ts';
import { type GameMap, OBJECT_DISABLED, lightingSize, objectBehavior, objectMapType, objectWeapon } from '../map/model.ts';
import { type MapProject, PROJECT_FORMAT, PROJECT_VERSION, type ProjectGroup } from './project.ts';

export interface ImportOptions {
  name: string;
  /** Level whose palette and sprites the map was built for. */
  baseLevel: LevelId;
  /** That level's terrain bank. */
  tiles: readonly Uint8Array[];
  initialGroup?: number;
  /** Label recorded as the origin of each library definition, e.g. "MARS". */
  sourceLabel?: string;
}

export function projectFromMap(map: GameMap, o: ImportOptions): MapProject {
  let maxId = 2047;
  const groups: ProjectGroup[] = map.groups.map((group, g) => ({
    name: map.groups.length === 1 ? 'Main area' : `Area ${g + 1}`,
    layers: group.layers.map((layer, l) => ({
      name: l === 0 ? 'Ground' : `Layer ${l + 1}`,
      width: layer.width,
      height: layer.height,
      originX: layer.originX,
      originY: layer.originY,
      cells: layer.cells.slice(),
      surfaces: new Map(),
      walls: new Map(),
      behaviors: new Map(),
      overlays: new Map(),
      // A layer without a lattice is lit at level 0 by the engine.
      lighting: layer.lighting ? layer.lighting.slice() : new Uint8Array(lightingSize(layer.width, layer.height)),
      entities: layer.objects.map((o, i) => {
        const id = o.poolIndex >= 0 ? o.poolIndex : 100000 + g * 10000 + l * 1000 + i;
        maxId = Math.max(maxId, id);
        return {
          id,
          type: objectMapType(o),
          behavior: objectBehavior(o),
          weapon: objectWeapon(o),
          bit8: (o.typeWord >> 8) & 1,
          x: o.x,
          y: o.y,
          disabled: (o.flags & OBJECT_DISABLED) !== 0,
          pathId: o.pathIndex >= 0 ? o.pathIndex : null,
          flagsRest: o.flags & ~OBJECT_DISABLED,
        };
      }),
    })),
  }));
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: o.name,
    author: '',
    description: '',
    baseLevel: o.baseLevel,
    initialGroup: o.initialGroup ?? 0,
    exitRule: 'inherit',
    briefing: { mode: 'inherit', title: '', text: '', image: null },
    groups,
    definitions: map.definitions.slice(),
    definitionSources: map.definitions.map((_, id) => (id ? `${o.sourceLabel ?? o.baseLevel} #${id}` : null)),
    tiles: o.tiles.map((t) => t.slice()),
    baseTileCount: o.tiles.length,
    paths: map.paths.map((p, id) => ({ id, word0: p.word0, flag: p.flag, group: p.group, layer: p.layer, points: p.points.map((pt) => ({ ...pt })) })),
    textureScrolls: map.textureScrolls.map((t) => ({ ...t })),
    textureCycles: map.textureCycles.map((t) => ({ ...t, frames: t.frames.slice() })),
    models: [],
    sounds: [],
    customTypes: [],
    effects: [],
    triggers: [],
    nextId: maxId + 1,
  };
}
