import { useEffect, useRef, useState } from 'react';
import { downloadProject, fileName, openMapFile, playInGame } from '../actions.ts';
import { MapView } from '../editor/mapview.ts';
import { removeEntity, removeTopOverlay } from '../editor/ops.ts';
import { ToolController } from '../editor/tools.ts';
import { Catalog } from '../panels/Catalog.tsx';
import { ChecksRunner, Inspector } from '../panels/Inspector.tsx';
import { StatusBar } from '../panels/StatusBar.tsx';
import { useApp, useGame } from '../state/app.ts';
import { type InteractiveTab, type ToolId, useEditor } from '../state/editor.ts';
import { Briefing } from './Briefing.tsx';
import { Help } from './Help.tsx';
import { PropEditor } from './PropEditor.tsx';
import { modalOpen } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

/** `help` is shown in the Help window; `mods` are the modifier keys listed under the tool's name; `section` groups the rail. */
export const TOOLS: { id: ToolId; label: string; icon: string; key: string; help: string; mods?: [string, string][]; section: string }[] = [
  { id: 'select', section: 'Select', label: 'Select', icon: 'select', key: 'V', help: 'Click anything to edit it on the right. Drag entities to move them.', mods: [['Alt', 'free move'], ['Del', 'delete']] },
  { id: 'erase', section: 'Select', label: 'Erase', icon: 'erase', key: 'X', help: 'Drag to remove props, floors, walls and entities. A prop goes before the floor under it.' },
  { id: 'room', section: 'Build', label: 'Room', icon: 'room', key: 'B', help: 'Drag a rectangle to make a walled room.', mods: [['R', 'turn tile']] },
  { id: 'floor', section: 'Build', label: 'Floor', icon: 'floor', key: 'F', help: 'Drag to lay floor.', mods: [['Shift', 'rectangle'], ['Ctrl', 'remove'], ['Alt', 'pick tile'], ['R', 'turn tile']] },
  { id: 'wall', section: 'Build', label: 'Wall', icon: 'wall', key: 'C', help: 'Drag between grid points, straight or diagonal. Walls can be see-through, for glass.', mods: [['Ctrl', 'remove']] },
  { id: 'block', section: 'Build', label: 'Block', icon: 'block', key: 'N', help: 'Drag to build solid blocks and pillars. Full-height, full-width block tops are walkable floors on the layer above.', mods: [['Shift', 'rectangle'], ['Ctrl', 'remove']] },
  { id: 'ramp', section: 'Build', label: 'Ramp', icon: 'ramp', key: 'G', help: 'Click to place a ramp up to the next layer.', mods: [['R', 'turn']] },
  { id: 'prop', section: 'Build', label: 'Props', icon: 'prop', key: 'O', help: 'Place scenery from the game, or build your own.', mods: [['Ctrl', 'remove']] },
  { id: 'paint', section: 'Look', label: 'Paint', icon: 'paint', key: 'P', help: 'Click any face to retexture it.', mods: [['Alt', 'pick tile']] },
  { id: 'light', section: 'Look', label: 'Light', icon: 'light', key: 'L', help: 'Brush light onto the floor.', mods: [['Shift', 'darken']] },
  { id: 'entity', section: 'Things', label: 'Entities', icon: 'entity', key: 'E', help: 'Click to place enemies, pickups, effects and more. Make your own in the Custom tab.', mods: [['Alt', 'free placement']] },
  { id: 'path', section: 'Things', label: 'Paths', icon: 'path', key: 'H', help: 'Click an entity, then click the points it walks to.', mods: [['Shift+click', 'add follower'], ['Ctrl+click', 'remove point']] },
  { id: 'interactive', section: 'Interactive', label: 'Interactive', icon: 'door', key: 'I', help: 'Everything that reacts to the player: doors, breakables, triggers, teleporters, exits and damage floors.' },
];

