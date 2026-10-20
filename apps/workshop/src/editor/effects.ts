/**
 * Live preview of the game's effect entities: smoke, fire, bubbles, steam, the
 * teleporter swirl, torch flames and flickering lights.
 *
 * These entities have no sprite of their own. Each one spawns short-lived
 * effect particles on a timer; what a particle looks like and how it moves
 * comes from the engine's effect table, which is read from the user's
 * executable here. The timers and motion below are transcribed from the
 * update routines of the emitters and particles (addresses in
 * research/notes/renderer_and_compiler_findings.md, section 13).
 *
 * The simulation runs at the game's update rate; particles are drawn as
 * camera-facing sprites in one instanced batch.
 */
import { type PeImage, readAnimationSource } from '@mh/core';
import * as THREE from 'three';
import type { GameData } from '../game/gamedata.ts';

/** Game updates per second the preview assumes. */
export const UPDATES_PER_SECOND = 30;

const EFFECT_TABLE = 0x00481130;
const EFFECT_COUNT = 0xbd;
/** World size, in cells, of a 64-pixel frame at Q14 scale 1.0. */
const CELLS_PER_FRAME = 1;
const UNITS = 256;

/** How a particle moves each update, by the address of its update routine. */
const MOTION: Record<number, { rise?: number; fade: number; jitter?: number; forward?: number }> = {
  0x004163c0: { rise: 2, fade: 2, jitter: 2 }, // bubble: drifts up, wobbling
  0x00416050: { fade: 16 }, // flash
  0x00416320: { rise: 3.5, fade: 4 }, // smoke puff
  0x00416810: { rise: 6, fade: 7 }, // teleporter orb
  0x004169b0: { fade: 5 }, // teleporter ring
  0x00417360: { rise: 40, fade: 10 }, // steam jet, upwards
  0x004173a0: { forward: 15, fade: 10 }, // steam jet, along the emitter's heading
};
/** The orb's init routine sets full brightness itself. */
const INIT_FULL_FADE = 0x00416720;

export interface EffectKind {
  id: number;
  slot: number;
  frameBase: number;
  frameSpan: number;
  mode: number;
  tick: number;
  /** Start size as a multiple of the frame's own size. */
  scale: number;
  /** Size added per update. */
  growth: number;
  /** Turn per update in radians; `spinRandom` picks a value in +/- this at spawn. */
  spin: number;
  spinRandom: boolean;
  /** Brightness counter at spawn; the particle dies when it runs out. */
  fadeStart: number;
  /** Height above the spawn point, in map units. */
  z: number;
  motion: { rise?: number; fade: number; jitter?: number; forward?: number };
}

const thunkTarget = (exe: PeImage, va: number): number => (va && exe.isFileBacked(va) && exe.u8(va) === 0xe9 ? (va + 5 + exe.i32(va + 1)) >>> 0 : va);

/** Decode one entry of the engine's effect table. */
export function readEffectKind(exe: PeImage, id: number): EffectKind | null {
  if (id <= 0 || id >= EFFECT_COUNT) return null;
  const desc = exe.u32(EFFECT_TABLE + id * 8 + 4);
  if (!desc || !exe.isFileBacked(desc + 0x37)) return null;
  const anim = readAnimationSource(exe, desc + 0x10);
  if (!anim) return null;
  const update = thunkTarget(exe, exe.u32(desc + 4));
  const init = thunkTarget(exe, exe.u32(desc));
  const spinWord = exe.i16(desc + 0x28);
  const fadeByte = exe.u8(desc + 0x2a);
  const turn = (Math.PI * 2) / 2048;
  return {
    id,
    slot: anim.slot,
    frameBase: anim.frameBase,
    frameSpan: Math.max(1, anim.frameSpan),
    mode: anim.mode,
    tick: Math.max(1, anim.tickReload),
    scale: anim.scale / 0x4000,
    growth: exe.i32(desc + 0x24) / 0x4000,
    spin: (spinWord >> 1) * turn,
    spinRandom: (spinWord & 1) === 1,
    fadeStart: init === INIT_FULL_FADE ? 255 : fadeByte ? Math.min(255, fadeByte << 3) : 255,
    z: exe.i16(desc + 0x0c),
    // An effect whose update routine has not been transcribed just plays its frames and fades.
    motion: MOTION[update] ?? { fade: 8 },
  };
}

/* ---------------------------------------------------------------- emitters */

