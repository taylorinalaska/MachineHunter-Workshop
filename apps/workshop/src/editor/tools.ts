/** Turns pointer input on the map view into edits, with a live preview ("ghost") of what a tool will do. */
import { type CellDefinition, type Edge, PATH_ZONE, type ProjectLayer, type Surface, TEXTURE_MASKED, type TriggerAction, cellIndex, composeDefinition, doorPanelDefinition, inLayer, wallCells, CUSTOM_EFFECT_TYPE } from '@mh/core';
import { actionCell, ensureTrigger } from './triggers.ts';

/** The geometry a surface would have, for a placement ghost (textures do not matter there). */
const surfaceShape = (surface: Surface): CellDefinition => composeDefinition({ surface, walls: {}, diagonals: [] }, (tile) => tile);
const ALL_EDGES: Edge[] = ['north', 'east', 'south', 'west'];
import { givePath } from '../actions.ts';
import { useApp } from '../state/app.ts';
import { type ToolId, useEditor } from '../state/editor.ts';
import type { Ghost, MapView, PointerInfo, PointerPhase } from './mapview.ts';
import {
  PLAYER_START_TYPE,
  type PaintTarget,
  type Point,
  RAMP_DIRECTIONS,
  addEntity,
  addOverlayProp,
  addWalls,
  brushLight,
  buildRoom,
  edgeSegment,
  eraseCell,
  importProp,
  linkTeleporter,
  nearestPath,
  nearestWall,
  normalizeRect,
  paint,
  paintTargetAt,
  paintTargetFromHit,
  pathPointAt,
  placeBlock,
  placeRamp,
  rampFootprint,
  rectCells,
  rectPerimeter,
  removeEntity,
  removeTopOverlay,
  removeWalls,
  setBehavior,
  setFloor,
  setProp,
  snapEntity,
  snapPlacement,
  snapWallEnd,
  tileAt,
  wallRun,
  zonePoints,
} from './ops.ts';

const REMOVE_COLOR = 0xff5a6a;
const INVALID_COLOR = 0xff5a6a;

/** Cells on the straight line between two cells, inclusive, so fast drags leave no gaps. */
function cellsBetween(a: Point, b: Point): Point[] {
  const out: Point[] = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - x);
  const dy = Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1;
  const sy = y < b.y ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    out.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

const cellOf = (info: PointerInfo): Point => ({ x: Math.floor(info.x), y: Math.floor(info.y) });

/** A position kept inside the layer: a corner on its far edge is pulled back onto it. */
const clampTo = (layer: ProjectLayer, p: Point): Point => ({ x: Math.max(0, Math.min(layer.width * 256 - 1, p.x)), y: Math.max(0, Math.min(layer.height * 256 - 1, p.y)) });
const latticeOf = (info: PointerInfo, layer: ProjectLayer): Point => ({ x: Math.max(0, Math.min(layer.width, Math.round(info.x))), y: Math.max(0, Math.min(layer.height, Math.round(info.y))) });

export class ToolController {
  private dragging = false;
  private start: Point | null = null;
  private last: Point | null = null;
  private rectMode = false;
  private removing = false;
  private movingEntity: { layer: number; id: number; moved: boolean } | null = null;
  private movingPoint: { path: number; index: number; moved: boolean } | null = null;
  private exitMode: 'add' | 'remove' = 'add';
  /** Where the pointer last was, so a turned brush (R) shows at once. */
  private hovered: PointerInfo | null = null;

  constructor(private readonly view: MapView) {
    view.onPointer = this.handle;
    view.onHover = (info) => {
      useEditor.getState().setHover(info && info.inside ? cellOf(info) : null);
      if (!info) this.view.setGhost(null);
    };
  }

  /** Abandon whatever is in progress (Escape, or the tool changed). With `revert`, a drag's changes so far are undone too. */
  cancel(revert = false): void {
    const editor = useEditor.getState();
    if (editor.strokeOpen) {
      if (revert) editor.abortStroke();
      else editor.endStroke();
    }
    this.dragging = false;
    this.start = this.last = null;
    this.movingEntity = null;
    this.movingPoint = null;
    editor.setPendingTeleporter(null);
    this.view.setGhost(null);
  }

  private layer(): ProjectLayer | null {
    const { project, group, layer } = useEditor.getState();
    return project?.groups[group]?.layers[layer] ?? null;
  }

