/**
 * Map-builder state. The project object is mutated in place (it holds large
 * typed arrays); `revision` is bumped after every change so views know to
 * refresh, and whole-project snapshots provide undo/redo.
 */
import { type Entity, type MapProject, PATH_BACK_AND_FORTH, type RampDirection, type TextureTurn, buildMhproject, cloneProject, slugify, type DoorStyle } from '@mh/core';
import { create } from 'zustand';
import { api } from '../game/api.ts';
import { useApp } from './app.ts';

export type ToolId = 'select' | 'room' | 'floor' | 'wall' | 'block' | 'ramp' | 'paint' | 'erase' | 'entity' | 'path' | 'prop' | 'interactive' | 'light';

/** The Interactive tool's tabs: everything in a map that reacts to the player. */
export type InteractiveTab = 'doors' | 'breakables' | 'triggers' | 'teleporter' | 'exit' | 'hazard';

/** What a click on the map does in the Triggers tab: lay pads, or pick the place of a new action. */
export type TriggerPick = 'pads' | 'break' | 'retexture' | 'effect' | 'reveal';

export type Selection =
  | { kind: 'entity'; group: number; layer: number; id: number }
  | { kind: 'cell'; group: number; layer: number; x: number; y: number }
  | { kind: 'wall'; group: number; layer: number; key: string };

export interface Brush {
  /** Tile used by the floor, room and paint tools. */
  floorTile: number;
  wallTile: number;
  wallHeight: number;
  floorTurn: TextureTurn;
  floorSeeThrough: boolean;
  rampDirection: RampDirection;
  rampSides: boolean;
  /** Height of the block tool's blocks, in cells. */
  blockHeight: number;
  /** Build centered columns instead of full blocks. */
  blockPillar: boolean;
  blockWidth: number;
  entityType: number;
  /** Place the entity together with the scenery cell it always stands on in the retail levels. */
  entityWithBase: boolean;
  entityBehavior: number;
  entityWeapon: number;
  /** Custom effect (`MapProject.effects`) the entity tool places, or null to place `entityType`. */
  effect: number | null;
  /** Library definition placed by the prop tool. */
  prop: number;
  /** 'over' stands the prop on what is already in the cell; 'replace' makes it the whole cell. */
  propMode: 'over' | 'replace';
  /** Mode given to paths drawn with the path tool (a PATH_ constant). */
  pathMode: number;
  lightLevel: number;
  lightRadius: number;
  hazardDamage: number;
  /** Which tab of the Interactive tool is open. */
  interactive: InteractiveTab;
  /** Breakables placed by the Interactive tool: how tough, which destruction effect, what they turn into. */
  breakToughness: number;
  breakEffect: number;
  breakResult: 'floor' | 'broken';
  /** Walls drawn see-through: color 0 of their tile is transparent (glass, grilles). */
  wallSeeThrough: boolean;
  /** Lock of the doors it places: 0 touch, 1..5 a key, a trigger channel. */
  doorLock: number;
  /** Which way you walk through the doors it places. */
  doorFacing: 'ns' | 'ew';
  /** Whether the doors it places rise into the ceiling or sink into the floor. */
  doorStyle: DoorStyle;
}

export interface ViewOptions {
  /** Preview the game's lighting; off shows everything at full brightness. */
  lighting: boolean;
  grid: boolean;
  entities: boolean;
  /** Hide layers above the active one, like lowering walls to see inside. */
  hideUpper: boolean;
  /** Show cell behaviors (teleporters, exits, hazards) as colored markers. */
  markers: boolean;
  /** Name tags above entities. */
  labels: boolean;
  /** Animate emitters, flames and flickering lights as the game does. */
  effects: boolean;
}

const MAX_UNDO = 80;

