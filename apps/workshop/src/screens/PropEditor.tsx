/**
 * The prop builder: put boxes, wedges, pyramids, roofs, cylinders and cones
 * together inside one map cell, size and turn them, and texture each face.
 * The model is compiled with the same code the map compiler uses, so the
 * view shows the geometry and textures the game will draw.
 */
import { DEFAULT_SIDES, PART_SHAPES, PROP_FACE_WARNING, PROP_STEPS, type PartShape, type PropFace, type PropModel, type PropPart, ProjectComposer, buildPropDefinition, clampPart, faceNames, meshPropModel, turnPart } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildLayerGeometry } from '../editor/layer-mesh.ts';
import { deleteModel } from '../editor/ops.ts';
import { PROP_PRESETS, presetParts } from '../editor/prop-presets.ts';
import { makePaletteTexture, makeTerrainMaterial, makeTileTexture } from '../editor/terrain-material.ts';
import { useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { Field, NumberInput, TileCanvas } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

const S = PROP_STEPS;

const SHAPE_LABELS: Record<PartShape, string> = { box: 'Box', wedge: 'Wedge', pyramid: 'Pyramid', roof: 'Roof', cylinder: 'Cylinder', cone: 'Cone' };

/** Little drawings of the shapes, on a 24x24 grid. */
const SHAPE_ICONS: Record<PartShape, string> = {
  box: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  wedge: 'M3 19h18L21 7zM21 7l-4-2-14 14',
  pyramid: 'M12 3L3 18l9 3 9-3zM12 3v18',
  roof: 'M3 16l5-9h8l5 9zM8 7l-1 9M16 7l1 9',
  cylinder: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6',
  cone: 'M12 3L5 18c0 1.7 3.1 3 7 3s7-1.3 7-3z',
};

function ShapeIcon({ shape, size = 22 }: { shape: PartShape; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true">
      <path d={SHAPE_ICONS[shape]} />
    </svg>
  );
}

/** Sides of a part's box a handle can pull. */
type Handle = 'east' | 'west' | 'south' | 'north' | 'top';
const HANDLES: Handle[] = ['east', 'west', 'south', 'north', 'top'];

/** What the view asks the builder to do. */
interface ViewEvents {
  select(part: number | null): void;
  paint(part: number, face: number, whole: boolean): void;
  /** A drag on a part starts; `change` is then called as it moves and `end` when it stops. */
  begin(): void;
  change(part: number, mutate: (p: PropPart) => void): void;
  end(): void;
}

type Drag =
  | { kind: 'orbit'; x: number; y: number; moved: boolean; button: number; hit: { part: number; face: number } | null; shift: boolean }
  | { kind: 'move'; part: number; start: PropPart; plane: THREE.Plane; from: THREE.Vector3; vertical: boolean; moved: boolean; x: number; y: number; started: boolean }
  | { kind: 'resize'; part: number; start: PropPart; handle: Handle; origin: THREE.Vector3; axis: THREE.Vector3; from: number; started: boolean };

/** Scene position of a point given in steps (x east, y south, z up). */
const at = (x: number, y: number, z: number) => new THREE.Vector3(x / S, z / S, y / S);

/** Orbiting view of one model, with picking, moving and resizing. Kept outside React so pointer handling stays cheap. */
class PropView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
  private readonly raycaster = new THREE.Raycaster();
  private mesh: THREE.Mesh | null = null;
  private faces: PropFace[] = [];
  private parts: PropPart[] = [];
  private readonly selectionBox: THREE.LineSegments;
  private readonly hoverBox: THREE.LineSegments;
  private readonly handles: THREE.Mesh[] = [];
  private tileTexture: THREE.DataArrayTexture | null = null;
  private readonly paletteTexture: THREE.DataTexture;
  private yaw = Math.PI * 0.22;
  private pitch = Math.PI * 0.27;
  private distance = 3.1;
  private drag: Drag | null = null;
  private readonly observer: ResizeObserver;
  selected: number | null = null;
  painting = false;
  events: ViewEvents | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    palette: Parameters<typeof makePaletteTexture>[0],
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x14171c);
    this.paletteTexture = makePaletteTexture(palette);

    // The cell's footprint: a grid of steps on the ground (quarters brighter) and a faint box for the layer.
    const fine: number[] = [];
    const coarse: number[] = [];
    for (let i = 0; i <= S; i++) (i % 4 ? fine : coarse).push(i / S, 0, 0, i / S, 0, 1, 0, 0, i / S, 1, 0, i / S);
    const lines = (points: number[], opacity: number) => new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), new THREE.LineBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity }));
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.14 }));
    box.position.set(0.5, 0.5, 0.5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x1b2028, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0.5, -0.002, 0.5);
    // North is marked so turning makes sense.
    const north = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 3), new THREE.MeshBasicMaterial({ color: 0x6fb7ff }));
    north.rotation.x = -Math.PI / 2;
    north.position.set(0.5, 0, -0.08);
    this.selectionBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false }));
    this.selectionBox.renderOrder = 3;
    this.hoverBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthTest: false }));
    this.hoverBox.renderOrder = 2;
    this.selectionBox.visible = this.hoverBox.visible = false;
    for (const handle of HANDLES) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false }));
      mesh.renderOrder = 4;
      mesh.userData.handle = handle;
      mesh.visible = false;
      this.handles.push(mesh);
    }
    this.scene.add(floor, lines(fine, 0.12), lines(coarse, 0.35), box, north, this.selectionBox, this.hoverBox, ...this.handles);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointerleave', this.leave);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.prevent);
  }

  dispose(): void {
    this.observer.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.down);
    c.removeEventListener('pointermove', this.move);
    c.removeEventListener('pointerup', this.up);
    c.removeEventListener('pointerleave', this.leave);
    c.removeEventListener('wheel', this.wheel);
    c.removeEventListener('contextmenu', this.prevent);
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
    this.tileTexture?.dispose();
    this.paletteTexture.dispose();
    // The context is left alone: in development React mounts this twice on the same canvas,
    // and a context that was forced lost cannot be used again.
    this.renderer.dispose();
  }

  /** Show a compiled model. `faces` lists its faces in the definition's order; `tiles` is the bank they index into. */
  setModel(definition: Parameters<typeof buildLayerGeometry>[0]['definitions'][number], tiles: readonly Uint8Array[], faces: PropFace[], parts: PropPart[]): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.tileTexture?.dispose();
    this.tileTexture = makeTileTexture(tiles);
    const geometry = buildLayerGeometry({ width: 1, height: 1, originX: 0, originY: 0, elevation: 0, cells: Uint16Array.of(1), lighting: new Uint8Array(8).fill(22), definitions: [definition, definition], tileCount: tiles.length });
    const material = makeTerrainMaterial({ tiles: this.tileTexture, palette: this.paletteTexture });
    material.uniforms.uFullbright.value = 1;
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
    this.faces = faces;
    this.parts = parts;
    this.showSelection();
  }

  setSelected(index: number | null): void {
    this.selected = index;
    this.showSelection();
  }

  private placeBox(box: THREE.LineSegments, p: PropPart): void {
    box.scale.set(p.w / S, p.h / S, p.d / S);
    box.position.copy(at(p.x + p.w / 2, p.y + p.d / 2, p.z + p.h / 2));
    box.visible = true;
  }

  private handlePoint(p: PropPart, handle: Handle): THREE.Vector3 {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.d / 2;
    const cz = p.z + p.h / 2;
    switch (handle) {
      case 'east':
        return at(p.x + p.w, cy, cz);
      case 'west':
        return at(p.x, cy, cz);
      case 'south':
        return at(cx, p.y + p.d, cz);
      case 'north':
        return at(cx, p.y, cz);
      default:
        return at(cx, cy, p.z + p.h);
    }
  }

  private showSelection(): void {
    const p = this.selected !== null ? this.parts[this.selected] : undefined;
    this.selectionBox.visible = false;
    for (const h of this.handles) h.visible = false;
    if (p) {
      this.placeBox(this.selectionBox, p);
      if (!this.painting)
        for (const h of this.handles) {
          h.position.copy(this.handlePoint(p, h.userData.handle as Handle));
          h.visible = true;
        }
    }
    this.render();
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render(): void {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(0.5 + this.distance * cp * Math.sin(this.yaw), 0.4 + this.distance * Math.sin(this.pitch), 0.5 + this.distance * cp * Math.cos(this.yaw));
    this.camera.lookAt(0.5, 0.4, 0.5);
    this.renderer.render(this.scene, this.camera);
  }

  /** The map direction (in steps) that screen right and screen up point to most, for the arrow keys. */
  screenAxes(): { right: [number, number]; up: [number, number] } {
    const right: [number, number] = [Math.cos(this.yaw), -Math.sin(this.yaw)];
    const snap = (v: [number, number]): [number, number] => (Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]), 0] : [0, Math.sign(v[1])]);
    const r = snap(right);
    return { right: r, up: [r[1], -r[0]] };
  }

  private ray(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
  }

  /** The part face under the pointer, and where it was hit. */
  private pick(event: PointerEvent): { part: number; face: number; point: THREE.Vector3 } | null {
    this.ray(event);
    const hit = this.mesh ? this.raycaster.intersectObject(this.mesh, false)[0] : undefined;
    // Each face is a quad: two triangles in the mesh, in the definition's order.
    const face = hit?.faceIndex != null ? this.faces[hit.faceIndex >> 1] : undefined;
    return face && hit ? { part: face.part, face: face.face, point: hit.point.clone() } : null;
  }

  private pickHandle(event: PointerEvent): Handle | null {
    this.ray(event);
    const visible = this.handles.filter((h) => h.visible);
    const hit = this.raycaster.intersectObjects(visible, false)[0];
    return hit ? (hit.object.userData.handle as Handle) : null;
  }

  private prevent = (e: Event) => e.preventDefault();

  private down = (event: PointerEvent): void => {
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events have no pointer to capture */
    }
    const part = this.selected !== null ? this.parts[this.selected] : undefined;
    if (event.button === 0 && part && !this.painting) {
      const handle = this.pickHandle(event);
      if (handle) {
        const origin = this.handlePoint(part, handle);
        const axis = handle === 'top' ? new THREE.Vector3(0, 1, 0) : handle === 'east' || handle === 'west' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        this.drag = { kind: 'resize', part: this.selected!, start: { ...part }, handle, origin, axis, from: this.alongAxis(origin, axis), started: false };
        return;
      }
    }
    const hit = event.button === 0 ? this.pick(event) : null;
    if (hit && !this.painting && hit.part === this.selected && part) {
      // Dragging the selected part moves it: across the ground, or up and down with Shift.
      const vertical = event.shiftKey;
      const normal = vertical ? new THREE.Vector3().subVectors(this.camera.position, hit.point).setY(0).normalize() : new THREE.Vector3(0, 1, 0);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
      this.drag = { kind: 'move', part: hit.part, start: { ...part }, plane, from: hit.point, vertical, moved: false, x: event.clientX, y: event.clientY, started: false };
      return;
    }
    this.drag = { kind: 'orbit', x: event.clientX, y: event.clientY, moved: false, button: event.button, hit: hit ? { part: hit.part, face: hit.face } : null, shift: event.shiftKey };
  };

  /** Where along an axis through `origin` the pointer ray passes closest. */
  private alongAxis(origin: THREE.Vector3, axis: THREE.Vector3): number {
    const ray = this.raycaster.ray;
    const w0 = new THREE.Vector3().subVectors(origin, ray.origin);
    const b = axis.dot(ray.direction);
    const d = axis.dot(w0);
    const e = ray.direction.dot(w0);
    const denom = 1 - b * b;
    return denom < 1e-6 ? 0 : (b * e - d) / denom;
  }

  private move = (event: PointerEvent): void => {
    let drag = this.drag;
    // A release that never arrived (outside the window, a lost capture) ends the drag.
    if (drag && event.buttons === 0) {
      if ((drag.kind === 'move' || drag.kind === 'resize') && drag.started) this.events?.end();
      this.drag = drag = null;
    }
    if (!drag) {
      const hit = this.pick(event);
      if (hit && hit.part !== this.selected && this.parts[hit.part]) this.placeBox(this.hoverBox, this.parts[hit.part]);
      else this.hoverBox.visible = false;
      this.canvas.style.cursor = this.pickHandle(event) ? 'grab' : hit ? 'pointer' : 'crosshair';
      this.render();
      return;
    }
    this.hoverBox.visible = false;
    if (drag.kind === 'resize') {
      this.ray(event);
      const steps = Math.round((this.alongAxis(drag.origin, drag.axis) - drag.from) * S);
      if (!drag.started) {
        if (!steps) return;
        drag.started = true;
        this.events?.begin();
      }
      const s = drag.start;
      this.events?.change(drag.part, (p) => {
        if (drag.handle === 'east') p.w = Math.max(1, Math.min(S - s.x, s.w + steps));
        else if (drag.handle === 'south') p.d = Math.max(1, Math.min(S - s.y, s.d + steps));
        else if (drag.handle === 'top') p.h = Math.max(1, Math.min(S - s.z, s.h + steps));
        else if (drag.handle === 'west') {
          const x = Math.max(0, Math.min(s.x + s.w - 1, s.x + steps));
          [p.x, p.w] = [x, s.x + s.w - x];
        } else {
          const y = Math.max(0, Math.min(s.y + s.d - 1, s.y + steps));
          [p.y, p.d] = [y, s.y + s.d - y];
        }
      });
      return;
    }
    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 4) return;
      drag.moved = true;
      this.ray(event);
      const point = this.raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (!point) return;
      const delta = point.sub(drag.from).multiplyScalar(S);
      const dx = drag.vertical ? 0 : Math.round(delta.x);
      const dy = drag.vertical ? 0 : Math.round(delta.z);
      const dz = drag.vertical ? Math.round(delta.y) : 0;
      if (!drag.started) {
        if (!dx && !dy && !dz) return;
        drag.started = true;
        this.events?.begin();
      }
      const s = drag.start;
      this.events?.change(drag.part, (p) => {
        p.x = Math.max(0, Math.min(S - p.w, s.x + dx));
        p.y = Math.max(0, Math.min(S - p.d, s.y + dy));
        p.z = Math.max(0, Math.min(S - p.h, s.z + dz));
      });
      return;
    }
    // Any other drag turns the view; a click that does not travel selects or paints.
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 5) return;
    drag.moved = true;
    this.yaw -= (event.clientX - drag.x) * 0.008;
    this.pitch = Math.max(0.08, Math.min(1.5, this.pitch + (event.clientY - drag.y) * 0.006));
    drag.x = event.clientX;
    drag.y = event.clientY;
    this.render();
  };

  private up = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if ((drag.kind === 'move' || drag.kind === 'resize') && drag.started) return this.events?.end();
    if (drag.kind === 'move') {
      // A click on the selected part: paint mode aside, nothing to do.
      return;
    }
    if (drag.kind !== 'orbit' || drag.moved || drag.button !== 0) return;
    if (this.painting) {
      if (drag.hit) this.events?.paint(drag.hit.part, drag.hit.face, drag.shift);
    } else this.events?.select(drag.hit ? drag.hit.part : null);
  };

  private leave = (): void => {
    if (this.drag) return;
    this.hoverBox.visible = false;
    this.render();
  };

  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.distance = Math.max(1.2, Math.min(7, this.distance * Math.exp(event.deltaY * 0.0012)));
    this.render();
  };
}