  private handle = (phase: PointerPhase, info: PointerInfo): void => {
    const editor = useEditor.getState();
    const layer = this.layer();
    if (!editor.project || !layer) return;
    if (phase === 'cancel') {
      this.cancel();
      return;
    }
    this.hovered = info;
    const handlers: Record<ToolId, (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer) => void> = {
      select: this.select,
      room: this.room,
      floor: this.floor,
      wall: this.wall,
      block: this.block,
      ramp: this.ramp,
      paint: this.paint,
      erase: this.erase,
      entity: this.entity,
      path: this.path,
      prop: this.prop,
      interactive: this.interactive,
      light: this.light,
    };
    try {
      handlers[editor.tool](phase, info, layer);
    } catch (error) {
      useApp.getState().toast((error as Error).message, 'error');
      this.cancel(true);
    }
    if (phase === 'up') {
      this.dragging = false;
      if (useEditor.getState().strokeOpen) useEditor.getState().endStroke();
    }
  };

  /* --------------------------------------------------------------- select */

  private select = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    if (phase === 'down') {
      const hit = this.view.pickEntity(info.clientX, info.clientY);
      if (hit) {
        if (hit.layer !== editor.layer) editor.setActive(editor.group, hit.layer);
        editor.select({ kind: 'entity', group: editor.group, layer: hit.layer, id: hit.id });
        this.movingEntity = { ...hit, moved: false };
        this.dragging = true;
        return;
      }
      this.movingEntity = null;
      // What is actually under the pointer: the top of a tall prop belongs to its own cell, not to the
      // floor cell its line of sight crosses.
      const surface = this.view.pickSurface(info.clientX, info.clientY);
      const wallAt = (x: number, y: number, reach: number) => nearestWall(layer, x, y, reach);
      const wall = surface ? (surface.face !== 'top' ? wallAt(surface.px, surface.py, 0.05) : null) : wallAt(info.x, info.y, 0.16);
      if (wall) editor.select({ kind: 'wall', group: editor.group, layer: editor.layer, key: wall.key });
      else if (surface && inLayer(layer, surface.x, surface.y)) editor.select({ kind: 'cell', group: editor.group, layer: editor.layer, x: surface.x, y: surface.y });
      else if (info.inside) editor.select({ kind: 'cell', group: editor.group, layer: editor.layer, ...cellOf(info) });
      else editor.select(null);
      return;
    }
    if (phase === 'move' && this.dragging && this.movingEntity) {
      const target = editor.project!.groups[editor.group].layers[this.movingEntity.layer];
      const entity = target.entities.find((e) => e.id === this.movingEntity!.id);
      if (!entity || this.movingEntity.layer !== editor.layer) return;
      const snapped = snapPlacement(info.x * 256, info.y * 256, info.alt);
      const x = Math.max(0, Math.min(target.width * 256 - 1, snapped.x));
      const y = Math.max(0, Math.min(target.height * 256 - 1, snapped.y));
      if (x === entity.x && y === entity.y) return;
      if (!this.movingEntity.moved) {
        editor.beginStroke();
        this.movingEntity.moved = true;
      }
      entity.x = x;
      entity.y = y;
      editor.touch();
    }
  };

  /* ----------------------------------------------------------------- room */

  private room = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = { x: Math.max(0, Math.min(layer.width - 1, Math.floor(info.x))), y: Math.max(0, Math.min(layer.height - 1, Math.floor(info.y))) };
    if (phase === 'down') {
      if (!info.inside) return;
      this.start = cell;
      this.dragging = true;
    }
    if (!this.dragging || !this.start) {
      this.view.setGhost(info.inside ? { cells: [cell] } : null);
      return;
    }
    const rect = normalizeRect(this.start, cell);
    if (phase === 'up') {
      const { floorTile, floorTurn, wallTile, wallHeight } = editor.brush;
      editor.edit(() => buildRoom(layer, rect, editor.brush.floorSeeThrough ? floorTile | TEXTURE_MASKED : floorTile, floorTurn, wallTile, wallHeight));
      this.start = null;
      this.view.setGhost(null);
      return;
    }
    this.view.setGhost({ cells: rectCells(layer, rect), walls: rectPerimeter(rect).map((w) => ({ ...w, height: editor.brush.wallHeight })) });
  };

  /* ---------------------------------------------------------------- floor */

  private floor = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    const { floorTile, floorTurn } = editor.brush;
    const apply = (cells: Point[]) => {
      let changed = false;
      for (const c of cells) changed = (this.removing ? eraseCell(layer, c.x, c.y) : setFloor(layer, c.x, c.y, editor.brush.floorSeeThrough ? floorTile | TEXTURE_MASKED : floorTile, floorTurn)) || changed;
      if (changed) editor.touch();
    };
    if (phase === 'down') {
      if (info.alt) {
        const tile = tileAt(layer, info.x, info.y);
        if (tile !== null) editor.setBrush({ floorTile: tile & 0x3fff, floorSeeThrough: (tile & TEXTURE_MASKED) !== 0 });
        return;
      }
      this.dragging = true;
      this.removing = info.ctrl;
      this.rectMode = info.shift;
      this.start = this.last = cell;
      if (!this.rectMode) {
        editor.beginStroke();
        apply([cell]);
      }
    }
    if (!this.dragging) {
      this.view.setGhost(info.inside ? { cells: [cell], cellColor: info.ctrl ? REMOVE_COLOR : undefined } : null);
      return;
    }
    if (this.rectMode && this.start) {
      const cells = rectCells(layer, normalizeRect(this.start, cell));
      if (phase === 'up') {
        editor.beginStroke();
        apply(cells);
        this.view.setGhost(null);
      } else this.view.setGhost({ cells, cellColor: this.removing ? REMOVE_COLOR : undefined });
      return;
    }
    if (phase === 'move' && this.last && (cell.x !== this.last.x || cell.y !== this.last.y)) {
      apply(cellsBetween(this.last, cell));
      this.last = cell;
    }
  };

  /* ----------------------------------------------------------------- wall */

  private wall = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    if (phase === 'down') {
      this.start = latticeOf(info, layer);
      this.removing = info.ctrl;
      this.dragging = true;
    }
    if (!this.dragging || !this.start) {
      // Hint at the lattice point a wall would start from.
      const p = latticeOf(info, layer);
      this.view.setGhost({ circle: { x: p.x, y: p.y, radius: 0.16 } });
      return;
    }
    const end = snapWallEnd(this.start, info.x, info.y);
    const run = wallRun(this.start, end).filter((s) => Math.min(s.x0, s.x1) >= 0 && Math.min(s.y0, s.y1) >= 0 && Math.max(s.x0, s.x1) <= layer.width && Math.max(s.y0, s.y1) <= layer.height);
    if (phase === 'up') {
      if (run.length) {
        const { wallTile, wallHeight, wallSeeThrough } = editor.brush;
        editor.edit(() => (this.removing ? removeWalls(layer, run) : addWalls(layer, run, wallSeeThrough ? wallTile | TEXTURE_MASKED : wallTile, wallHeight)));
      }
      this.start = null;
      this.view.setGhost(null);
      return;
    }
    this.view.setGhost({ walls: run.map((w) => ({ ...w, height: editor.brush.wallHeight })), wallColor: this.removing ? REMOVE_COLOR : undefined });
  };

  /* ---------------------------------------------------------------- block */

  private block = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    const { blockHeight, blockPillar, blockWidth, floorTile, wallTile } = editor.brush;
    const options = { height: blockHeight, topTile: floorTile, sideTile: wallTile, pillar: blockPillar, width: blockWidth, floorTile };
    const apply = (cells: Point[]) => {
      let changed = false;
      for (const c of cells) changed = (this.removing ? eraseCell(layer, c.x, c.y) : placeBlock(layer, c.x, c.y, options)) || changed;
      if (changed) editor.touch();
    };
    if (phase === 'down') {
      this.dragging = true;
      this.removing = info.ctrl;
      this.rectMode = info.shift;
      this.start = this.last = cell;
      if (!this.rectMode) {
        editor.beginStroke();
        apply([cell]);
      }
    }
    if (!this.dragging) {
      const shape = surfaceShape({ kind: 'block', height: blockHeight, topTile: floorTile, sides: Object.fromEntries(ALL_EDGES.map((e) => [e, wallTile])), pillar: blockPillar, width: blockWidth, floorTile: null });
      this.view.setGhost(info.inside ? { cells: [cell], cellColor: info.ctrl ? REMOVE_COLOR : undefined, shapes: info.ctrl ? undefined : [{ definition: shape, x: cell.x, y: cell.y }] } : null);
      return;
    }
    if (this.rectMode && this.start) {
      const cells = rectCells(layer, normalizeRect(this.start, cell));
      if (phase === 'up') {
        editor.beginStroke();
        apply(cells);
        this.view.setGhost(null);
      } else this.view.setGhost({ cells, cellColor: this.removing ? REMOVE_COLOR : undefined });
      return;
    }
    if (phase === 'move' && this.last && (cell.x !== this.last.x || cell.y !== this.last.y)) {
      apply(cellsBetween(this.last, cell));
      this.last = cell;
    }
  };

  /* ----------------------------------------------------------------- ramp */

  private ramp = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    const footprint = rampFootprint(cell.x, cell.y, editor.brush.rampDirection);
    const valid = footprint.every((p) => inLayer(layer, p.x, p.y));
    if (phase === 'down' && valid) {
      const { rampDirection, floorTile, wallTile, rampSides } = editor.brush;
      editor.edit((project) => placeRamp(project, editor.group, editor.layer, cell.x, cell.y, rampDirection, floorTile, rampSides ? wallTile : null));
      return;
    }
    const { rampDirection, floorTile } = editor.brush;
    const halves = footprint.map((p, i) => ({ definition: surfaceShape({ kind: 'ramp', direction: rampDirection, half: i ? 'upper' : 'lower', tile: floorTile, turn: 0, sides: {} }), x: p.x, y: p.y }));
    this.view.setGhost(info.inside ? { cells: footprint.filter((p) => inLayer(layer, p.x, p.y)), cellColor: valid ? undefined : INVALID_COLOR, shapes: valid ? halves : undefined } : null);
  };

  /** Turn the ramp tool (or the floor texture) a quarter turn. */
  rotateBrush(): void {
    const editor = useEditor.getState();
    if (editor.tool === 'interactive' && editor.brush.interactive === 'doors') {
      editor.setBrush({ doorFacing: editor.brush.doorFacing === 'ns' ? 'ew' : 'ns' });
    } else if (editor.tool === 'ramp') {
      const next = RAMP_DIRECTIONS[(RAMP_DIRECTIONS.indexOf(editor.brush.rampDirection) + 1) % 4];
      editor.setBrush({ rampDirection: next });
    } else {
      editor.setBrush({ floorTurn: ((editor.brush.floorTurn + 1) & 3) as 0 | 1 | 2 | 3 });
    }
    // Show the turned ghost where the pointer is, without waiting for it to move.
    if (this.hovered && !this.dragging) this.handle('move', this.hovered);
  }

  /* ---------------------------------------------------------------- paint */

  private paint = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    // The face actually under the pointer decides what is painted; bare ground falls back to the cell.
    const hit = this.view.pickSurface(info.clientX, info.clientY);
    const target: PaintTarget = hit ? paintTargetFromHit(layer, hit) : paintTargetAt(layer, info.x, info.y);
    const px = hit?.px ?? info.x;
    const py = hit?.py ?? info.y;
    // Upright faces take the wall tile, level ones the floor tile.
    const upright = target?.kind === 'wall' || (target?.kind === 'cell' && target.face !== 'top');
    if (phase === 'down') {
      if (info.alt) {
        const tile = tileAt(layer, px, py, target);
        if (tile !== null) editor.setBrush(upright ? { wallTile: tile & 0x3fff, wallSeeThrough: (tile & TEXTURE_MASKED) !== 0 } : { floorTile: tile & 0x3fff, floorSeeThrough: (tile & TEXTURE_MASKED) !== 0 });
        return;
      }
      this.dragging = true;
      editor.beginStroke();
    }
    if (this.dragging && (phase === 'down' || phase === 'move')) {
      if (paint(layer, target, upright ? editor.brush.wallTile : editor.brush.floorTile, px, py)) editor.touch();
      return;
    }
    if (target?.kind === 'cell' && target.face === 'top') this.view.setGhost({ cells: [{ x: target.x, y: target.y }], cellColor: 0xffd166 });
    else if (target?.kind === 'cell') {
      const surface = layer.surfaces.get(cellIndex(layer, target.x, target.y));
      const height = surface?.kind === 'block' ? surface.height : 1;
      this.view.setGhost({ walls: [{ ...edgeSegment(target.x, target.y, target.face as Edge), height }], wallColor: 0xffd166 });
    } else if (target?.kind === 'wall') {
      const w = layer.walls.get(target.key)!;
      this.view.setGhost({ walls: [{ ...w }], wallColor: 0xffd166 });
    } else this.view.setGhost(null);
  };

  /* ---------------------------------------------------------------- erase */

  private erase = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    const wall = nearestWall(layer, info.x, info.y, 0.2);
    if (phase === 'down') {
      this.dragging = true;
      this.last = null;
      editor.beginStroke();
      const hit = this.view.pickEntity(info.clientX, info.clientY);
      if (hit && hit.layer === editor.layer && removeEntity(layer, hit.id)) {
        editor.touch();
        return;
      }
    }
    if (this.dragging && (phase === 'down' || phase === 'move')) {
      // Once per cell in a drag: a prop standing on it goes first, and the floor under it stays.
      if (!wall && phase === 'move' && this.last && this.last.x === cell.x && this.last.y === cell.y) return;
      this.last = wall ? null : cell;
      const changed = wall ? layer.walls.delete(wall.key) : removeTopOverlay(layer, cell.x, cell.y) || eraseCell(layer, cell.x, cell.y);
      if (changed) editor.touch();
      return;
    }
    if (wall) this.view.setGhost({ walls: [{ ...wall.wall }], wallColor: REMOVE_COLOR });
    else this.view.setGhost(info.inside ? { cells: [cell], cellColor: REMOVE_COLOR } : null);
  };

  /* --------------------------------------------------------------- entity */

  private entity = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const { entityBehavior, entityWeapon } = editor.brush;
    // A custom effect is placed as a marker the runtime runs; it carries no stand.
    const effect = editor.brush.effect !== null && editor.project!.effects.some((f) => f.id === editor.brush.effect) ? editor.brush.effect : null;
    const entityType = effect !== null ? CUSTOM_EFFECT_TYPE : editor.brush.entityType;
    const entityWithBase = effect === null && editor.brush.entityWithBase;
    // Some scenery always stands on the same piece of level geometry; place the two together.
    const base = entityWithBase ? (useApp.getState().game?.entityBase(entityType, editor.project!.baseLevel) ?? null) : null;
    const cell = cellOf(info);
    const snapped = base ? { x: cell.x * 256 + base.offsetX, y: cell.y * 256 + base.offsetY } : clampTo(layer, snapPlacement(info.x * 256, info.y * 256, info.alt));
    if (phase === 'down' && info.inside) {
      let placedId = -1;
      const place = (project: NonNullable<typeof editor.project>) => {
        // An area has one player start: placing another moves it.
        if (entityType === PLAYER_START_TYPE) for (const l of project.groups[editor.group].layers) l.entities = l.entities.filter((e) => e.type !== PLAYER_START_TYPE);
        if (base) {
          setProp(layer, cell.x, cell.y, importProp(project, project.baseLevel, base.definitionId, base.definition));
          // One copy per stand.
          layer.entities = layer.entities.filter((e) => !(e.type === entityType && e.x >> 8 === cell.x && e.y >> 8 === cell.y));
        }
        const placed = addEntity(project, layer, entityType, snapped.x, snapped.y, effect !== null ? 0 : entityBehavior, effect !== null ? 0 : entityWeapon);
        if (effect !== null) placed.effect = effect;
        placedId = placed.id;
      };
      if (base) editor.editLibrary(place);
      else editor.edit(place);
      editor.select({ kind: 'entity', group: editor.group, layer: editor.layer, id: placedId });
      return;
    }
    this.view.setGhost(info.inside ? { sprite: { type: entityType, x: snapped.x, y: snapped.y }, cells: base ? [cell] : undefined, cellColor: 0xb08cf0 } : null);
  };

  /* ----------------------------------------------------------------- prop */

  private prop = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    if (phase === 'down') {
      if (!editor.brush.prop) {
        useApp.getState().toast('Pick a prop first.', 'info');
        return;
      }
      this.dragging = true;
      this.last = null;
      editor.beginStroke();
    }
    if (phase === 'down') this.removing = info.ctrl;
    if (this.dragging && (phase === 'down' || phase === 'move')) {
      if (this.last && this.last.x === cell.x && this.last.y === cell.y) return;
      this.last = cell;
      // Ctrl lifts the topmost stacked prop off; otherwise the prop goes on top of, or in place of, the cell's contents.
      const changed = this.removing ? removeTopOverlay(layer, cell.x, cell.y) : editor.brush.propMode === 'over' ? addOverlayProp(layer, cell.x, cell.y, editor.brush.prop) : setProp(layer, cell.x, cell.y, editor.brush.prop);
      if (changed) editor.touch();
      return;
    }
    const definition = editor.project?.definitions[editor.brush.prop];
    this.view.setGhost(info.inside ? { cells: [cell], cellColor: info.ctrl ? REMOVE_COLOR : 0xb08cf0, shapes: !info.ctrl && definition ? [{ definition, x: cell.x, y: cell.y }] : undefined, shapeColor: 0xb08cf0 } : null);
  };

  /* ----------------------------------------------------------------- path */

  /**
   * Click an entity to give it a path (or pick up the one it has), then click
   * where it should go. Points of the selected path can be dragged; Ctrl+click
   * removes one. A wander zone is dragged out as a rectangle instead.
   */
  private path = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const project = editor.project!;
    const ux = Math.max(0, Math.min(layer.width * 256 - 1, Math.round(info.x * 256)));
    const uy = Math.max(0, Math.min(layer.height * 256 - 1, Math.round(info.y * 256)));
    const snapped = snapEntity(ux, uy, info.alt);
    // A path is edited on the layer it belongs to.
    const selected = project.paths.find((p) => p.id === editor.selectedPath && p.group === editor.group && p.layer === editor.layer) ?? null;

    if (phase === 'down') {
      if (selected && selected.word0 !== PATH_ZONE) {
        const hit = pathPointAt(selected, ux, uy);
        if (hit >= 0) {
          if (info.ctrl) editor.edit(() => void selected.points.splice(hit, 1));
          else {
            this.movingPoint = { path: selected.id, index: hit, moved: false };
            this.dragging = true;
          }
          return;
        }
      }
      const picked = this.view.pickEntity(info.clientX, info.clientY);
      const entity = picked && picked.layer === editor.layer ? layer.entities.find((e) => e.id === picked.id) : undefined;
      if (entity) {
        editor.select({ kind: 'entity', group: editor.group, layer: editor.layer, id: entity.id });
        if (entity.pathId !== null && project.paths.some((p) => p.id === entity.pathId)) {
          editor.setSelectedPath(entity.pathId);
          return;
        }
        if (selected && info.shift) {
          // Shift+click: send another entity along the path being edited.
          editor.edit(() => void (entity.pathId = selected.id));
          return;
        }
        givePath(editor.group, editor.layer, entity.id);
        return;
      }
      if (selected) {
        if (!info.inside) return;
        if (selected.word0 === PATH_ZONE) {
          this.start = { x: ux, y: uy };
          this.dragging = true;
          return;
        }
        // Two stops in the same place would make the follower pause there for no reason.
        const last = selected.points[selected.points.length - 1];
        if (last && last.x === snapped.x && last.y === snapped.y) return;
        editor.edit(() => void selected.points.push({ x: snapped.x, y: snapped.y, tail0: 0, tail1: 0 }));
        return;
      }
      const other = nearestPath(project, editor.group, editor.layer, ux, uy);
      if (other) editor.setSelectedPath(other.id);
      else useApp.getState().toast('Click an entity first.', 'info');
      return;
    }

    if (phase === 'move' && this.dragging && this.movingPoint && selected) {
      const point = selected.points[this.movingPoint.index];
      if (!point || (point.x === snapped.x && point.y === snapped.y)) return;
      if (!this.movingPoint.moved) {
        editor.beginStroke();
        this.movingPoint.moved = true;
      }
      point.x = snapped.x;
      point.y = snapped.y;
      editor.touch();
      return;
    }
    if (this.dragging && this.start && selected?.word0 === PATH_ZONE) {
      const from = this.start;
      const cells = rectCells(layer, normalizeRect({ x: from.x >> 8, y: from.y >> 8 }, { x: ux >> 8, y: uy >> 8 }));
      if (phase === 'up') {
        // Keep the corners half a cell inside, so the places it walks to are cell centers.
        const x0 = (Math.min(from.x, ux) >> 8) * 256 + 128;
        const x1 = (Math.max(from.x, ux) >> 8) * 256 + 128;
        const y0 = (Math.min(from.y, uy) >> 8) * 256 + 128;
        const y1 = (Math.max(from.y, uy) >> 8) * 256 + 128;
        editor.edit(() => void (selected.points = zonePoints({ x: x0, y: y0 }, { x: x1, y: y1 })));
        this.start = null;
        this.view.setGhost(null);
      } else this.view.setGhost({ cells, cellColor: 0xffb347 });
      return;
    }
    if (phase === 'up') {
      this.movingPoint = null;
      return;
    }
    this.view.setGhost(info.inside && selected && selected.word0 !== PATH_ZONE ? { circle: { x: snapped.x / 256, y: snapped.y / 256, radius: 0.16 } } : null);
  };

  /* ----------------------------------------------------------- teleporter */

  private teleporter = (phase: PointerPhase, info: PointerInfo, _layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    if (phase === 'down' && info.inside) {
      const here = { group: editor.group, layer: editor.layer, ...cell };
      const pending = editor.pendingTeleporter;
      if (!pending) {
        editor.setPendingTeleporter(here);
        useApp.getState().toast('Now click the destination.', 'info');
        return;
      }
      editor.edit((project) => linkTeleporter(project, pending, here));
      editor.setPendingTeleporter(null);
      return;
    }
    this.view.setGhost(info.inside ? { cells: [cell], cellColor: 0x38d6e8 } : null);
  };

  /* ----------------------------------------------------------------- exit */

  private exit = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    if (phase === 'down' && info.inside) {
      this.dragging = true;
      this.last = null;
      this.exitMode = layer.behaviors.get(cellIndex(layer, cell.x, cell.y))?.kind === 'exit' ? 'remove' : 'add';
      editor.beginStroke();
    }
    if (this.dragging && (phase === 'down' || phase === 'move') && info.inside) {
      if (this.last && this.last.x === cell.x && this.last.y === cell.y) return;
      this.last = cell;
      if (setBehavior(layer, cell.x, cell.y, this.exitMode === 'add' ? { kind: 'exit' } : null)) editor.touch();
      return;
    }
    this.view.setGhost(info.inside ? { cells: [cell], cellColor: 0x9be15d } : null);
  };

  /* ---------------------------------------------------------------- doors */

  private door = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    if (phase === 'down' && info.inside) {
      const { doorLock, doorFacing, doorStyle, wallTile } = editor.brush;
      const index = cellIndex(layer, cell.x, cell.y);
      if (info.ctrl) {
        if (layer.behaviors.get(index)?.kind === 'door') editor.edit(() => void setBehavior(layer, cell.x, cell.y, null));
        return;
      }
      // A door keeps whatever the cell already shows (or nothing).
      editor.edit(() => void setBehavior(layer, cell.x, cell.y, { kind: 'door', lock: doorLock, tile: wallTile, facing: doorFacing, style: doorStyle }));
      editor.select({ kind: 'cell', group: editor.group, layer: editor.layer, x: cell.x, y: cell.y });
      return;
    }
    const { doorFacing, doorStyle, wallTile } = editor.brush;
    const panel = !info.ctrl ? [{ definition: doorPanelDefinition(wallTile, doorFacing, doorStyle), x: cell.x, y: cell.y }] : undefined;
    this.view.setGhost(info.inside ? { cells: [cell], cellColor: info.ctrl ? REMOVE_COLOR : 0x6fb7ff, shapes: panel, shapeColor: 0x6fb7ff } : null);
  };

  /* ---------------------------------------------------------- interactive */

  /** The Interactive tool: the open tab decides what a click does. */
  private interactive = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const handlers = { doors: this.door, breakables: this.breakable, triggers: this.trigger, teleporter: this.teleporter, exit: this.exit, hazard: this.hazard };
    handlers[useEditor.getState().brush.interactive](phase, info, layer);
  };

  /**
   * The cell a click acts on for breaking and retexturing: near a wall, the
   * cell the wall is drawn in (so breaking it changes that wall); else the
   * face under the pointer, so a tall block's top is its own cell.
   */
  private actedCell(info: PointerInfo, layer: ProjectLayer): { x: number; y: number; wall?: { x0: number; y0: number; x1: number; y1: number; height: number } } | null {
    const editor = useEditor.getState();
    const near = nearestWall(layer, info.x, info.y, 0.18);
    if (near && editor.project) {
      const owner = wallCells(layer, editor.project.definitions).get(near.key);
      if (owner !== undefined) return { x: owner % layer.width, y: Math.floor(owner / layer.width), wall: near.wall };
    }
    const surface = this.view.pickSurface(info.clientX, info.clientY);
    if (surface && inLayer(layer, surface.x, surface.y)) return { x: surface.x, y: surface.y };
    return info.inside ? cellOf(info) : null;
  }

  private breakable = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const target = this.actedCell(info, layer);
    if (phase === 'down' && target) {
      const index = cellIndex(layer, target.x, target.y);
      const { breakToughness, breakEffect, breakResult, floorTile, wallTile } = editor.brush;
      if (info.ctrl) {
        if (layer.behaviors.get(index)?.kind === 'breakable') editor.edit(() => void layer.behaviors.delete(index));
        return;
      }
      editor.edit(() => void layer.behaviors.set(index, { kind: 'breakable', toughness: breakToughness, effect: breakEffect, leaves: floorTile, result: breakResult, ...(breakResult === 'broken' ? { broken: wallTile } : {}) }));
      editor.select({ kind: 'cell', group: editor.group, layer: editor.layer, x: target.x, y: target.y });
      return;
    }
    const color = info.ctrl ? REMOVE_COLOR : 0xff8a5c;
    this.view.setGhost(target ? { cells: [target], cellColor: color, walls: target.wall ? [target.wall] : undefined, wallColor: color } : null);
  };

  private hazard = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const cell = cellOf(info);
    if (phase === 'down' && info.inside) {
      this.dragging = true;
      this.last = null;
      this.removing = info.ctrl;
      editor.beginStroke();
    }
    if (this.dragging && (phase === 'down' || phase === 'move') && info.inside) {
      if (this.last && this.last.x === cell.x && this.last.y === cell.y) return;
      this.last = cell;
      const index = cellIndex(layer, cell.x, cell.y);
      if (this.removing) {
        if (layer.behaviors.get(index)?.kind === 'hazard') layer.behaviors.delete(index);
      } else layer.behaviors.set(index, { kind: 'hazard', damage: editor.brush.hazardDamage });
      editor.touch();
      return;
    }
    this.view.setGhost(info.inside ? { cells: [cell], cellColor: info.ctrl ? REMOVE_COLOR : 0xff5c5c } : null);
  };

  /**
   * Triggers: lay or lift the open trigger's pads, or place a new action
   * (the tab's "Add" buttons choose which), then go back to pads.
   */
  private trigger = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const project = editor.project!;
    const channel = editor.trigger;
    const cell = cellOf(info);
    const pick = editor.triggerPick;
    if (channel === null) {
      if (phase === 'down') useApp.getState().toast('Make a trigger first.', 'info');
      this.view.setGhost(info.inside ? { cells: [cell], cellColor: 0xffd166 } : null);
      return;
    }
    const here = { group: editor.group, layer: editor.layer };
    if (pick === 'pads') {
      if (phase === 'down' && info.inside) {
        this.dragging = true;
        this.last = null;
        const b = layer.behaviors.get(cellIndex(layer, cell.x, cell.y));
        this.removing = info.ctrl || (b?.kind === 'switch' && b.channel === channel);
        editor.beginStroke();
      }
      if (this.dragging && (phase === 'down' || phase === 'move') && info.inside) {
        if (this.last && this.last.x === cell.x && this.last.y === cell.y) return;
        this.last = cell;
        const index = cellIndex(layer, cell.x, cell.y);
        const b = layer.behaviors.get(index);
        if (this.removing) {
          if (b?.kind === 'switch' && b.channel === channel) layer.behaviors.delete(index);
        } else {
          // A pad is stepped on, so it needs a floor.
          if (!layer.surfaces.has(index)) setFloor(layer, cell.x, cell.y, editor.brush.floorTile, editor.brush.floorTurn);
          layer.behaviors.set(index, { kind: 'switch', channel });
          ensureTrigger(project, channel);
        }
        editor.touch();
        return;
      }
    } else if (phase === 'down') {
      let action: TriggerAction | null = null;
      if (pick === 'break' || pick === 'retexture') {
        const target = this.actedCell(info, layer);
        if (target) {
          const surface = this.view.pickSurface(info.clientX, info.clientY);
          action =
            pick === 'break'
              ? { kind: 'break', ...here, x: target.x, y: target.y }
              : { kind: 'retexture', ...here, x: target.x, y: target.y, tile: editor.brush.wallTile, faces: !target.wall && surface?.face === 'top' ? 'floor' : 'walls' };
        }
      } else if (pick === 'effect' && info.inside) {
        const effect = project.effects[0];
        if (!effect) useApp.getState().toast('Make an effect first: Entities tool, Custom tab.', 'info');
        else {
          const p = snapPlacement(info.x * 256, info.y * 256, info.alt);
          action = { kind: 'effect', ...here, x: Math.round(p.x), y: Math.round(p.y), effect: effect.id };
        }
      } else if (pick === 'reveal') {
        const hit = this.view.pickEntity(info.clientX, info.clientY);
        if (hit && hit.layer === editor.layer) action = { kind: 'reveal', ...here, entity: hit.id };
        else useApp.getState().toast('Click an entity.', 'info');
      }
      if (action) {
        const chosen = action;
        editor.edit((p) => {
          ensureTrigger(p, channel).actions.push(chosen);
          // An entity to reveal has to start hidden.
          if (chosen.kind === 'reveal') {
            const e = p.groups[chosen.group].layers[chosen.layer].entities.find((x) => x.id === chosen.entity);
            if (e) e.disabled = true;
          }
        });
        editor.setTriggerPick('pads');
      }
      return;
    }
    // Show the trigger: its pads, what it acts on, and the cell under the pointer.
    const marks: { x: number; y: number; color: number }[] = [];
    layer.behaviors.forEach((b, index) => {
      if (b.kind === 'switch' && b.channel === channel) marks.push({ x: index % layer.width, y: Math.floor(index / layer.width), color: 0xffd166 });
    });
    for (const a of project.triggers.find((t) => t.channel === channel)?.actions ?? []) {
      const c = a.group === editor.group && a.layer === editor.layer ? actionCell(a, project) : null;
      if (c) marks.push({ ...c, color: 0xff8a5c });
    }
    const acted = pick === 'break' || pick === 'retexture' ? this.actedCell(info, layer) : null;
    const target = acted ?? (info.inside ? cell : null);
    this.view.setGhost({ marks, cells: target ? [target] : undefined, cellColor: pick === 'pads' ? (info.ctrl ? REMOVE_COLOR : 0xffd166) : 0xff8a5c, walls: acted?.wall ? [acted.wall] : undefined, wallColor: 0xff8a5c });
  };

  /* ---------------------------------------------------------------- light */

  private light = (phase: PointerPhase, info: PointerInfo, layer: ProjectLayer): void => {
    const editor = useEditor.getState();
    const { lightLevel, lightRadius } = editor.brush;
    if (phase === 'down') {
      this.dragging = true;
      editor.beginStroke();
    }
    if (this.dragging && (phase === 'down' || phase === 'move')) {
      // Shift darkens instead of applying the brush level.
      if (brushLight(layer, info.x, info.y, lightRadius, info.shift ? 2 : lightLevel, 0.35)) editor.touch();
    }
    this.view.setGhost({ circle: { x: info.x, y: info.y, radius: lightRadius } });
  };
}