/** The Interactive tool's tabs, with their keys and modifier keys. */
export const INTERACTIVE_TABS: { id: InteractiveTab; label: string; key?: string; help: string; mods?: [string, string][] }[] = [
  { id: 'doors', label: 'Doors', key: 'J', help: 'Click a cell to place a door: rising, sliding or sinking, opening on touch, with a key or with a trigger.', mods: [['R', 'turn'], ['Ctrl', 'remove']] },
  { id: 'breakables', label: 'Breakables', help: 'Click a cell or a wall to make it breakable: it shatters to rubble or into a broken version of itself.', mods: [['Ctrl', 'remove']] },
  { id: 'triggers', label: 'Triggers', help: 'Pads that, when stepped on, open doors, break walls, retexture cells, play effects and reveal hidden entities.', mods: [['Ctrl', 'remove pad']] },
  { id: 'teleporter', label: 'Teleporter', key: 'T', help: 'Click the pad, then click where it sends the player.' },
  { id: 'exit', label: 'Exit', key: 'K', help: 'Click cells to mark the level exit. Click again to remove.' },
  { id: 'hazard', label: 'Hazard', help: 'Drag over cells to make them hurt.', mods: [['Ctrl', 'remove']] },
];

function Viewport({ visible }: { visible: boolean }) {
  const game = useGame();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const toolsRef = useRef<ToolController | null>(null);

  const project = useEditor((s) => s.project);
  const revision = useEditor((s) => s.revision);
  const libraryRevision = useEditor((s) => s.libraryRevision);
  const group = useEditor((s) => s.group);
  const layer = useEditor((s) => s.layer);
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const pendingTeleporter = useEditor((s) => s.pendingTeleporter);
  const documentId = useEditor((s) => s.documentId);
  const focus = useEditor((s) => s.focus);
  const selectedPath = useEditor((s) => s.selectedPath);
  const walkingPath = useEditor((s) => s.walkingPath);
  const tool = useEditor((s) => s.tool);
  const setView = useEditor((s) => s.setView);
  const setActive = useEditor((s) => s.setActive);

  useEffect(() => {
    const mapView = new MapView(canvasRef.current!, game);
    viewRef.current = mapView;
    toolsRef.current = new ToolController(mapView);
    return () => {
      mapView.dispose();
      viewRef.current = null;
      toolsRef.current = null;
    };
  }, [game]);

  useEffect(() => {
    if (project && viewRef.current) viewRef.current.sync({ project, documentId, revision, libraryRevision, group, layer, view, selection, pendingTeleporter, focus, selectedPath, walkingPath });
  }, [project, documentId, revision, libraryRevision, group, layer, view, selection, pendingTeleporter, focus, selectedPath, walkingPath, visible]);

  useEffect(() => {
    viewRef.current?.setGhost(null);
  }, [tool]);

  // Keyboard shortcuts for the builder.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (modalOpen()) return;
      const editor = useEditor.getState();
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) editor.redo();
          else editor.undo();
        } else if (key === 'y') {
          e.preventDefault();
          editor.redo();
        } else if (key === 's') {
          e.preventDefault();
          if (e.shiftKey) void editor.saveAs();
          else void editor.save();
        } else if (key === 'o') {
          e.preventDefault();
          void openMapFile();
        }
        return;
      }
      if (key === 'escape') {
        toolsRef.current?.cancel(true);
        editor.select(null);
        editor.setSelectedPath(null);
        editor.setWalkingPath(null);
        // A trigger action being placed is cancelled first; the next Esc leaves the tool.
        if (editor.tool === 'interactive' && editor.triggerPick !== 'pads') return editor.setTriggerPick('pads');
        editor.setTool('select');
      } else if (key === 'delete' || key === 'backspace') {
        const sel = editor.selection;
        if (!sel) return;
        editor.edit((p) => {
          const l = p.groups[sel.group]?.layers[sel.layer];
          if (!l) return;
          if (sel.kind === 'entity') removeEntity(l, sel.id);
          else if (sel.kind === 'wall') l.walls.delete(sel.key);
          else if (!removeTopOverlay(l, sel.x, sel.y)) {
            // A prop standing on the cell goes first; the next Delete clears the cell itself.
            const index = sel.y * l.width + sel.x;
            l.surfaces.delete(index);
            l.behaviors.delete(index);
            l.overlays.delete(index);
            l.cells[index] = 0;
          }
        });
        // A cell keeps its selection while props are left on it.
        const l = sel.kind === 'cell' ? useEditor.getState().project?.groups[sel.group]?.layers[sel.layer] : undefined;
        if (sel.kind !== 'cell' || !l?.overlays.has(sel.y * l.width + sel.x)) editor.select(null);
      } else if (key === 'r') toolsRef.current?.rotateBrush();
      else if (key === 'q') viewRef.current?.rotate(-1);
      else if (key === 'home') viewRef.current?.frameMap();
      else if (key === 'pageup') {
        e.preventDefault();
        editor.setActive(editor.group, editor.layer + 1);
      } else if (key === 'pagedown') {
        e.preventDefault();
        editor.setActive(editor.group, editor.layer - 1);
      } else if (key === 'f1') {
        e.preventDefault();
        editor.setHelpOpen(true);
      } else if (key === 'f5') {
        e.preventDefault();
        void playInGame();
      } else if (key === 'm') {
        editor.setBriefingOpen(true);
      } else {
        const match = TOOLS.find((t) => t.key.toLowerCase() === key);
        const tab = INTERACTIVE_TABS.find((t) => t.key?.toLowerCase() === key);
        if (match && !['w', 'a', 's', 'd'].includes(key)) editor.setTool(match.id);
        else if (tab) {
          editor.setTool('interactive');
          editor.setBrush({ interactive: tab.id });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  const layers = project?.groups[group]?.layers ?? [];
  return (
    <div className="viewport">
      <canvas ref={canvasRef} tabIndex={0} />
      <div className="layers" title="Layers (Page Up / Page Down)">
        {layers
          .map((l, i) => ({ l, i }))
          .reverse()
          .map(({ l, i }) => (
            <button key={i} className={`small ${i === layer ? 'active' : 'ghost'}`} onClick={() => setActive(group, i)} title={l.name}>
              {i + 1}
            </button>
          ))}
      </div>
      <div className="floating">
        <button className={`icon ghost ${view.lighting ? 'active' : ''}`} title="Lighting" onClick={() => setView({ lighting: !view.lighting })}>
          <Icon name="sun" />
        </button>
        <button className={`icon ghost ${view.grid ? 'active' : ''}`} title="Grid" onClick={() => setView({ grid: !view.grid })}>
          <Icon name="grid" />
        </button>
        <button className={`icon ghost ${view.entities ? 'active' : ''}`} title="Entities" onClick={() => setView({ entities: !view.entities })}>
          <Icon name="entities" />
        </button>
        <button className={`icon ghost ${view.labels ? 'active' : ''}`} title="Name tags" onClick={() => setView({ labels: !view.labels })}>
          <Icon name="tag" />
        </button>
        <button className={`icon ghost ${view.effects ? 'active' : ''}`} title="Animate effects" onClick={() => setView({ effects: !view.effects })}>
          <Icon name="spark" />
        </button>
        <button className={`icon ghost ${view.markers ? 'active' : ''}`} title="Markers" onClick={() => setView({ markers: !view.markers })}>
          <Icon name="marker" />
        </button>
        <button className={`icon ghost ${view.hideUpper ? '' : 'active'}`} title="Show the layers above" onClick={() => setView({ hideUpper: !view.hideUpper })}>
          <Icon name="layers" />
        </button>
        <button className="icon ghost" title="Rotate the view (Q)" onClick={() => viewRef.current?.rotate(1)}>
          <Icon name="rotate" />
        </button>
        <button className="icon ghost" title="Show the whole layer (Home)" onClick={() => viewRef.current?.frameMap()}>
          <Icon name="frame" />
        </button>
      </div>
      <div className="hud">Right-drag orbit · Middle-drag pan · Wheel zoom</div>
    </div>
  );
}

export function Build({ visible }: { visible: boolean }) {
  const project = useEditor((s) => s.project)!;
  const dirty = useEditor((s) => s.dirty);
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const save = useEditor((s) => s.save);
  const saveAs = useEditor((s) => s.saveAs);
  const filePath = useEditor((s) => s.filePath);
  const autosavedAt = useEditor((s) => s.autosavedAt);
  const status = useApp((s) => s.status);
  const editingModel = useEditor((s) => s.editingModel);
  const briefingOpen = useEditor((s) => s.briefingOpen);
  const setBriefingOpen = useEditor((s) => s.setBriefingOpen);
  const helpOpen = useEditor((s) => s.helpOpen);
  const setHelpOpen = useEditor((s) => s.setHelpOpen);
  const [busy, setBusy] = useState(false);
  // Revision subscription keeps the title in sync after renames.
  useEditor((s) => s.revision);

  const play = async () => {
    setBusy(true);
    await playInGame();
    setBusy(false);
  };

  return (
    <div className="build">
      <div className="topbar">
        <span className="title" title={filePath ?? 'Not saved to a file yet'}>
          {project.name}
          {dirty ? ' •' : ''}
        </span>
        <span className="faint" title={filePath ?? undefined} style={{ fontSize: 12 }}>
          {filePath ? fileName(filePath) : 'not saved yet'}
          {autosavedAt !== null && dirty ? ` · autosaved ${new Date(autosavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <span className="pill">{project.baseLevel}</span>
        <div className="sep" />
        <button className="icon ghost" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
          <Icon name="undo" />
        </button>
        <button className="icon ghost" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">
          <Icon name="redo" />
        </button>
        <div className="grow" />
        <button className="ghost" onClick={downloadProject} title="Download as .mhproject">
          <Icon name="export" /> Export
        </button>
        <button className="ghost" onClick={() => void openMapFile()} title="Open a map file (Ctrl+O)">
          <Icon name="folder" /> Open…
        </button>
        <button onClick={() => void save()} title={filePath ? `Save to ${filePath} (Ctrl+S)` : 'Save to a file (Ctrl+S)'}>
          <Icon name="save" /> Save
        </button>
        <button className="ghost" onClick={() => void saveAs()} title="Save to another file (Ctrl+Shift+S)">
          Save as…
        </button>
        <button className="icon ghost" onClick={() => setHelpOpen(true)} title="Help (F1)">
          <Icon name="help" />
        </button>
        <button className="primary" disabled={busy || !status?.game.runtime} onClick={() => void play()} title={status?.game.runtime ? 'Play (F5)' : 'Build the runtime first: npm run runtime:build'}>
          <Icon name="play" /> Play
        </button>
      </div>
      <div className="rail">
        {TOOLS.map((t, i) => (
          <div key={t.id} style={{ display: 'contents' }}>
            {i > 0 && t.section !== TOOLS[i - 1].section && <div className="gap" title={t.section} />}
            <button className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
              <Icon name={t.icon} size={20} />
            </button>
          </div>
        ))}
        {/* Not a tool: the briefing belongs to the map as a whole. */}
        <div className="gap" />
        <button className={briefingOpen ? 'active' : ''} onClick={() => setBriefingOpen(true)} title="Mission briefing (M)">
          <Icon name="mission" size={20} />
        </button>
      </div>
      <Catalog />
      <Viewport visible={visible} />
      <Inspector />
      <StatusBar />
      <ChecksRunner />
      {editingModel !== null && <PropEditor />}
      {briefingOpen && <Briefing />}
      {helpOpen && <Help />}
    </div>
  );
}
