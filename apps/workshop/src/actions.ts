/** Things the user can do from more than one screen. */
import { type LevelId, type MapProject, CompileError, PATH_ZONE, buildMhproject, createProject, modManifest, openMhproject, projectFromMap, slugify } from '@mh/core';
import { createPath } from './editor/ops.ts';
import { type Autosave, api } from './game/api.ts';
import { LEVEL_TITLES } from './game/gamedata.ts';
import { useApp } from './state/app.ts';
import { useEditor } from './state/editor.ts';

/** The mod folder the Workshop installs test maps into. */
export const WORKSHOP_MOD_ID = 'workshop';

function confirmDiscard(): boolean {
  return !useEditor.getState().dirty || window.confirm('The current map has unsaved changes. Discard them?');
}

export function newProject(options: { name: string; baseLevel: LevelId; width: number; height: number }): void {
  const { game, go } = useApp.getState();
  if (!game || !confirmDiscard()) return;
  const project = createProject({ ...options, tiles: game.level(options.baseLevel).tiles });
  useEditor.getState().open(project, null);
  // Sensible first brushes: the first two tiles of the level's bank.
  useEditor.getState().setBrush({ floorTile: 0, wallTile: Math.min(1, project.tiles.length - 1), entityType: 1 });
  useEditor.getState().setTool('room');
  go('build');
}

/** Open a retail level as an editable project. */
export function openRetailLevel(levelId: LevelId): void {
  const { game, go, toast } = useApp.getState();
  if (!game || !confirmDiscard()) return;
  try {
    const record = game.levelRecord(levelId);
    const project = projectFromMap(game.levelMap(levelId), {
      name: `${LEVEL_TITLES[levelId] ?? levelId} (edit)`,
      baseLevel: levelId,
      tiles: game.level(levelId).tiles,
      initialGroup: record.initialGroup,
      sourceLabel: levelId,
    });
    useEditor.getState().open(project, null);
    useEditor.getState().setTool('select');
    go('build');
  } catch (error) {
    toast(`Could not open ${levelId}: ${(error as Error).message}`, 'error');
  }
}

/**
 * Open a map file: `path`, or one picked in the Windows Open dialog. When the
 * map has an autosave newer than the file, offer to open that instead.
 */
export async function openMapFile(path?: string): Promise<void> {
  const { go, toast } = useApp.getState();
  if (!confirmDiscard()) return;
  let file = path ?? null;
  try {
    if (!file) file = await api.pickOpen();
    if (!file) return;
    const newer = await api.autosaveOf(file).catch(() => null);
    const restore = newer && window.confirm(`There is an autosave of ${fileName(file)} from ${new Date(newer.modified).toLocaleString()}, newer than the file itself.\n\nOpen the autosave? (Cancel opens the file as it was last saved.)`);
    const bytes = await api.readFile(restore ? newer.autosave : file);
    useEditor.getState().open(openMhproject(bytes), file, !!restore);
    useEditor.getState().setTool('select');
    go('build');
  } catch (error) {
    toast(`Could not open ${file ? fileName(file) : 'the map'}: ${(error as Error).message}`, 'error');
  }
}

/** Open an autosave: the map comes back unsaved, and Save writes to the file it belongs to (or asks where). */
export async function openAutosave(autosave: Autosave): Promise<void> {
  const { go, toast } = useApp.getState();
  if (!confirmDiscard()) return;
  try {
    useEditor.getState().open(openMhproject(await api.readFile(autosave.autosave)), autosave.for, true);
    useEditor.getState().setTool('select');
    go('build');
  } catch (error) {
    toast(`Could not open the autosave: ${(error as Error).message}`, 'error');
  }
}

/** The name part of a path. */
export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

function compileOptions(project: MapProject) {
  const game = useApp.getState().game;
  return game ? { opaqueZeroIndex: game.level(project.baseLevel).opaqueZeroIndex, knownTypes: game.knownTypes } : {};
}

/** Build the current map and copy it into the game's Workshop mod folder. Returns the installed file name. */
export async function installToGame(): Promise<string | null> {
  const { toast } = useApp.getState();
  const { project } = useEditor.getState();
  if (!project) return null;
  try {
    const built = buildMhproject(project, { ...compileOptions(project), requirePlayable: true });
    const file = `${slugify(project.name)}.mhproject`;
    await api.writeModFile(WORKSHOP_MOD_ID, 'mod.json', modManifest({ id: WORKSHOP_MOD_ID, name: 'Workshop maps', version: '1.0.0', description: 'Maps installed from the Machine Hunter Workshop.' }));
    await api.writeModFile(WORKSHOP_MOD_ID, `maps/${file}`, built.bytes);
    return file;
  } catch (error) {
    const message = error instanceof CompileError ? error.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ') : (error as Error).message;
    toast(`The map is not playable yet: ${message}`, 'error');
    return null;
  }
}

let playing = false;

/** Install the current map and start the game straight into it, past the launcher and the menus. */
export async function playInGame(): Promise<void> {
  if (playing) return;
  playing = true;
  try {
    await installAndLaunch();
  } finally {
    playing = false;
  }
}

async function installAndLaunch(): Promise<void> {
  const { toast } = useApp.getState();
  const file = await installToGame();
  if (!file) return;
  try {
    await api.launch({ mod: WORKSHOP_MOD_ID, file });
    toast(`Starting "${file.replace(/\.mhproject$/, '')}"…`, 'success');
  } catch (error) {
    toast(`Installed ${file}, but the game could not be started: ${(error as Error).message}`, 'error');
  }
}

export async function launchGame(): Promise<void> {
  const { toast } = useApp.getState();
  try {
    await api.launch();
    toast('Game started.', 'success');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
}

/**
 * Start a path for an entity and switch to the path tool to draw it. The
 * entity is given the behavior the retail levels pair with that kind of path,
 * when they ever give this type one.
 */
export function givePath(group: number, layer: number, entityId: number): void {
  const { game, toast } = useApp.getState();
  const editor = useEditor.getState();
  const mode = editor.brush.pathMode;
  const kind = mode === PATH_ZONE ? 'zone' : 'route';
  let created = -1;
  let known = false;
  editor.edit((p) => {
    const entity = p.groups[group]?.layers[layer]?.entities.find((e) => e.id === entityId);
    if (!entity) return;
    created = createPath(p, group, layer, mode).id;
    entity.pathId = created;
    const habit = game?.pathBehavior(entity.type, kind);
    if (habit) {
      entity.behavior = habit.behavior;
      known = true;
    }
  });
  if (created < 0) return;
  editor.setActive(group, layer);
  editor.select({ kind: 'entity', group, layer, id: entityId });
  editor.setSelectedPath(created);
  editor.setTool('path');
  // setTool clears nothing we need, but the selection must survive it.
  useEditor.getState().setSelectedPath(created);
  toast(
    known
      ? mode === PATH_ZONE
        ? 'Drag a rectangle for the zone.'
        : 'Click the points to walk to, in order.'
      : 'This entity may ignore paths.',
    known ? 'info' : 'error',
  );
}

/** Save the current map to the browser's downloads as a .mhproject. */
export function downloadProject(): void {
  const { project } = useEditor.getState();
  if (!project) return;
  const built = buildMhproject(project, compileOptions(project));
  const url = URL.createObjectURL(new Blob([built.bytes as BlobPart], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(project.name)}.mhproject`;
  link.click();
  URL.revokeObjectURL(url);
}