interface SpawnSpec {
  fx: number;
  /** Random X/Y offset, +/- this many map units. */
  scatter?: number;
  /** Start at the previous particle's position (fire: flash, then smoke from the same spot). */
  sameSpot?: boolean;
  randomTurn?: boolean;
  /** Fixed distance from the emitter, at the emitter's turning angle (teleporter). */
  ring?: number;
  /** Ring particles of this spawn turn the other way. */
  mirrored?: boolean;
}

export interface EmitterSpec {
  /** Game updates between spawns. */
  every: number;
  spawn: SpawnSpec[];
  /** Angle added per spawn, for ring emitters (in 1/2048 turns). */
  turn?: number;
}

/** What each emitter entity type does, from its update routine. */
export const EMITTERS: Record<number, EmitterSpec> = {
  82: { every: 16, spawn: [{ fx: 0x94 }] },
  84: { every: 4, spawn: [{ fx: 0xa7, scatter: 32, randomTurn: true }, { fx: 0x7d, sameSpot: true }] },
  90: { every: 4, spawn: [{ fx: 0x7d, scatter: 32 }] },
  44: { every: 16, spawn: [{ fx: 0x67 }] },
  40: { every: 8, spawn: [{ fx: 0xbc }] },
  85: { every: 2, turn: 0x2d0, spawn: [{ fx: 0xb6, ring: 27 }, { fx: 0xb5, ring: 110, mirrored: true }] },
  86: { every: 2, turn: 0x2d0, spawn: [{ fx: 0xb6, ring: 27 }, { fx: 0xb5, ring: 110, mirrored: true }] },
};

/**
 * The four dynamic-light emitters. Each update they have a 15-in-256 chance of
 * lighting their surroundings for `updates` updates: 15 light levels at the
 * center, fading to nothing 1.25 cells away.
 */
export const LIGHT_EMITTERS: Record<number, { updates: number }> = { 78: { updates: 2 }, 87: { updates: 1 }, 88: { updates: 1 }, 89: { updates: 1 } };
export const LIGHT_CHANCE = 15 / 256;
export const LIGHT_RADIUS = 1.25;
export const LIGHT_PEAK = 15;

/** Entity types drawn as an upright, animated sprite instead of a decal on the floor. */
export const STANDING_SPRITES = new Set([81]);

export const isEffectEntity = (type: number): boolean => type in EMITTERS || type in LIGHT_EMITTERS || STANDING_SPRITES.has(type);

/** An effect source placed in the world, in cells (y is up). */
export interface EffectSource {
  type: number;
  x: number;
  y: number;
  z: number;
  /** Layer index, for lights. */
  layer: number;
  /** Facing in radians, for directional emitters. */
  heading: number;
  disabled: boolean;
  /** A custom effect's recipe, used instead of the retail emitter of `type`. */
  spec?: EmitterSpec;
}

/** What a custom effect spawns, in the terms the retail emitters are described in. */
export const customEmitterSpec = (effect: { every: number; particles: { fx: number; spread: number }[] }): EmitterSpec => ({
  every: Math.max(1, effect.every),
  spawn: effect.particles.map((p) => ({ fx: p.fx, scatter: p.spread || undefined })),
});

export interface LightFlash {
  x: number;
  z: number;
  layer: number;
  strength: number;
}

interface Particle {
  kind: EffectKind;
  x: number;
  y: number;
  z: number;
  fade: number;
  age: number;
  size: number;
  rotation: number;
  spin: number;
  heading: number;
}

/* ------------------------------------------------------------- sprite atlas */

const ATLAS_CELLS = 16;
const ATLAS_CELL_PIXELS = 64;

/** Sprite frames copied into one texture so every particle can be drawn in a single batch. */
class SpriteAtlas {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private readonly cells = new Map<string, number>();
  /** Frame size as a fraction of an atlas cell, by cell index. */
  readonly extent: number[] = [];

  constructor(
    private readonly game: GameData,
    private readonly level: string,
  ) {
    this.canvas.width = this.canvas.height = ATLAS_CELLS * ATLAS_CELL_PIXELS;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.NoColorSpace;
  }