/** Where a copy of a part goes: on top of it if there is room, else beside it. */
function copyOf(p: PropPart): PropPart {
  const copy: PropPart = { ...p, ...(p.faces ? { faces: { ...p.faces } } : {}) };
  if (p.z + 2 * p.h <= S) copy.z = p.z + p.h;
  else if (p.x + 2 * p.w <= S) copy.x = p.x + p.w;
  else if (p.y + 2 * p.d <= S) copy.y = p.y + p.d;
  else copy.x = Math.min(S - p.w, p.x + 1);
  return copy;
}

export function PropEditor() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const modelId = useEditor((s) => s.editingModel);
  const close = () => useEditor.getState().setEditingModel(null);
  const editLibrary = useEditor((s) => s.editLibrary);
  const libraryRevision = useEditor((s) => s.libraryRevision);
  const setBrush = useEditor((s) => s.setBrush);
  const model = project.models.find((m) => m.id === modelId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<PropView | null>(null);
  const [selected, setSelected] = useState<number | null>(model?.parts.length ? model.parts.length - 1 : null);
  const [painting, setPainting] = useState(false);
  const [tile, setTile] = useState(model?.tile ?? 0);
  const level = project.baseLevel;
  const part = selected !== null ? model?.parts[selected] : undefined;

  // The same compile the map goes through, so textures are baked exactly as they will be in the game.
  const compiled = useMemo(() => {
    if (!model) return null;
    const composer = new ProjectComposer(project, { preview: true, opaqueZeroIndex: game.level(level).opaqueZeroIndex });
    return { definition: composer.definitions[model.definitionId], tiles: composer.tiles, extraTiles: composer.generatedTiles, faces: meshPropModel(model) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, model, libraryRevision, game, level]);

  useEffect(() => {
    const view = new PropView(canvasRef.current!, game.level(level).palette);
    viewRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [game, level]);

  useEffect(() => {
    if (compiled && model && viewRef.current) viewRef.current.setModel(compiled.definition, compiled.tiles, compiled.faces, model.parts);
  }, [compiled, model]);

  // An undo can leave the selection pointing past the last part.
  useEffect(() => {
    if (model && selected !== null && selected >= model.parts.length) setSelected(model.parts.length ? model.parts.length - 1 : null);
  }, [model, selected]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.painting = painting;
    view.setSelected(selected);
  }, [selected, painting, compiled]);

  /** One undoable change to the model. */
  const change = (mutate: (m: PropModel) => void) =>
    editLibrary((p) => {
      const m = p.models.find((x) => x.id === modelId);
      if (!m) return;
      mutate(m);
      p.definitions[m.definitionId] = buildPropDefinition(m);
    });
  const changePart = (index: number, mutate: (p: PropPart) => void) =>
    change((m) => {
      const p = m.parts[index];
      if (!p) return;
      mutate(p);
      clampPart(p);
    });

  const addPart = (shape: PartShape) => {
    const size = 8;
    change((m) => {
      const p: PropPart = { shape, x: (S - size) / 2, y: (S - size) / 2, z: 0, w: size, d: size, h: size, turn: 0, tile, ...(shape === 'cylinder' || shape === 'cone' ? { sides: DEFAULT_SIDES } : {}) };
      m.parts.push(p);
    });
    setSelected(model ? model.parts.length : 0);
    setPainting(false);
  };

  const removePart = (index: number) => {
    change((m) => void m.parts.splice(index, 1));
    setSelected(null);
  };

  const duplicate = (index: number) => {
    if (!model?.parts[index]) return;
    change((m) => void m.parts.push(copyOf(m.parts[index])));
    setSelected(model.parts.length);
  };

  const usePreset = (index: number) => {
    if (!model) return;
    if (model.parts.length > 1 && !window.confirm(`Replace the parts with the ${PROP_PRESETS[index].name.toLowerCase()}?`)) return;
    change((m) => {
      m.parts = presetParts(PROP_PRESETS[index], tile);
      if (m.name.startsWith('Prop ')) m.name = PROP_PRESETS[index].name;
    });
    setSelected(null);
    setPainting(false);
  };

  // The view's requests, kept current with this render's state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.events = {
      select: (index) => setSelected(index),
      paint: (index, face, whole) =>
        changePart(index, (p) => {
          if (whole) {
            p.tile = tile;
            delete p.faces;
          } else p.faces = { ...p.faces, [face]: tile };
        }),
      begin: () => useEditor.getState().beginStroke(),
      change: (index, mutate) => {
        const m = useEditor.getState().project?.models.find((x) => x.id === modelId);
        const p = m?.parts[index];
        if (!m || !p) return;
        const before = JSON.stringify(p);
        mutate(p);
        if (JSON.stringify(p) === before) return;
        useEditor.getState().project!.definitions[m.definitionId] = buildPropDefinition(m);
        useEditor.getState().touchLibrary();
      },
      end: () => useEditor.getState().endStroke(),
    };
  });

  // Keys: the builder's own, since the map's shortcuts are off while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
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
        } else if (key === 'd' && selected !== null) {
          e.preventDefault();
          duplicate(selected);
        }
        return;
      }
      if (key === 'escape') {
        e.preventDefault();
        if (painting) setPainting(false);
        else if (selected !== null) setSelected(null);
        else close();
        return;
      }
      if (key === 'p') return setPainting(!painting);
      if (selected === null) return;
      const step = viewRef.current?.screenAxes();
      const nudge = (dx: number, dy: number, dz: number) => {
        e.preventDefault();
        changePart(selected, (p) => {
          p.x += dx;
          p.y += dy;
          p.z += dz;
        });
      };
      if (key === 'delete' || key === 'backspace') removePart(selected);
      else if (key === 'r') changePart(selected, turnPart);
      else if (key === 'pageup') nudge(0, 0, 1);
      else if (key === 'pagedown') nudge(0, 0, -1);
      else if (step && key === 'arrowright') nudge(step.right[0], step.right[1], 0);
      else if (step && key === 'arrowleft') nudge(-step.right[0], -step.right[1], 0);
      else if (step && key === 'arrowup') nudge(step.up[0], step.up[1], 0);
      else if (step && key === 'arrowdown') nudge(-step.up[0], -step.up[1], 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!model) return null;
  const faces = compiled?.definition.commands.length ?? 0;
  const names = part ? faceNames(part.shape) : {};
  const painted = part?.faces ? Object.keys(part.faces).length : 0;

  return (
    <div className="backdrop">
      <div className="prop-editor" role="dialog" aria-label="Prop builder">
        <aside>
          <header>
            <input className="prop-name" value={model.name} maxLength={40} onChange={(e) => change((m) => void (m.name = e.target.value))} title="Name" />
          </header>
          <div className="content scroll">
            <h3 className="section-title">Add</h3>
            <div className="shape-grid">
              {PART_SHAPES.map((shape) => (
                <button key={shape} onClick={() => addPart(shape)} title={`Add a ${SHAPE_LABELS[shape].toLowerCase()}`}>
                  <ShapeIcon shape={shape} />
                  <span>{SHAPE_LABELS[shape]}</span>
                </button>
              ))}
            </div>
            <details className="presets">
              <summary>Presets</summary>
              <div className="preset-grid">
                {PROP_PRESETS.map((p, i) => (
                  <button key={p.name} className="small" onClick={() => usePreset(i)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </details>

            {part && selected !== null ? (
              <div className="part-panel">
                <div className="row" style={{ marginBottom: 8 }}>
                  <ShapeIcon shape={part.shape} size={18} />
                  <b className="grow">{SHAPE_LABELS[part.shape]}</b>
                  <button className="small icon ghost" onClick={() => changePart(selected, turnPart)} title="Turn (R)">
                    <Icon name="rotate" size={14} />
                  </button>
                  <button className="small icon ghost" onClick={() => duplicate(selected)} title="Copy (Ctrl+D)">
                    <Icon name="plus" size={14} />
                  </button>
                  <button className="small icon ghost danger" onClick={() => removePart(selected)} title="Delete (Del)">
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <Field label="Size">
                  <div className="row xyz" title="East–west, north–south, height. 16 is one cell.">
                    <NumberInput value={part.w} min={1} max={S} width={46} onChange={(w) => changePart(selected, (p) => void (p.w = w))} />
                    <NumberInput value={part.d} min={1} max={S} width={46} onChange={(d) => changePart(selected, (p) => void (p.d = d))} />
                    <NumberInput value={part.h} min={1} max={S} width={46} onChange={(h) => changePart(selected, (p) => void (p.h = h))} />
                  </div>
                </Field>
                <Field label="Position">
                  <div className="row xyz" title="From the west, from the north, from the floor">
                    <NumberInput value={part.x} min={0} max={S - 1} width={46} onChange={(x) => changePart(selected, (p) => void (p.x = x))} />
                    <NumberInput value={part.y} min={0} max={S - 1} width={46} onChange={(y) => changePart(selected, (p) => void (p.y = y))} />
                    <NumberInput value={part.z} min={0} max={S - 1} width={46} onChange={(z) => changePart(selected, (p) => void (p.z = z))} />
                  </div>
                </Field>
                {(part.shape === 'cylinder' || part.shape === 'cone') && (
                  <Field label="Sides">
                    <div className="segmented">
                      {[4, 6, 8, 12].map((n) => (
                        <button key={n} className={(part.sides ?? DEFAULT_SIDES) === n ? 'active' : ''} onClick={() => changePart(selected, (p) => void (p.sides = n))}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                <div className="row" style={{ marginTop: 4 }}>
                  <div className="tile" style={{ width: 30, height: 30 }}>
                    <TileCanvas game={game} level={level} tile={project.tiles[part.tile]} />
                  </div>
                  <span className="grow dim">{painted ? `${painted} face${painted === 1 ? '' : 's'} painted` : ''}</span>
                  <button
                    className="small"
                    disabled={part.tile === tile && !painted}
                    onClick={() =>
                      changePart(selected, (p) => {
                        p.tile = tile;
                        delete p.faces;
                      })
                    }
                    title="Give every face of this part the chosen texture"
                  >
                    Texture part
                  </button>
                </div>
                {painted > 0 && <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>{Object.keys(part.faces!).map((f) => names[Number(f)] ?? `Side ${f}`).join(', ')}</div>}
              </div>
            ) : (
              <div className="empty" style={{ margin: '14px 0' }}>
                Click a part to change it
              </div>
            )}

            <div className="row" style={{ margin: '14px 0 8px' }}>
              <h3 className="section-title grow" style={{ margin: 0 }}>
                Texture
              </h3>
              <button className={`small ${painting ? 'primary' : ''}`} onClick={() => setPainting(!painting)} title="Click faces to paint them (P). Shift paints the whole part.">
                <Icon name="paint" size={13} /> {painting ? 'Painting' : 'Paint faces'}
              </button>
            </div>
            <div className="tile-grid">
              {project.tiles.map((t, i) => (
                <button key={i} className={`tile ${tile === i ? 'selected' : ''}`} onClick={() => setTile(i)} title={`Tile ${i}`}>
                  <TileCanvas game={game} level={level} tile={t} />
                </button>
              ))}
            </div>
            <Field label="Textures">
              <select value={model.mapping} onChange={(e) => change((m) => void (m.mapping = e.target.value as PropModel['mapping']))}>
                <option value="scale">Natural size</option>
                <option value="stretch">Fit each face</option>
              </select>
            </Field>
            <Field label="Blocks">
              <select value={model.collision} onChange={(e) => change((m) => void (m.collision = e.target.value as PropModel['collision']))}>
                <option value="auto">Where it stands</option>
                <option value="solid">The whole cell</option>
                <option value="none">Nothing</option>
              </select>
            </Field>
          </div>
          <footer>
            <div className={`hint ${faces > PROP_FACE_WARNING ? 'warn-text' : ''}`}>
              {model.parts.length} part{model.parts.length === 1 ? '' : 's'} · {faces} faces
              {model.mapping === 'scale' && compiled ? ` · ${compiled.extraTiles} tiles` : ''}
              {faces > PROP_FACE_WARNING && ' · heavy'}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="small danger"
                onClick={() => {
                  if (!window.confirm(`Delete "${model.name}" and remove it from the map?`)) return;
                  editLibrary((p) => deleteModel(p, model.id));
                  close();
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
              <span className="grow" />
              <button
                className="primary"
                onClick={() => {
                  setBrush({ prop: model.definitionId });
                  close();
                }}
              >
                Done
              </button>
            </div>
          </footer>
        </aside>
        <div className="stage">
          <canvas ref={canvasRef} />
          <div className="stage-keys">
            {painting ? (
              <>
                <span className="kbd">Click</span> paint face <span className="kbd">Shift</span> whole part
              </>
            ) : (
              <>
                <span className="kbd">Drag</span> move <span className="kbd">Shift</span> up/down <span className="kbd">●</span> resize <span className="kbd">R</span> turn <span className="kbd">Del</span> delete
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