interface EditorState {
  project: MapProject | null;
  /** Counts the maps opened this session, so views can tell a new map from an undo step. */
  documentId: number;
  /** A place the viewport has been asked to center on. */
  focus: { group: number; layer: number; x: number; y: number; nonce: number } | null;
  /** Full path of the map's file, once opened from or saved to one. */
  filePath: string | null;
  /** When the map was last autosaved (ms), and at which revision. */
  autosavedAt: number | null;
  autosavedRevision: number;
  revision: number;
  /** Bumps when library definitions or tiles change, so views rebuild their caches. */
  libraryRevision: number;
  dirty: boolean;
  group: number;
  layer: number;
  tool: ToolId;
  brush: Brush;
  view: ViewOptions;
  selection: Selection | null;
  /** First click of the teleporter tool, waiting for a destination. */
  pendingTeleporter: { group: number; layer: number; x: number; y: number } | null;
  /** The path the path tool is editing. */
  selectedPath: number | null;
  /** The path whose followers the view shows walking it, or null. */
  walkingPath: number | null;
  /** The trigger (by channel) open in the Triggers tab, and what clicking the map does for it. */
  trigger: number | null;
  triggerPick: TriggerPick;
  /** The custom prop open in the prop editor (`PropModel.id`), or null. */
  editingModel: number | null;
  /** The mission briefing dialog is open. */
  briefingOpen: boolean;
  helpOpen: boolean;
  undoStack: MapProject[];
  redoStack: MapProject[];
  strokeOpen: boolean;
  hover: { x: number; y: number } | null;

  /** Show `project` for editing. `filePath` is the file Save writes to; `dirty` for a map that is not that file's contents (a recovered autosave). */
  open: (project: MapProject, filePath: string | null, dirty?: boolean) => void;
  close: () => void;
  /** Apply one undoable change. */
  edit: (change: (project: MapProject) => void) => void;
  /** Start a multi-step change (a drag); call `touch` as it progresses and `endStroke` to finish. */
  beginStroke: () => void;
  touch: () => void;
  /** Like `touch`, after changing the library (props) during a stroke. */
  touchLibrary: () => void;
  endStroke: () => void;
  /** Close the open stroke and put the map back as it was before it began. */
  abortStroke: () => void;
  /** A change to the prop library or tile bank. */
  editLibrary: (change: (project: MapProject) => void) => void;
  undo: () => void;
  redo: () => void;
  setTool: (tool: ToolId) => void;
  setBrush: (brush: Partial<Brush>) => void;
  setView: (view: Partial<ViewOptions>) => void;
  setActive: (group: number, layer: number) => void;
  /** Switch to a cell's area and layer, select it and center the view on it. */
  focusOn: (group: number, layer: number, x: number, y: number) => void;
  select: (selection: Selection | null) => void;
  setHover: (hover: { x: number; y: number } | null) => void;
  setPendingTeleporter: (p: EditorState['pendingTeleporter']) => void;
  setSelectedPath: (id: number | null) => void;
  setWalkingPath: (id: number | null) => void;
  setTrigger: (channel: number | null) => void;
  setTriggerPick: (pick: TriggerPick) => void;
  setEditingModel: (id: number | null) => void;
  setBriefingOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  /** Save to the map's file, or ask where with Save As when it has none. */
  save: () => Promise<boolean>;
  /** The Windows Save As dialog, then save there. */
  saveAs: () => Promise<boolean>;
  /** Write the map's autosave copy when it has changed since the last one. */
  autosave: () => Promise<void>;
  selectedEntity: () => Entity | null;
}

const defaultBrush: Brush = {
  floorTile: 0,
  wallTile: 1,
  wallHeight: 1,
  floorTurn: 0,
  floorSeeThrough: false,
  rampDirection: 'east',
  rampSides: true,
  blockHeight: 1,
  blockPillar: false,
  blockWidth: 0.5,
  entityType: 1,
  entityWithBase: true,
  entityBehavior: 0,
  entityWeapon: 0,
  effect: null,
  prop: 0,
  propMode: 'over',
  pathMode: PATH_BACK_AND_FORTH,
  lightLevel: 22,
  lightRadius: 2,
  hazardDamage: 4,
  interactive: 'doors',
  breakToughness: 30,
  breakEffect: 8,
  breakResult: 'broken',
  wallSeeThrough: false,
  doorLock: 0,
  doorFacing: 'ns',
  doorStyle: 'rise',
};

