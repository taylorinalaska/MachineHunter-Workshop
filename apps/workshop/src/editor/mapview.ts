/**
 * The 3D map viewport: renders a project's active area with the game's own
 * lighting and texturing rules, and turns pointer input into layer
 * coordinates for the tools.
 *
 * World axes: X = east, Y = up, Z = south; one unit is one map cell and each
 * layer is one unit above the last.
 */
import { type CellDefinition, CLASS_EXIT, CLASS_HAZARD, CLASS_HAZARD_SWITCHABLE, CLASS_SEQUENCE, CLASS_TELEPORTER, DEFINITION_MASK, type MapProject, PATH_LOOP, PATH_ZONE, ProjectComposer, decodeBehavior, definitionClass, isDestructible } from '@mh/core';
import * as THREE from 'three';
import type { GameData } from '../game/gamedata.ts';
import { projectLooks, typeName } from '../game/looks.ts';
import { lockLabel, triggerName } from './doors.ts';
import { modalOpen } from '../ui/common.tsx';
import type { Selection, ViewOptions } from '../state/editor.ts';
import { type EffectSource, EffectsLayer, type LightFlash, customEmitterSpec, isEffectEntity } from './effects.ts';
import { buildLayerGeometry } from './layer-mesh.ts';
import type { Face, SurfaceHit } from './ops.ts';
import { type SimPoint, type WalkPlan, planWalk, walkerAt } from './pathsim.ts';
import { FACE_MASKED, FLASH_COUNT, makePaletteTexture, makeTerrainMaterial, makeTileTexture } from './terrain-material.ts';

export interface PointerInfo {
  /** Position on the active layer, in cells, relative to its origin. */
  x: number;
  y: number;
  /** Whether the position is inside the layer's grid. */
  inside: boolean;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  clientX: number;
  clientY: number;
}

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

export interface Ghost {
  /** Cells to tint (layer-local). */
  cells?: { x: number; y: number }[];
  cellColor?: number;
  /** Wall segments between lattice points. */
  walls?: { x0: number; y0: number; x1: number; y1: number; height: number }[];
  wallColor?: number;
  /** An entity preview at a position in 1/256 cell. */
  sprite?: { type: number; x: number; y: number };
  /** A circle on the floor (lighting brush), in cells. */
  circle?: { x: number; y: number; radius: number };
  /** Cell geometry to preview see-through at layer cells: a door panel, a ramp, a prop. */
  shapes?: { definition: CellDefinition; x: number; y: number }[];
  shapeColor?: number;
  /** Cells to mark each in its own color (a trigger's pads and targets). */
  marks?: { x: number; y: number; color: number }[];
}

export interface MapViewState {
  project: MapProject;
  /** Changes when a different map is opened (not on undo, which only swaps the project object). */
  documentId: number;
  revision: number;
  libraryRevision: number;
  group: number;
  layer: number;
  view: ViewOptions;
  selection: Selection | null;
  pendingTeleporter: { group: number; layer: number; x: number; y: number } | null;
  /** A cell to center on; acted on once per `nonce`. */
  focus: { group: number; layer: number; x: number; y: number; nonce: number } | null;
  /** The path being edited, drawn highlighted with numbered points. */
  selectedPath: number | null;
  /** The path whose followers are shown walking it. */
  walkingPath: number | null;
}

/** Ring and name-tag color for each kind of entity. */
const CATEGORY_COLORS: Record<string, number> = {
  player: 0xffffff,
  robot: 0xff7a59,
  creature: 0xf2b36d,
  human: 0xf5d76e,
  vehicle: 0xb08cf0,
  turret: 0xe06666,
  boss: 0xff3d6e,
  pickup: 0x5fd08a,
  objective: 0xe8d24a,
  effect: 0xf0a23c,
  marker: 0x38d6e8,
  decor: 0x8fa3b8,
};
const PATH_COLOR = 0xffb347;
/** Name tags are hidden when the camera is pulled back further than this, and for entities far from its center. */
const TAG_MAX_DISTANCE = 60;
const TAG_RANGE = 18;

const BACKGROUND = 0x14171c;
const GRID_COLOR = 0x6fb7ff;
const GHOST_OK = 0x5fd08a;
/** World size, in cells, of a full-size sprite frame drawn at Q14 scale 1.0. */
const SPRITE_CELLS_AT_UNIT_SCALE = 1.0;
const SPRITE_FRAME_PIXELS = 64;

const MARKER_COLORS = { teleporter: 0x38d6e8, exit: 0x9be15d, hazard: 0xff5a6a, destructible: 0xf2b36d, door: 0x6fb7ff, switch: 0xffd166 } as const;