  /** Atlas cell holding a frame, or -1 when the level does not load that sprite file. */
  cell(container: string, frame: number): number {
    const key = `${container}:${frame}`;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      const image = this.game.frameImage(container, frame, this.game.levelUsing(container, this.level));
      if (!image || this.cells.size >= ATLAS_CELLS * ATLAS_CELLS) cell = -1;
      else {
        cell = this.cells.size;
        const g = this.canvas.getContext('2d')!;
        const x = (cell % ATLAS_CELLS) * ATLAS_CELL_PIXELS + (ATLAS_CELL_PIXELS - image.width) / 2;
        const y = Math.floor(cell / ATLAS_CELLS) * ATLAS_CELL_PIXELS + (ATLAS_CELL_PIXELS - image.height) / 2;
        g.drawImage(image, x, y);
        this.texture.needsUpdate = true;
      }
      this.cells.set(key, cell);
    }
    return cell;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/* ------------------------------------------------------------------ batches */

const vertexShader = /* glsl */ `
  in vec3 aCenter;
  in vec4 aParams; // size in cells, rotation, brightness, atlas cell
  uniform float uCells;
  out vec2 vUv;
  out float vBrightness;
  void main() {
    float s = sin(aParams.y);
    float c = cos(aParams.y);
    vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aParams.x;
    vec4 view = viewMatrix * vec4(aCenter, 1.0);
    view.xy += corner;
    gl_Position = projectionMatrix * view;
    vec2 origin = vec2(mod(aParams.w, uCells), floor(aParams.w / uCells));
    vUv = (origin + vec2(uv.x, 1.0 - uv.y)) / uCells;
    vBrightness = aParams.z;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uAtlas;
  in vec2 vUv;
  in float vBrightness;
  out vec4 outColor;
  void main() {
    vec4 texel = texture(uAtlas, vUv);
    if (texel.a < 0.5) discard;
    outColor = vec4(texel.rgb * vBrightness, 1.0);
  }
`;

class Batch {
  readonly mesh: THREE.Mesh;
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  count = 0;

  constructor(
    atlas: SpriteAtlas,
    readonly capacity: number,
    additive: boolean,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.centers.setUsage(THREE.DynamicDrawUsage);
    this.params.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aCenter', this.centers);
    this.geometry.setAttribute('aParams', this.params);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: { uAtlas: { value: atlas.texture }, uCells: { value: ATLAS_CELLS } },
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      transparent: additive,
      depthWrite: !additive,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 6 : 2;
  }

  begin(): void {
    this.count = 0;
  }

  add(x: number, y: number, z: number, size: number, rotation: number, brightness: number, cell: number): void {
    if (cell < 0 || this.count >= this.capacity) return;
    const i = this.count++;
    this.centers.setXYZ(i, x, y, z);
    this.params.setXYZW(i, size, rotation, brightness, cell);
  }