/** A project as the .mhproject file the Workshop saves. */
function buildMap(project: MapProject) {
  const game = useApp.getState().game;
  return buildMhproject(project, game ? { opaqueZeroIndex: game.level(project.baseLevel).opaqueZeroIndex, knownTypes: game.knownTypes } : {});
}

/** Save the open map to `path`; its autosave is no longer needed afterwards. */
async function writeMap(path: string): Promise<boolean> {
  const { project, filePath, revision } = useEditor.getState();
  const app = useApp.getState();
  if (!project) return false;
  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    const built = buildMap(project);
    await api.writeFile(path, built.bytes);
    // Edits made while the file was written still count as unsaved.
    const current = useEditor.getState();
    if (current.project === project) useEditor.setState({ filePath: path, dirty: current.revision !== revision });
    app.toast(built.playable ? `Saved ${name}` : `Saved ${name} (not playable yet: see Checks)`, built.playable ? 'success' : 'info');
    void api.deleteAutosave({ for: path }).catch(() => {});
    if (!filePath) void api.deleteAutosave({ name: slugify(project.name) || 'map' }).catch(() => {});
    return true;
  } catch (error) {
    app.toast(`Could not save ${name}: ${(error as Error).message}`, 'error');
    return false;
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  documentId: 0,
  focus: null,
  filePath: null,
  autosavedAt: null,
  autosavedRevision: -1,
  revision: 0,
  libraryRevision: 0,
  dirty: false,
  group: 0,
  layer: 0,
  tool: 'select',
  brush: defaultBrush,
  view: { lighting: true, grid: true, entities: true, hideUpper: true, markers: true, labels: true, effects: true },
  selection: null,
  pendingTeleporter: null,
  selectedPath: null,
  walkingPath: null,
  trigger: null,
  triggerPick: 'pads',
  editingModel: null,
  briefingOpen: false,
  helpOpen: false,
  undoStack: [],
  redoStack: [],
  strokeOpen: false,
  hover: null,

  open: (project, filePath, dirty = false) =>
    set({
      project,
      documentId: get().documentId + 1,
      focus: null,
      filePath,
      autosavedAt: null,
      autosavedRevision: get().revision + 1,
      revision: get().revision + 1,
      libraryRevision: get().libraryRevision + 1,
      dirty,
      group: Math.min(project.initialGroup, project.groups.length - 1),
      layer: 0,
      selection: null,
      pendingTeleporter: null,
      selectedPath: null,
      walkingPath: null,
      trigger: null,
      triggerPick: 'pads',
      editingModel: null,
      briefingOpen: false,
      undoStack: [],
      redoStack: [],
      strokeOpen: false,
    }),

  close: () => set({ project: null, filePath: null, autosavedAt: null, selection: null, undoStack: [], redoStack: [], dirty: false }),

  edit: (change) => {
    const { project } = get();
    if (!project) return;
    const before = cloneProject(project);
    change(project);
    set((s) => ({ undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), before], redoStack: [], revision: s.revision + 1, dirty: true }));
  },

  beginStroke: () => {
    const { project, strokeOpen } = get();
    if (!project || strokeOpen) return;
    set((s) => ({ undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), cloneProject(project)], redoStack: [], strokeOpen: true }));
  },
  touch: () => set((s) => ({ revision: s.revision + 1, dirty: true })),
  touchLibrary: () => set((s) => ({ revision: s.revision + 1, libraryRevision: s.libraryRevision + 1, dirty: true })),
  endStroke: () => set({ strokeOpen: false }),
  abortStroke: () => {
    const { strokeOpen, undoStack } = get();
    if (!strokeOpen || !undoStack.length) return set({ strokeOpen: false });
    set((s) => ({ project: undoStack[undoStack.length - 1], undoStack: undoStack.slice(0, -1), strokeOpen: false, revision: s.revision + 1, libraryRevision: s.libraryRevision + 1, selection: null }));
  },

  editLibrary: (change) => {
    const { project } = get();
    if (!project) return;
    const before = cloneProject(project);
    change(project);
    set((s) => ({ undoStack: [...s.undoStack.slice(-MAX_UNDO + 1), before], redoStack: [], revision: s.revision + 1, libraryRevision: s.libraryRevision + 1, dirty: true }));
  },

  undo: () => {
    const { project, undoStack, redoStack, strokeOpen } = get();
    if (!project || !undoStack.length || strokeOpen) return;
    const previous = undoStack[undoStack.length - 1];
    set((s) => ({
      project: previous,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, project],
      revision: s.revision + 1,
      libraryRevision: s.libraryRevision + 1,
      dirty: true,
      selection: null,
      group: Math.min(s.group, previous.groups.length - 1),
      layer: Math.min(s.layer, previous.groups[Math.min(s.group, previous.groups.length - 1)].layers.length - 1),
    }));
  },

  redo: () => {
    const { project, undoStack, redoStack, strokeOpen } = get();
    if (!project || !redoStack.length || strokeOpen) return;
    const next = redoStack[redoStack.length - 1];
    set((s) => ({
      project: next,
      undoStack: [...undoStack, project],
      redoStack: redoStack.slice(0, -1),
      revision: s.revision + 1,
      libraryRevision: s.libraryRevision + 1,
      dirty: true,
      selection: null,
      group: Math.min(s.group, next.groups.length - 1),
      layer: Math.min(s.layer, next.groups[Math.min(s.group, next.groups.length - 1)].layers.length - 1),
    }));
  },

  setTool: (tool) => set({ tool, pendingTeleporter: null }),
  setBrush: (brush) => set((s) => ({ brush: { ...s.brush, ...brush } })),
  setView: (view) => set((s) => ({ view: { ...s.view, ...view } })),
  setActive: (group, layer) => {
    const { project } = get();
    if (!project) return;
    const g = Math.max(0, Math.min(project.groups.length - 1, group));
    const l = Math.max(0, Math.min(project.groups[g].layers.length - 1, layer));
    set({ group: g, layer: l });
  },
  focusOn: (group, layer, x, y) => {
    const { project, focus } = get();
    if (!project?.groups[group]?.layers[layer]) return;
    set({ group, layer, selection: { kind: 'cell', group, layer, x, y }, focus: { group, layer, x, y, nonce: (focus?.nonce ?? 0) + 1 } });
  },
  select: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setPendingTeleporter: (pendingTeleporter) => set({ pendingTeleporter }),
  setSelectedPath: (selectedPath) => set({ selectedPath }),
  setWalkingPath: (walkingPath) => set({ walkingPath }),
  setTrigger: (trigger) => set({ trigger, triggerPick: 'pads' }),
  setTriggerPick: (triggerPick) => set({ triggerPick }),
  setEditingModel: (editingModel) => set({ editingModel }),
  setBriefingOpen: (briefingOpen) => set({ briefingOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),

  save: async () => {
    const { project, filePath } = get();
    if (!project) return false;
    return filePath ? writeMap(filePath) : get().saveAs();
  },

  saveAs: async () => {
    const { project, filePath } = get();
    if (!project) return false;
    try {
      const path = await api.pickSave(filePath ? { path: filePath } : { name: `${slugify(project.name) || 'map'}.mhproject` });
      return path ? writeMap(path) : false;
    } catch (error) {
      useApp.getState().toast(`Could not save: ${(error as Error).message}`, 'error');
      return false;
    }
  },

  autosave: async () => {
    const { project, filePath, dirty, revision, autosavedRevision } = get();
    if (!project || !dirty || revision === autosavedRevision) return;
    try {
      const bytes = buildMap(project).bytes;
      await api.writeAutosave(filePath ? { for: filePath } : { name: slugify(project.name) || 'map' }, bytes);
      // The map may have been closed or replaced while this was written.
      if (get().project === project) set({ autosavedAt: Date.now(), autosavedRevision: revision });
    } catch {
      /* the next attempt may work; a failed autosave must not interrupt editing */
    }
  },

  selectedEntity: () => {
    const { project, selection } = get();
    if (!project || selection?.kind !== 'entity') return null;
    return project.groups[selection.group]?.layers[selection.layer]?.entities.find((e) => e.id === selection.id) ?? null;
  },
}));

/** The active layer, or null when no project is open. */
export function activeLayer() {
  const { project, group, layer } = useEditor.getState();
  return project?.groups[group]?.layers[layer] ?? null;
}