export class MapView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
  private readonly terrain = new THREE.Group();
  private readonly entities = new THREE.Group();
  private readonly overlays = new THREE.Group();
  private readonly ghosts = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly rings = new THREE.Group();
  private readonly tags = new THREE.Group();
  private readonly pathLines = new THREE.Group();
  /** Followers shown walking the path in `walkingPath`, with the walk each one takes. */
  private readonly walkers = new THREE.Group();
  private walks: { mesh: THREE.Object3D; arrow: THREE.Object3D; plan: WalkPlan; start: SimPoint; layer: number; originX: number; originY: number }[] = [];
  private walkKey = '';
  private walkStarted = 0;
  private effects: EffectsLayer | null = null;
  private flashesShown = false;
  private readonly tagTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();
  private tagFocus = { x: NaN, z: NaN, distance: NaN };
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;

  private state: MapViewState | null = null;
  private composer: ProjectComposer | null = null;
  private composerKey = '';
  private tileTexture: THREE.DataArrayTexture | null = null;
  private tileCount = 0;
  private paletteTexture: THREE.DataTexture | null = null;
  private paletteLevel = '';
  private readonly layerMeshes: THREE.Mesh[] = [];
  private readonly spriteTextures = new Map<string, THREE.Texture>();
  private readonly entityMeshes = new Map<number, THREE.Mesh>();
  private builtRevision = -1;
  private builtGroup = -1;
  private focusNonce = 0;

  // Orbit camera around a point on the ground.
  private target = new THREE.Vector3(8, 0, 8);
  private yaw = 0;
  private pitch = THREE.MathUtils.degToRad(58);
  private distance = 26;
  private readonly keys = new Set<string>();
  private drag: { mode: 'orbit' | 'pan' | 'tool'; x: number; y: number; ground?: THREE.Vector3 } | null = null;
  private lastFrame = 0;
  private frameHandle = 0;
  private needsRender = true;
  private disposed = false;

  onPointer: (phase: PointerPhase, info: PointerInfo) => void = () => {};
  onHover: (info: PointerInfo | null) => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: GameData,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(BACKGROUND);
    this.scene.add(this.terrain, this.markers, this.rings, this.entities, this.pathLines, this.walkers, this.tags, this.overlays, this.ghosts);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.preventDefault);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.clearKeys);
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.pointerDown);
    c.removeEventListener('pointermove', this.pointerMove);
    c.removeEventListener('pointerup', this.pointerUp);
    c.removeEventListener('pointercancel', this.pointerCancel);
    c.removeEventListener('pointerleave', this.pointerLeave);
    c.removeEventListener('wheel', this.wheel);
    c.removeEventListener('contextmenu', this.preventDefault);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.clearKeys);
    this.clearGroup(this.terrain);
    this.clearGroup(this.entities);
    this.clearGroup(this.overlays);
    this.clearGroup(this.ghosts);
    this.clearGroup(this.markers);
    this.clearGroup(this.rings);
    this.clearGroup(this.tags);
    this.clearGroup(this.pathLines);
    this.clearGroup(this.walkers);
    this.effects?.dispose();
    for (const t of this.tagTextures.values()) t.texture.dispose();
    this.tileTexture?.dispose();
    this.paletteTexture?.dispose();
    for (const t of this.spriteTextures.values()) t.dispose();
    this.renderer.dispose();
  }

  /* ------------------------------------------------------------ syncing */

  /** Bring the view in line with editor state. Cheap when nothing relevant changed. */
  sync(state: MapViewState): void {
    const previous = this.state;
    this.state = state;
    const { project } = state;
    const composerKey = `${state.libraryRevision}`;
    if (!this.composer || composerKey !== this.composerKey || previous?.project !== project) {
      this.composer = new ProjectComposer(project, { preview: true, opaqueZeroIndex: this.game.level(project.baseLevel).opaqueZeroIndex });
      this.composerKey = composerKey;
      this.builtRevision = -1;
      this.tileCount = -1;
    }
    if (this.paletteLevel !== project.baseLevel) {
      this.paletteTexture?.dispose();
      this.paletteTexture = makePaletteTexture(this.game.level(project.baseLevel).palette);
      this.paletteLevel = project.baseLevel;
      this.builtRevision = -1;
      for (const t of this.spriteTextures.values()) t.dispose();
      this.spriteTextures.clear();
      this.clearGroup(this.entities);
      this.entityMeshes.clear();
      if (this.effects) {
        this.scene.remove(this.effects.object);
        this.effects.dispose();
      }
      this.effects = new EffectsLayer(this.game, project.baseLevel);
      this.scene.add(this.effects.object);
    }
    if (this.builtRevision !== state.revision || this.builtGroup !== state.group) {
      this.rebuildTerrain();
      this.rebuildEntities();
      this.rebuildTags();
      this.rebuildMarkers();
      this.builtRevision = state.revision;
      // Undo and redo swap the project object; only a newly opened map or another area moves the camera.
      if (this.builtGroup !== state.group || previous?.documentId !== state.documentId) this.frameMap();
      this.builtGroup = state.group;
    }
    if (state.focus && state.focus.nonce !== this.focusNonce && state.focus.group === state.group) {
      this.focusNonce = state.focus.nonce;
      const layer = this.group().layers[state.focus.layer];
      if (layer) {
        this.target.set(layer.originX + state.focus.x + 0.5, state.focus.layer, layer.originY + state.focus.y + 0.5);
        this.distance = Math.min(this.distance, 22);
      }
    }
    this.applyViewOptions();
    this.rebuildOverlays();
    this.rebuildPaths();
    this.rebuildWalkers();
    this.needsRender = true;
  }

  private group() {
    const s = this.state!;
    return s.project.groups[s.group];
  }

  private activeLayer() {
    const s = this.state!;
    return this.group().layers[s.layer];
  }

  private rebuildTerrain(): void {
    const composer = this.composer!;
    const group = this.group();
    const composed = group.layers.map((layer) => composer.composeLayer(layer));
    // Cut tiles appear as the composer meets split floors and ramp sides.
    if (composer.tiles.length !== this.tileCount) {
      this.tileTexture?.dispose();
      this.tileTexture = makeTileTexture(composer.tiles);
      this.tileCount = composer.tiles.length;
    }
    this.clearGroup(this.terrain);
    this.layerMeshes.length = 0;
    group.layers.forEach((layer, index) => {
      const geometry = buildLayerGeometry({
        width: layer.width,
        height: layer.height,
        originX: layer.originX,
        originY: layer.originY,
        elevation: index,
        cells: composed[index],
        lighting: layer.lighting,
        definitions: composer.definitions,
        tileCount: this.tileCount,
      });
      const mesh = new THREE.Mesh(geometry, makeTerrainMaterial({ tiles: this.tileTexture!, palette: this.paletteTexture! }));
      mesh.userData.layer = index;
      mesh.userData.cells = composed[index];
      this.terrain.add(mesh);
      this.layerMeshes.push(mesh);
    });
  }

  private applyViewOptions(): void {
    const s = this.state!;
    for (const mesh of this.layerMeshes) {
      const index = mesh.userData.layer as number;
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.uFullbright.value = s.view.lighting ? 0 : 1;
      material.uniforms.uFocusY.value = s.layer;
      material.uniforms.uDim.value = index === s.layer ? 1 : index < s.layer ? 0.62 : 0.8;
      material.uniforms.uStorey.value = index;
      mesh.visible = !(s.view.hideUpper && index > s.layer);
    }
    this.entities.visible = s.view.entities;
    this.rings.visible = s.view.entities;
    this.tags.visible = s.view.entities && s.view.labels;
    this.pathLines.visible = s.view.entities;
    if (this.effects) this.effects.object.visible = s.view.entities && s.view.effects;
    this.tagFocus.x = NaN; // re-evaluate which name tags are in range
    this.markers.visible = s.view.markers;
    for (const mesh of this.entityMeshes.values()) {
      const index = mesh.userData.layer as number;
      mesh.visible = !(s.view.hideUpper && index > s.layer);
      (mesh.material as THREE.MeshBasicMaterial).opacity = index === s.layer ? 1 : 0.45;
    }
  }

  /* ------------------------------------------------------------ entities */

  private spriteTexture(type: number): { texture: THREE.Texture; size: number } {
    const project = this.state!.project;
    const level = project.baseLevel;
    const info = this.game.entity(type);
    // The map's custom enemies can replace the sprites a type is drawn from.
    const looks = projectLooks(project);
    const key = `${type}:${looks?.key ?? ''}`;
    let texture = this.spriteTextures.get(key);
    if (!texture) {
      for (const [k, t] of this.spriteTextures) {
        if (!k.startsWith(`${type}:`)) continue;
        t.dispose();
        this.spriteTextures.delete(k);
      }
      // Emitters and flames are drawn live by the effects layer; here they only get a small badge to click on.
      const image = (isEffectEntity(type) ? null : this.game.entityImage(type, level, looks)) ?? this.iconCanvas(typeName(this.game, project, type), info?.category ?? 'marker');
      texture = new THREE.CanvasTexture(image);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.userData.isIcon = isEffectEntity(type) || !this.game.entityImage(type, level, looks);
      texture.userData.isBadge = isEffectEntity(type);
      this.spriteTextures.set(key, texture);
    }
    const scale = info?.descriptor?.primaryAnimation?.scale || 0x6000;
    // Frames come in 64, 32 and 16 pixel sizes; a smaller frame covers proportionally less ground.
    const pixels = (texture.image as HTMLCanvasElement).width || SPRITE_FRAME_PIXELS;
    const size = texture.userData.isBadge ? 0.36 : texture.userData.isIcon ? 0.7 : Math.max(0.3, (scale / 0x4000) * (pixels / SPRITE_FRAME_PIXELS) * SPRITE_CELLS_AT_UNIT_SCALE);
    return { texture, size };
  }

  /** A labeled disc for entities that have no sprite of their own (emitters, markers). */
  private iconCanvas(name: string, category: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d')!;
    const colors: Record<string, string> = { effect: '#f0a23c', marker: '#38d6e8', objective: '#e8d24a', decor: '#8fa3b8', turret: '#e06666' };
    g.fillStyle = colors[category] ?? '#b08cf0';
    g.beginPath();
    g.arc(32, 32, 22, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.stroke();
    g.fillStyle = '#10141a';
    g.font = 'bold 20px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const initials = name
      .split(/[\s_]+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    g.fillText(initials, 32, 34);
    return canvas;
  }

  private makeSpriteMesh(type: number, opacity = 1): THREE.Mesh {
    const { texture, size } = this.spriteTexture(type);
    const geometry = new THREE.PlaneGeometry(size, size);
    geometry.rotateX(-Math.PI / 2); // lie flat, top of the image towards north
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.05, opacity, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    return mesh;
  }

  private rebuildEntities(): void {
    const group = this.group();
    const seen = new Set<number>();
    group.layers.forEach((layer, index) => {
      for (const e of layer.entities) {
        seen.add(e.id);
        let mesh = this.entityMeshes.get(e.id);
        if (mesh && mesh.userData.type !== e.type) {
          this.removeEntityMesh(e.id);
          mesh = undefined;
        }
        if (!mesh) {
          mesh = this.makeSpriteMesh(e.type);
          mesh.userData.type = e.type;
          mesh.userData.id = e.id;
          this.entities.add(mesh);
          this.entityMeshes.set(e.id, mesh);
        }
        mesh.userData.layer = index;
        mesh.position.set(layer.originX + e.x / 256, index + this.standHeight(index, e.x, e.y) + 0.03, layer.originY + e.y / 256);
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(e.disabled ? 0x777777 : 0xffffff);
      }
    });
    for (const id of [...this.entityMeshes.keys()]) if (!seen.has(id)) this.removeEntityMesh(id);

    // Hand the effect entities to the live preview.
    const sources: EffectSource[] = [];
    group.layers.forEach((layer, index) => {
      if (this.state!.view.hideUpper && index > this.state!.layer) return;
      for (const e of layer.entities) {
        if (!isEffectEntity(e.type)) continue;
        const custom = e.effect !== undefined ? this.state!.project.effects.find((f) => f.id === e.effect) : undefined;
        if (e.effect !== undefined && !custom) continue;
        sources.push({ spec: custom ? customEmitterSpec(custom) : undefined, type: e.type, x: layer.originX + e.x / 256, y: index + this.standHeight(index, e.x, e.y), z: layer.originY + e.y / 256, layer: index, heading: ((e.behavior << 7) / 2048) * Math.PI * 2, disabled: e.disabled });
      }
    });
    this.effects?.setSources(sources);
  }

  /* ---------------------------------------------------------- identifiers */

  /** A colored ring under every entity and a name tag above it, so none can hide against the floor. */
  private rebuildTags(): void {
    this.clearGroup(this.rings);
    this.clearGroup(this.tags);
    const s = this.state!;
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();
    const SEGMENTS = 20;
    this.group().layers.forEach((layer, index) => {
      if (s.view.hideUpper && index > s.layer) return;
      for (const e of layer.entities) {
        const info = this.game.entity(e.type);
        // Friends get a green ring, whatever they are.
        const hex = e.friendly ? 0x5fd08a : (CATEGORY_COLORS[info?.category ?? 'marker'] ?? 0xffffff);
        color.setHex(hex);
        if (index !== s.layer) color.multiplyScalar(0.5);
        const x = layer.originX + e.x / 256;
        const z = layer.originY + e.y / 256;
        const y = index + this.standHeight(index, e.x, e.y) + 0.022;
        const radius = Math.max(0.24, (info?.descriptor?.radius ?? 48) / 256) + 0.05;
        for (let k = 0; k < SEGMENTS; k++) {
          const a = (k / SEGMENTS) * Math.PI * 2;
          const b = ((k + 1) / SEGMENTS) * Math.PI * 2;
          positions.push(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius, x + Math.cos(b) * radius, y, z + Math.sin(b) * radius);
          colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }
        if (index !== s.layer) continue;
        const tag = this.nameTag(e.effect !== undefined ? (s.project.effects.find((f) => f.id === e.effect)?.name ?? 'Missing effect') : typeName(this.game, s.project, e.type), hex);
        tag.position.set(x, y + (isEffectEntity(e.type) ? 0.3 : 0.62), z);
        tag.userData.x = x;
        tag.userData.z = z;
        this.tags.add(tag);
      }
    });
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
      lines.renderOrder = 2;
      this.rings.add(lines);
    }
    this.tagFocus.x = NaN;
  }

  /** A small name plate that keeps its size on screen. Textures are shared between entities of the same kind. */
  private nameTag(text: string, hex: number): THREE.Sprite {
    const key = `${text}|${hex}`;
    let entry = this.tagTextures.get(key);
    if (!entry) {
      const canvas = document.createElement('canvas');
      const g = canvas.getContext('2d')!;
      const font = '600 24px system-ui, sans-serif';
      const label = text.length > 22 ? `${text.slice(0, 21)}…` : text;
      g.font = font;
      canvas.width = Math.ceil(g.measureText(label).width) + 22;
      canvas.height = 36;
      g.font = font;
      g.fillStyle = 'rgba(10, 13, 17, 0.82)';
      g.beginPath();
      g.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 8);
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = `#${hex.toString(16).padStart(6, '0')}`;
      g.stroke();
      g.fillStyle = '#f2f4f7';
      g.textBaseline = 'middle';
      g.fillText(label, 11, canvas.height / 2 + 1);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      entry = { texture, aspect: canvas.width / canvas.height };
      this.tagTextures.set(key, entry);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: entry.texture, depthTest: false, transparent: true, sizeAttenuation: false }));
    const height = 0.021;
    sprite.scale.set(height * entry.aspect, height, 1);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 5;
    return sprite;
  }

  /** Show name tags only near the center of the view and when zoomed in enough to read them. */
  private updateTagVisibility(): void {
    const f = this.tagFocus;
    if (Math.abs(f.x - this.target.x) < 0.5 && Math.abs(f.z - this.target.z) < 0.5 && Math.abs(f.distance - this.distance) < 0.5) return;
    this.tagFocus = { x: this.target.x, z: this.target.z, distance: this.distance };
    const near = this.distance <= TAG_MAX_DISTANCE;
    const range = Math.max(TAG_RANGE, this.distance * 0.7);
    for (const tag of this.tags.children) tag.visible = near && Math.abs(tag.userData.x - this.target.x) < range && Math.abs(tag.userData.z - this.target.z) < range;
  }

  /* ---------------------------------------------------------------- paths */

  /** Routes and wander zones of the area on screen, and a thin line from each entity to the path it follows. */
  private rebuildPaths(): void {
    this.clearGroup(this.pathLines);
    const s = this.state!;
    const group = this.group();
    const lines: number[] = [];
    const selectedLines: number[] = [];
    const links: number[] = [];
    const point = (layerIndex: number, x: number, y: number): [number, number, number] | null => {
      const layer = group.layers[layerIndex];
      return layer ? [layer.originX + x / 256, layerIndex + 0.07, layer.originY + y / 256] : null;
    };
    for (const path of s.project.paths) {
      if (path.group !== s.group || !path.points.length) continue;
      const selected = path.id === s.selectedPath;
      const out = selected ? selectedLines : lines;
      const pts = path.points.map((p) => point(path.layer, p.x, p.y)).filter((p): p is [number, number, number] => !!p);
      if (!pts.length) continue;
      if (path.word0 === PATH_ZONE) {
        // The nine places are every pairing of the three X values with the three Y values.
        const xs = pts.map((p) => p[0]);
        const zs = pts.map((p) => p[2]);
        const y = pts[0][1];
        const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
        out.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
        for (const x of xs) for (const z of zs) this.pathLines.add(this.pathDot(x, y, z, selected, 0.09));
      } else {
        for (let i = 0; i + 1 < pts.length; i++) out.push(...pts[i], ...pts[i + 1]);
        if (path.word0 !== 0 && path.word0 !== 1 && pts.length > 2) out.push(...pts[pts.length - 1], ...pts[0]);
        pts.forEach((p, i) => {
          this.pathLines.add(this.pathDot(p[0], p[1], p[2], selected, i === 0 ? 0.17 : 0.12));
          if (selected) {
            const number = this.nameTag(String(i + 1), 0xffffff);
            number.position.set(p[0], p[1] + 0.12, p[2]);
            this.pathLines.add(number);
          }
        });
      }
      // Followers.
      group.layers.forEach((layer, index) => {
        for (const e of layer.entities) {
          if (e.pathId !== path.id) continue;
          links.push(layer.originX + e.x / 256, index + 0.07, layer.originY + e.y / 256, ...pts[0]);
        }
      });
    }
    const add = (positions: number[], color: number, opacity: number) => {
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      line.renderOrder = 4;
      this.pathLines.add(line);
    };
    add(lines, PATH_COLOR, 0.75);
    add(selectedLines, 0xffffff, 1);
    add(links, PATH_COLOR, 0.35);
    void PATH_LOOP;
  }

  /**
   * The followers of the path being played, each with the walk it takes from
   * where it stands; a dot stands in when nothing follows the path yet. Built
   * again only when the path or its followers change, so the walk keeps going
   * through unrelated edits.
   */
  private rebuildWalkers(): void {
    const s = this.state!;
    const path = s.walkingPath !== null ? s.project.paths.find((p) => p.id === s.walkingPath && p.group === s.group) : undefined;
    const group = this.group();
    const followers = path ? group.layers.flatMap((layer, index) => layer.entities.filter((e) => e.pathId === path.id).map((e) => ({ e, layer, index }))) : [];
    const key = path ? JSON.stringify([path.id, path.word0, path.layer, path.points.map((p) => [p.x, p.y]), followers.map(({ e, index }) => [e.id, e.type, e.x, e.y, index])]) : '';
    if (key === this.walkKey) return;
    this.walkKey = key;
    this.clearGroup(this.walkers);
    this.walks = [];
    for (const mesh of this.entityMeshes.values()) (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    if (!path || !path.points.length) return;
    this.walkStarted = performance.now();
    const pathLayer = group.layers[path.layer] ?? group.layers[0];
    const points = path.points.map((p) => ({ x: p.x, y: p.y }));
    const list = followers.length ? followers : [{ e: null, layer: pathLayer, index: path.layer }];
    list.forEach(({ e, layer, index }, i) => {
      const start = e ? { x: e.x + (layer.originX - pathLayer.originX) * 256, y: e.y + (layer.originY - pathLayer.originY) * 256 } : points[0];
      let mesh: THREE.Object3D;
      if (e) {
        mesh = this.makeSpriteMesh(e.type);
        // The entity where it was placed stays, faded, so the walk can be told from it.
        const placed = this.entityMeshes.get(e.id);
        if (placed) (placed.material as THREE.MeshBasicMaterial).opacity = 0.3;
      } else mesh = this.pathDot(0, 0, 0, true, 0.2);
      mesh.renderOrder = 5;
      const arrow = this.walkArrow();
      this.walkers.add(mesh, arrow);
      this.walks.push({ mesh, arrow, plan: planWalk(path.word0, points, start, path.id * 31 + i + 1), start, layer: path.layer, originX: pathLayer.originX, originY: pathLayer.originY });
    });
    this.updateWalkers();
  }

  /** Move the walkers to where they are now in their walks. */
  private updateWalkers(): void {
    const t = (performance.now() - this.walkStarted) / 1000;
    for (const w of this.walks) {
      const at = walkerAt(w.plan, t, w.start);
      w.mesh.position.set(w.originX + at.x / 256, w.layer + this.standHeight(w.layer, at.x, at.y) + 0.05, w.originY + at.y / 256);
      // The arrow points the way it is walking, a little ahead of it.
      const ahead = 0.42;
      w.arrow.position.set(w.mesh.position.x + Math.sin(at.heading) * ahead, w.mesh.position.y + 0.01, w.mesh.position.z - Math.cos(at.heading) * ahead);
      w.arrow.rotation.y = -at.heading;
      w.arrow.visible = at.moving;
    }
  }

  /** A flat arrowhead pointing north, for a walker's direction. */
  private walkArrow(): THREE.Mesh {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0.16), new THREE.Vector2(0.12, -0.08), new THREE.Vector2(0, -0.02), new THREE.Vector2(-0.12, -0.08)]);
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2); // lie flat with the point towards north (-z)
    const arrow = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    arrow.renderOrder = 6;
    return arrow;
  }

  private pathDot(x: number, y: number, z: number, selected: boolean, radius: number): THREE.Mesh {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), new THREE.MeshBasicMaterial({ color: selected ? 0xffffff : PATH_COLOR, depthTest: false, transparent: true, opacity: selected ? 1 : 0.85, side: THREE.DoubleSide }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(x, y, z);
    dot.renderOrder = 4;
    return dot;
  }

  /** Feed the lights that are lit this instant to the terrain shader. */
  private applyFlashes(flashes: LightFlash[]): void {
    if (!flashes.length && !this.flashesShown) return;
    this.flashesShown = flashes.length > 0;
    for (const mesh of this.layerMeshes) {
      const slots = (mesh.material as THREE.ShaderMaterial).uniforms.uFlash.value as THREE.Vector4[];
      for (let i = 0; i < FLASH_COUNT; i++) {
        const f = flashes[i];
        if (f) slots[i].set(f.x, f.z, f.layer, f.strength);
        else slots[i].set(0, 0, 0, 0);
      }
    }
  }

  /**
   * Height, in cells, of the level surface under a point of a layer: the top
   * of a stand, crate or block when the cell has one there, otherwise the floor.
   */
  private standHeight(layerIndex: number, x: number, y: number): number {
    const layer = this.group().layers[layerIndex];
    const cells = this.layerMeshes[layerIndex]?.userData.cells as Uint16Array | undefined;
    const cx = x >> 8;
    const cy = y >> 8;
    if (!cells || cx < 0 || cy < 0 || cx >= layer.width || cy >= layer.height) return 0;
    const def = this.composer!.definitions[cells[cy * layer.width + cx] & DEFINITION_MASK];
    if (!def) return 0;
    const lx = x & 255;
    const ly = y & 255;
    const v = def.vertices;
    let top = 0;
    for (const command of def.commands) {
      if (command.indices.length < 3) continue;
      const z = v[command.indices[0] * 3 + 2];
      if (z >= top || command.indices.some((i) => v[i * 3 + 2] !== z)) continue;
      const xs = command.indices.map((i) => v[i * 3]);
      const ys = command.indices.map((i) => v[i * 3 + 1]);
      if (lx >= Math.min(...xs) && lx <= Math.max(...xs) && ly >= Math.min(...ys) && ly <= Math.max(...ys)) top = z;
    }
    return -top / 256;
  }

  private removeEntityMesh(id: number): void {
    const mesh = this.entityMeshes.get(id);
    if (!mesh) return;
    this.entities.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.entityMeshes.delete(id);
  }

  /* ------------------------------------------------------------- markers */

  /** Colored tiles over cells with behavior, and lines from teleporters to where they lead. */
  private rebuildMarkers(): void {
    this.clearGroup(this.markers);
    const composer = this.composer!;
    const group = this.group();
    const quads: Record<keyof typeof MARKER_COLORS, number[]> = { teleporter: [], exit: [], hazard: [], destructible: [], door: [], switch: [] };
    const links: number[] = [];
    const arrivals: number[] = [];
    const labels: { text: string; x: number; y: number; z: number }[] = [];
    const project = this.state!.project;
    const here = this.state!.group;
    const arrive = (layerIndex: number, cx: number, cy: number) => {
      const target = group.layers[layerIndex];
      if (!target) return null;
      const x = target.originX + cx;
      const z = target.originY + cy;
      const y = layerIndex + 0.025;
      const a = 0.2;
      const b = 0.8;
      arrivals.push(x + a, y, z + a, x + b, y, z + a, x + b, y, z + a, x + b, y, z + b, x + b, y, z + b, x + a, y, z + b, x + a, y, z + b, x + a, y, z + a);
      arrivals.push(x + a, y, z + a, x + b, y, z + b, x + b, y, z + a, x + a, y, z + b);
      return { x: x + 0.5, z: z + 0.5 };
    };
    this.layerMeshes.forEach((mesh, index) => {
      const layer = group.layers[index];
      const cells = mesh.userData.cells as Uint16Array;
      for (let i = 0; i < cells.length; i++) {
        const id = cells[i] & DEFINITION_MASK;
        if (!id) continue;
        const meta = composer.definitions[id].meta;
        const cls = definitionClass(meta);
        const placed = layer.behaviors.get(i);
        const kind = cls === CLASS_TELEPORTER ? 'teleporter' : cls === CLASS_EXIT ? 'exit' : cls === CLASS_HAZARD || cls === CLASS_HAZARD_SWITCHABLE ? 'hazard' : cls === CLASS_SEQUENCE ? 'door' : placed?.kind === 'switch' ? 'switch' : isDestructible(meta) ? 'destructible' : null;
        if (!kind) continue;
        const x = layer.originX + (i % layer.width);
        const z = layer.originY + Math.floor(i / layer.width);
        const y = index + 0.02;
        if (placed?.kind === 'door' && placed.lock) labels.push({ text: lockLabel(placed.lock, this.state!.project).replace('Opens with', 'needs').replace('Needs', 'needs'), x: x + 0.5, y: index, z: z + 0.5 });
        if (placed?.kind === 'switch') labels.push({ text: triggerName(this.state!.project, placed.channel), x: x + 0.5, y: index, z: z + 0.5 });
        quads[kind].push(x, y, z, x + 1, y, z, x + 1, y, z + 1, x, y, z + 1);
        if (kind === 'teleporter') {
          const b = decodeBehavior(meta);
          if (b.kind === 'teleporter' && b.group === here) {
            const end = arrive(b.layer, b.x, b.y);
            if (end) links.push(x + 0.5, index + 0.08, z + 0.5, end.x, b.layer + 0.08, end.z);
          } else if (b.kind === 'teleporter') {
            // The destination is in an area that is not on screen: say where it goes instead of drawing a line.
            const area = project.groups[b.group];
            labels.push({ text: area ? `to ${area.name}  (${b.x}, ${b.y})` : 'to a missing area', x: x + 0.5, y: index, z: z + 0.5 });
          }
        }
      }
    });
    // Teleporters in other areas that lead here.
    project.groups.forEach((other, g) => {
      if (g === here) return;
      for (const layer of other.layers) {
        const incoming = (b: { group: number; layer: number; x: number; y: number }) => {
          if (b.group !== here) return;
          const end = arrive(b.layer, b.x, b.y);
          if (end) labels.push({ text: `from ${other.name}`, x: end.x, y: b.layer, z: end.z });
        };
        for (const b of layer.behaviors.values()) if (b.kind === 'teleporter') incoming(b);
        for (let i = 0; i < layer.cells.length; i++) {
          if (layer.behaviors.has(i) || layer.surfaces.has(i)) continue;
          const def = project.definitions[layer.cells[i] & DEFINITION_MASK];
          if (!def || definitionClass(def.meta) !== CLASS_TELEPORTER) continue;
          const b = decodeBehavior(def.meta);
          if (b.kind === 'teleporter') incoming(b);
        }
      }
    });
    for (const kind of Object.keys(quads) as (keyof typeof MARKER_COLORS)[]) {
      const positions = quads[kind];
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const indices: number[] = [];
      for (let q = 0; q < positions.length / 12; q++) indices.push(q * 4, q * 4 + 2, q * 4 + 1, q * 4, q * 4 + 3, q * 4 + 2);
      geometry.setIndex(indices);
      const material = new THREE.MeshBasicMaterial({ color: MARKER_COLORS[kind], transparent: true, opacity: kind === 'destructible' ? 0.16 : 0.34, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 1;
      this.markers.add(mesh);
    }
    for (const lines of [links, arrivals]) {
      if (!lines.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      this.markers.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: MARKER_COLORS.teleporter, transparent: true, opacity: 0.8 })));
    }
    const stems: number[] = [];
    for (const label of labels) {
      const sprite = this.label(label.text);
      sprite.position.set(label.x, label.y + 1.0, label.z);
      sprite.center.set(0.5, 0);
      this.markers.add(sprite);
      stems.push(label.x, label.y + 0.05, label.z, label.x, label.y + 1.0, label.z);
    }
    if (stems.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(stems, 3));
      this.markers.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: MARKER_COLORS.teleporter, transparent: true, opacity: 0.8, depthTest: false })));
    }
  }

  /** A small text plate that always faces the camera. */
  private label(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d')!;
    const font = '600 30px system-ui, sans-serif';
    g.font = font;
    canvas.width = Math.ceil(g.measureText(text).width) + 36;
    canvas.height = 52;
    g.font = font;
    g.fillStyle = 'rgba(12, 22, 28, 0.88)';
    g.beginPath();
    g.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 12);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#38d6e8';
    g.stroke();
    g.fillStyle = '#c9f6fb';
    g.textBaseline = 'middle';
    g.fillText(text, 18, canvas.height / 2 + 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Constant size on screen, so the text can be read however far the camera is pulled back.
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false });
    material.userData.ownsMap = true;
    const sprite = new THREE.Sprite(material);
    const height = 0.034;
    sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
    sprite.renderOrder = 5;
    return sprite;
  }

  /* ------------------------------------------------------------ overlays */

  private rebuildOverlays(): void {
    this.clearGroup(this.overlays);
    const s = this.state!;
    const layer = this.activeLayer();
    const y = s.layer + 0.012;
    if (s.view.grid) {
      const lines: number[] = [];
      for (let x = 0; x <= layer.width; x++) lines.push(layer.originX + x, y, layer.originY, layer.originX + x, y, layer.originY + layer.height);
      for (let z = 0; z <= layer.height; z++) lines.push(layer.originX, y, layer.originY + z, layer.originX + layer.width, y, layer.originY + z);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      this.overlays.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.14, depthWrite: false })));
    }
    // Layer outline, always visible so the buildable area is clear.
    const x0 = layer.originX;
    const z0 = layer.originY;
    const x1 = x0 + layer.width;
    const z1 = z0 + layer.height;
    const border = new THREE.BufferGeometry();
    border.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0], 3));
    this.overlays.add(new THREE.LineSegments(border, new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.7 })));

    const sel = s.selection;
    if (sel && sel.group === s.group) {
      const selLayer = this.group().layers[sel.layer];
      if (selLayer && sel.kind === 'cell') this.overlays.add(this.cellOutline(selLayer.originX + sel.x, selLayer.originY + sel.y, sel.layer + 0.03, 0xffffff));
      if (selLayer && sel.kind === 'entity') {
        const e = selLayer.entities.find((v) => v.id === sel.id);
        if (e) {
          const radius = Math.max(0.28, (this.game.entity(e.type)?.descriptor?.radius ?? 64) / 256);
          const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.06, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 }));
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(selLayer.originX + e.x / 256, sel.layer + 0.04, selLayer.originY + e.y / 256);
          ring.renderOrder = 3;
          this.overlays.add(ring);
        }
      }
      if (selLayer && sel.kind === 'wall') {
        const wall = selLayer.walls.get(sel.key);
        if (wall) this.overlays.add(this.wallGhost(selLayer, wall, sel.layer, 0xffffff, 0.35));
      }
    }
    const pending = s.pendingTeleporter;
    if (pending && pending.group === s.group) {
      const l = this.group().layers[pending.layer];
      if (l) this.overlays.add(this.cellOutline(l.originX + pending.x, l.originY + pending.y, pending.layer + 0.03, MARKER_COLORS.teleporter));
    }
  }

  private cellOutline(x: number, z: number, y: number, color: number): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, y, z, x + 1, y, z, x + 1, y, z, x + 1, y, z + 1, x + 1, y, z + 1, x, y, z + 1, x, y, z + 1, x, y, z], 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 4;
    return line;
  }

  private wallGhost(layer: { originX: number; originY: number }, w: { x0: number; y0: number; x1: number; y1: number; height: number }, elevation: number, color: number, opacity: number): THREE.Mesh {
    const ax = layer.originX + w.x0;
    const az = layer.originY + w.y0;
    const bx = layer.originX + w.x1;
    const bz = layer.originY + w.y1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([ax, elevation, az, ax, elevation + w.height, az, bx, elevation + w.height, bz, bx, elevation, bz], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    mesh.renderOrder = 3;
    return mesh;
  }

  /** Show what the current tool is about to do. */
  setGhost(ghost: Ghost | null): void {
    this.clearGroup(this.ghosts);
    this.needsRender = true;
    if (!ghost || !this.state) return;
    const layer = this.activeLayer();
    const elevation = this.state.layer;
    if (ghost.cells?.length) {
      const positions: number[] = [];
      const indices: number[] = [];
      ghost.cells.forEach((c, i) => {
        const x = layer.originX + c.x;
        const z = layer.originY + c.y;
        const y = elevation + 0.035;
        positions.push(x, y, z, x + 1, y, z, x + 1, y, z + 1, x, y, z + 1);
        indices.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: ghost.cellColor ?? GHOST_OK, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 3;
      this.ghosts.add(mesh);
    }
    for (const w of ghost.walls ?? []) this.ghosts.add(this.wallGhost(layer, w, elevation, ghost.wallColor ?? GHOST_OK, 0.55));
    for (const color of new Set((ghost.marks ?? []).map((m) => m.color))) {
      // An outlined square per marked cell, slightly inset so neighbors stay apart.
      const points: number[] = [];
      for (const m of ghost.marks!.filter((k) => k.color === color)) {
        const x0 = layer.originX + m.x + 0.08;
        const z0 = layer.originY + m.y + 0.08;
        const x1 = x0 + 0.84;
        const z1 = z0 + 0.84;
        const y = elevation + 0.04;
        points.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
      }
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), new THREE.LineBasicMaterial({ color, depthTest: false }));
      lines.renderOrder = 4;
      this.ghosts.add(lines);
    }
    if (ghost.shapes?.length) {
      // Every face of the definitions, see-through, with their outlines on top.
      const positions: number[] = [];
      const indices: number[] = [];
      for (const { definition, x, y } of ghost.shapes) {
        const v = definition.vertices;
        for (const command of definition.commands) {
          if (command.indices.length < 3 || command.texture === null) continue;
          const base = positions.length / 3;
          for (const i of command.indices) positions.push(layer.originX + x + v[i * 3] / 256, elevation - v[i * 3 + 2] / 256 + 0.004, layer.originY + y + v[i * 3 + 1] / 256);
          indices.push(base, base + 2, base + 1);
          if (command.indices.length === 4) indices.push(base, base + 3, base + 2);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      const color = ghost.shapeColor ?? GHOST_OK;
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 3;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }));
      edges.renderOrder = 4;
      this.ghosts.add(mesh, edges);
    }
    if (ghost.sprite) {
      const mesh = this.makeSpriteMesh(ghost.sprite.type, 0.7);
      mesh.position.set(layer.originX + ghost.sprite.x / 256, elevation + 0.05, layer.originY + ghost.sprite.y / 256);
      mesh.userData.ownsGeometry = true;
      this.ghosts.add(mesh);
    }
    if (ghost.circle) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.05, ghost.circle.radius - 0.06), ghost.circle.radius, 48), new THREE.MeshBasicMaterial({ color: 0xffe08a, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(layer.originX + ghost.circle.x, elevation + 0.05, layer.originY + ghost.circle.y);
      ring.renderOrder = 4;
      this.ghosts.add(ring);
    }
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      // Sprites share one geometry between them; it is not ours to dispose.
      if (!(child instanceof THREE.Sprite)) mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else {
        if (material?.userData.ownsMap) (material as THREE.SpriteMaterial).map?.dispose();
        material?.dispose();
      }
    }
    if (group === this.entities) this.entityMeshes.clear();
  }

  /* -------------------------------------------------------------- camera */

  /** Center the camera on the active layer and pull back to see all of it. */
  frameMap(): void {
    if (!this.state) return;
    const layer = this.activeLayer();
    this.target.set(layer.originX + layer.width / 2, this.state.layer, layer.originY + layer.height / 2);
    this.distance = Math.max(10, Math.min(320, Math.max(layer.width, layer.height) * 1.7));
    this.needsRender = true;
  }

  rotate(steps: number): void {
    this.yaw += (steps * Math.PI) / 4;
    this.needsRender = true;
  }

  private updateCamera(): void {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(this.target.x + this.distance * cp * Math.sin(this.yaw), this.target.y + this.distance * Math.sin(this.pitch), this.target.z + this.distance * cp * Math.cos(this.yaw));
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(0.05, this.distance / 200);
    this.camera.far = this.distance * 8 + 400;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.needsRender = true;
  }

  private frame = (time: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (time - this.lastFrame) / 1000);
    this.lastFrame = time;
    if (this.keys.size && this.canvas.clientWidth === 0) this.keys.clear();
    if (this.keys.size) {
      const speed = this.distance * 0.9 * dt;
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      let moved = false;
      const move = (v: THREE.Vector3, amount: number) => {
        this.target.addScaledVector(v, amount);
        moved = true;
      };
      if (this.keys.has('w') || this.keys.has('arrowup')) move(forward, speed);
      if (this.keys.has('s') || this.keys.has('arrowdown')) move(forward, -speed);
      if (this.keys.has('d') || this.keys.has('arrowright')) move(right, speed);
      if (this.keys.has('a') || this.keys.has('arrowleft')) move(right, -speed);
      if (moved) this.needsRender = true;
    }
    // Effects animate continuously while they are switched on and the view is on screen.
    if (this.state && this.effects && this.canvas.clientWidth > 0) {
      const live = this.state.view.entities && this.state.view.effects && this.effects.active;
      if (live) {
        this.applyFlashes(this.state.view.lighting ? this.effects.update(dt, this.target.x, this.target.z) : (this.effects.update(dt, this.target.x, this.target.z), []));
        this.needsRender = true;
      } else if (this.flashesShown) {
        this.applyFlashes([]);
        this.needsRender = true;
      }
    }
    if (this.walks.length && this.canvas.clientWidth > 0) {
      this.updateWalkers();
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    if (this.state?.view.labels) this.updateTagVisibility();
    if (this.state) this.target.y += (this.state.layer - this.target.y) * 0.35;
    if (this.state && Math.abs(this.state.layer - this.target.y) > 0.002) this.needsRender = true;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  };

  /* -------------------------------------------------------------- picking */

  private ray(clientX: number, clientY: number): THREE.Ray {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.updateCamera();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  private groundPoint(clientX: number, clientY: number, elevation: number): THREE.Vector3 | null {
    return this.ray(clientX, clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation), new THREE.Vector3());
  }

  private pointerInfo(event: PointerEvent | WheelEvent): PointerInfo | null {
    if (!this.state) return null;
    const layer = this.activeLayer();
    const hit = this.groundPoint(event.clientX, event.clientY, this.state.layer);
    if (!hit) return null;
    const x = hit.x - layer.originX;
    const y = hit.z - layer.originY;
    return {
      x,
      y,
      inside: x >= 0 && y >= 0 && x < layer.width && y < layer.height,
      button: 'button' in event ? event.button : 0,
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
      alt: event.altKey,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  /**
   * The face of the active layer under the pointer: which cell it belongs to
   * and whether it is the top or one of the sides. Transparent parts of cut
   * tiles are looked through.
   */
  pickSurface(clientX: number, clientY: number): SurfaceHit | null {
    if (!this.state || !this.composer) return null;
    const mesh = this.layerMeshes[this.state.layer];
    if (!mesh) return null;
    this.ray(clientX, clientY);
    const layer = this.activeLayer();
    const flags = mesh.geometry.getAttribute('aFlags');
    const tiles = mesh.geometry.getAttribute('aTile');
    for (const hit of this.raycaster.intersectObject(mesh, false)) {
      if (!hit.face) continue;
      if (flags.getX(hit.face.a) & FACE_MASKED && hit.uv) {
        const tile = this.composer.tiles[tiles.getX(hit.face.a)];
        const tx = Math.min(63, Math.max(0, Math.floor(hit.uv.x * 64)));
        const ty = Math.min(63, Math.max(0, Math.floor(hit.uv.y * 64)));
        if (tile && tile[ty * 64 + tx] === 0) continue;
      }
      const n = hit.face.normal;
      const px = hit.point.x - layer.originX;
      const py = hit.point.z - layer.originY;
      let face: Face = 'top';
      if (n.y < 0.5) face = Math.abs(n.x) >= Math.abs(n.z) ? (n.x < 0 ? 'west' : 'east') : n.z < 0 ? 'north' : 'south';
      // Step just inside the surface so a face on a cell boundary resolves to the cell it encloses.
      const inset = face === 'top' ? 0 : 0.02;
      return { x: Math.floor(px - n.x * inset), y: Math.floor(py - n.z * inset), px, py, face };
    }
    return null;
  }

  /** The entity under the pointer on a visible layer, nearest the camera first. */
  pickEntity(clientX: number, clientY: number): { layer: number; id: number } | null {
    if (!this.state || !this.state.view.entities) return null;
    const ray = this.ray(clientX, clientY);
    let best: { layer: number; id: number; distance: number } | null = null;
    this.group().layers.forEach((layer, index) => {
      if (this.state!.view.hideUpper && index > this.state!.layer) return;
      const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(index + 0.03)), new THREE.Vector3());
      if (!hit) return;
      for (const e of layer.entities) {
        const dx = hit.x - (layer.originX + e.x / 256);
        const dz = hit.z - (layer.originY + e.y / 256);
        const reach = Math.max(0.3, (this.game.entity(e.type)?.descriptor?.radius ?? 64) / 256);
        const d = Math.hypot(dx, dz);
        if (d <= reach) {
          // Prefer the active layer, then the closest hit.
          const distance = d + (index === this.state!.layer ? 0 : 10);
          if (!best || distance < best.distance) best = { layer: index, id: e.id, distance };
        }
      }
    });
    return best ? { layer: (best as { layer: number }).layer, id: (best as { id: number }).id } : null;
  }

  /* --------------------------------------------------------------- input */

  private preventDefault = (e: Event) => e.preventDefault();
  private clearKeys = () => this.keys.clear();

  private pointerDown = (event: PointerEvent): void => {
    this.canvas.focus();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events have no active pointer to capture */
    }
    if (event.button === 2) this.drag = { mode: 'orbit', x: event.clientX, y: event.clientY };
    else if (event.button === 1 || (event.button === 0 && this.keys.has(' '))) {
      this.drag = { mode: 'pan', x: event.clientX, y: event.clientY, ground: this.groundPoint(event.clientX, event.clientY, this.target.y) ?? undefined };
    } else if (event.button === 0) {
      this.drag = { mode: 'tool', x: event.clientX, y: event.clientY };
      const info = this.pointerInfo(event);
      if (info) this.onPointer('down', info);
    }
  };

  private pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag?.mode === 'orbit') {
      this.yaw -= (event.clientX - drag.x) * 0.006;
      this.pitch = Math.max(THREE.MathUtils.degToRad(12), Math.min(THREE.MathUtils.degToRad(89.5), this.pitch + (event.clientY - drag.y) * 0.005));
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.needsRender = true;
      return;
    }
    if (drag?.mode === 'pan' && drag.ground) {
      const now = this.groundPoint(event.clientX, event.clientY, this.target.y);
      if (now) {
        this.target.x += drag.ground.x - now.x;
        this.target.z += drag.ground.z - now.z;
        this.needsRender = true;
      }
      return;
    }
    const info = this.pointerInfo(event);
    this.onHover(info);
    if (info) this.onPointer('move', info);
  };

  private pointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (drag?.mode === 'tool') {
      const info = this.pointerInfo(event);
      if (info) this.onPointer('up', info);
    }
  };

  private pointerCancel = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    if (drag?.mode === 'tool') {
      const info = this.pointerInfo(event);
      if (info) this.onPointer('cancel', info);
    }
  };

  private pointerLeave = (): void => {
    if (!this.drag) this.onHover(null);
  };

  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    const before = this.groundPoint(event.clientX, event.clientY, this.target.y);
    const factor = Math.exp(event.deltaY * 0.0012);
    this.distance = Math.max(3, Math.min(420, this.distance * factor));
    // Keep the point under the cursor fixed while zooming.
    const after = this.groundPoint(event.clientX, event.clientY, this.target.y);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
    }
    this.needsRender = true;
  };

  private typing(event: KeyboardEvent): boolean {
    const el = event.target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  private keyDown = (event: KeyboardEvent): void => {
    // The builder stays mounted while other screens are shown; only take keys while it is on screen and nothing covers it.
    if (this.typing(event) || event.ctrlKey || event.metaKey || this.canvas.clientWidth === 0 || modalOpen()) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
      this.keys.add(key);
      if (key.startsWith('arrow') || key === ' ') event.preventDefault();
    }
  };

  private keyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };
}