  end(): void {
    this.geometry.instanceCount = this.count;
    this.centers.needsUpdate = true;
    this.params.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/* -------------------------------------------------------------------- layer */

const MAX_PARTICLES = 6000;
const MAX_FLASHES = 8;

/** Simulates and draws every effect source of the area on screen. */
export class EffectsLayer {
  readonly object = new THREE.Group();
  private readonly atlas: SpriteAtlas;
  private readonly glow: Batch;
  private readonly solid: Batch;
  private readonly kinds = new Map<number, EffectKind | null>();
  private sources: EffectSource[] = [];
  private angles: number[] = [];
  private particles: Particle[] = [];
  private flashes: (LightFlash & { left: number })[] = [];
  private tick = 0;
  private carry = 0;

  constructor(
    private readonly game: GameData,
    private readonly level: string,
  ) {
    this.atlas = new SpriteAtlas(game, level);
    this.glow = new Batch(this.atlas, MAX_PARTICLES, true);
    this.solid = new Batch(this.atlas, 1024, false);
    this.object.add(this.solid.mesh, this.glow.mesh);
  }

  get active(): boolean {
    return this.sources.length > 0;
  }

  setSources(sources: EffectSource[]): void {
    this.sources = sources;
    this.angles = sources.map((_, i) => this.angles[i] ?? 0);
  }

  private kind(id: number): EffectKind | null {
    if (!this.kinds.has(id)) this.kinds.set(id, readEffectKind(this.game.exe, id));
    return this.kinds.get(id)!;
  }

  private container(slot: number): string | null {
    return this.game.level(this.level).slots.get(slot) ?? null;
  }

  private spawn(source: EffectSource, index: number, spec: EmitterSpec): void {
    let lastX = source.x;
    let lastZ = source.z;
    for (const s of spec.spawn) {
      const kind = this.kind(s.fx);
      if (!kind || this.particles.length >= MAX_PARTICLES) continue;
      let x = source.x;
      let z = source.z;
      if (s.sameSpot) {
        x = lastX;
        z = lastZ;
      } else if (s.scatter) {
        x += (Math.floor(Math.random() * s.scatter * 2) - s.scatter) / UNITS;
        z += (Math.floor(Math.random() * s.scatter * 2) - s.scatter) / UNITS;
      } else if (s.ring) {
        const a = (this.angles[index] / 2048) * Math.PI * 2;
        x += ((s.mirrored ? Math.cos(a) : Math.sin(a)) * s.ring) / UNITS;
        z += ((s.mirrored ? Math.sin(a) : Math.cos(a)) * s.ring) / UNITS;
      }
      lastX = x;
      lastZ = z;
      this.particles.push({
        kind,
        x,
        y: source.y + kind.z / UNITS,
        z,
        fade: kind.fadeStart,
        age: 0,
        size: kind.scale,
        rotation: s.randomTurn ? Math.random() * Math.PI * 2 : 0,
        spin: kind.spinRandom ? (Math.random() * 2 - 1) * Math.abs(kind.spin) : kind.spin,
        heading: source.heading,
      });
    }
  }

  private step(): void {
    this.tick++;
    this.sources.forEach((source, index) => {
      if (source.disabled) return;
      const emitter = source.spec ?? EMITTERS[source.type];
      if (emitter && this.tick % emitter.every === 0) {
        if (emitter.turn) this.angles[index] = (this.angles[index] + emitter.turn) & 0x7ff;
        this.spawn(source, index, emitter);
      }
      const light = LIGHT_EMITTERS[source.type];
      if (light && Math.random() < LIGHT_CHANCE) this.flashes.push({ x: source.x, z: source.z, layer: source.layer, strength: LIGHT_PEAK, left: light.updates });
    });
    for (const p of this.particles) {
      const m = p.kind.motion;
      p.age++;
      if (m.rise) p.y += m.rise / UNITS;
      if (m.jitter) {
        p.x += (Math.random() * 2 - 1) * (m.jitter / UNITS);
        p.z += (Math.random() * 2 - 1) * (m.jitter / UNITS);
      }
      if (m.forward) {
        p.x += (Math.sin(p.heading) * m.forward) / UNITS;
        p.z += (Math.cos(p.heading) * m.forward) / UNITS;
      }
      p.size += p.kind.growth;
      p.rotation += p.spin;
      p.fade -= m.fade;
    }
    this.particles = this.particles.filter((p) => p.fade > 0);
    for (const f of this.flashes) f.left--;
    this.flashes = this.flashes.filter((f) => f.left >= 0);
  }

  /**
   * Advance by `seconds` of real time and refresh what is drawn. Returns the
   * lights that are lit right now, nearest to `focus` first.
   */
  update(seconds: number, focusX: number, focusZ: number): LightFlash[] {
    this.carry += Math.min(0.25, seconds) * UPDATES_PER_SECOND;
    while (this.carry >= 1) {
      this.carry -= 1;
      this.step();
    }
    this.glow.begin();
    this.solid.begin();
    for (const p of this.particles) {
      const container = this.container(p.kind.slot);
      if (!container) continue;
      const k = p.kind;
      const step = Math.floor(p.age / k.tick);
      const frame = k.mode === 2 ? k.frameBase + (step % k.frameSpan) : k.frameBase + Math.min(k.frameSpan - 1, k.mode === 1 ? 0 : step);
      // The fade counter is the brightness row the sprite is drawn with: 15 is its true color.
      this.glow.add(p.x, p.y, p.z, Math.max(0.02, p.size) * CELLS_PER_FRAME, p.rotation, Math.min(1.6, (p.fade >> 3) / 15 + 0.08), this.atlas.cell(container, frame));
    }
    // Standing sprites: the torch flame plays its own animation on top of whatever it stands on.
    for (const source of this.sources) {
      if (!STANDING_SPRITES.has(source.type)) continue;
      const anim = this.game.entity(source.type)?.descriptor?.primaryAnimation;
      const container = anim ? this.container(anim.slot) : null;
      if (!anim || !container) continue;
      const span = Math.max(1, anim.frameSpan);
      const frame = anim.frameBase + (Math.floor(this.tick / Math.max(1, anim.tickReload)) % span);
      const size = (anim.scale / 0x4000) * CELLS_PER_FRAME;
      this.solid.add(source.x, source.y + size * 0.22, source.z, size, 0, source.disabled ? 0.45 : 1, this.atlas.cell(container, frame));
    }
    this.glow.end();
    this.solid.end();
    return this.flashes
      .map((f) => ({ x: f.x, z: f.z, layer: f.layer, strength: f.strength }))
      .sort((a, b) => Math.hypot(a.x - focusX, a.z - focusZ) - Math.hypot(b.x - focusX, b.z - focusZ))
      .slice(0, MAX_FLASHES);
  }

  dispose(): void {
    this.glow.dispose();
    this.solid.dispose();
    this.atlas.dispose();
  }
}

export const FLASH_SLOTS = MAX_FLASHES;
