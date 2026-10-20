/**
 * Small 3D pictures of cell definitions for the prop browser, drawn with the
 * same material as the map view so a thumbnail looks like the thing it places.
 *
 * One hidden WebGL canvas is shared by every thumbnail; pictures are rendered
 * a few per frame and cached as image URLs.
 */
import { type CellDefinition, FLAG_SOLID, RAMP_BAND_MASK, type LevelPalette, definitionClass, flagsOf, isDestructible } from '@mh/core';
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { buildLayerGeometry } from './layer-mesh.ts';
import { makePaletteTexture, makeTerrainMaterial, makeTileTexture } from './terrain-material.ts';

const SIZE = 112;
const PER_FRAME = 10;

/** Identity of a definition's shape and textures (not its behavior). */
export const geometryKey = (d: CellDefinition): string => `${Array.from(d.vertices).join(',')}|${d.commands.map((c) => `${c.op}:${c.texture}:${c.indices.join('.')}`).join(';')}`;

/* --------------------------------------------------------- classification */

export type PropCategory = 'floor' | 'wall' | 'block' | 'ramp' | 'special';

export const PROP_CATEGORIES: { id: PropCategory; label: string; hint: string }[] = [
  { id: 'block', label: 'Blocks & platforms', hint: 'Crates, stands and platforms' },
  { id: 'wall', label: 'Walls & pillars', hint: 'Wall pieces, corners, columns and rails' },
  { id: 'ramp', label: 'Ramps & steps', hint: 'Slopes and steps' },
  { id: 'floor', label: 'Floors', hint: 'Flat and partly cut floors' },
  { id: 'special', label: 'Doors & machines', hint: 'Doors, switches and machines, placed as plain scenery' },
];

export interface PropShape {
  category: PropCategory;
  /** Height of the tallest point, in cells. */
  height: number;
}

export function classifyProp(def: CellDefinition): PropShape {
  const v = def.vertices;
  let top = 0;
  for (let i = 2; i < v.length; i += 3) top = Math.min(top, v[i]);
  const height = -top / 256;
  const flags = flagsOf(def.meta);
  let raisedTop = false;
  let slope = false;
  for (const c of def.commands) {
    if (c.indices.length < 3) continue;
    const zs = c.indices.map((i) => v[i * 3 + 2]);
    const footprint = new Set(c.indices.map((i) => `${v[i * 3]},${v[i * 3 + 1]}`)).size;
    if (footprint < 3) continue; // an upright face: all its points stand on one line
    const lowest = Math.max(...zs);
    const highest = Math.min(...zs);
    if (lowest !== highest) slope = true;
    else if (highest <= -24) raisedTop = true;
  }
  let category: PropCategory;
  if (definitionClass(def.meta) !== 0 || isDestructible(def.meta)) category = 'special';
  else if (flags & RAMP_BAND_MASK || slope) category = 'ramp';
  else if (raisedTop) category = 'block';
  else if (height > 0.03 || flags & FLAG_SOLID) category = 'wall';
  else category = 'floor';
  return { category, height };
}

/* -------------------------------------------------------------- rendering */

class ThumbRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private readonly tileTexture: THREE.DataArrayTexture;
  private readonly paletteTexture: THREE.DataTexture;
  private readonly lighting = new Uint8Array(8).fill(22);

  constructor(
    palette: LevelPalette,
    private readonly tiles: readonly Uint8Array[],
  ) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.tileTexture = makeTileTexture(tiles);
    this.paletteTexture = makePaletteTexture(palette);
    this.material = makeTerrainMaterial({ tiles: this.tileTexture, palette: this.paletteTexture });
    this.material.side = THREE.DoubleSide;
    this.material.uniforms.uFullbright.value = 1;
    // Look down on the cell from the south-east, the way the map view opens.
    const reach = 0.98;
    this.camera = new THREE.OrthographicCamera(-reach, reach, reach, -reach, 0.1, 20);
    this.camera.position.set(0.5 + 3, 0.4 + 3.4, 0.5 + 3);
    this.camera.lookAt(0.5, 0.4, 0.5);
  }

  render(def: CellDefinition): string {
    const geometry = buildLayerGeometry({ width: 1, height: 1, originX: 0, originY: 0, elevation: 0, cells: Uint16Array.of(1), lighting: this.lighting, definitions: [def, def], tileCount: this.tiles.length });
    const mesh = new THREE.Mesh(geometry, this.material);
    // A faint footprint so low and partial shapes read against the dark panel.
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3)),
      new THREE.LineBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.35 }),
    );
    this.scene.add(outline, mesh);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.scene.remove(outline, mesh);
    geometry.dispose();
    outline.geometry.dispose();
    (outline.material as THREE.Material).dispose();
    return url;
  }

  dispose(): void {
    this.material.dispose();
    this.tileTexture.dispose();
    this.paletteTexture.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

interface Job {
  key: string;
  def: CellDefinition;
  done: ((url: string) => void)[];
}

/** Renders and caches thumbnails for one tile bank. */
export class PropThumbs {
  private renderer: ThumbRenderer | null = null;
  private readonly cache = new Map<string, string>();
  private readonly queue = new Map<string, Job>();
  private handle = 0;

  constructor(
    private readonly palette: LevelPalette,
    private readonly tiles: readonly Uint8Array[],
  ) {}

  /** A cached picture, or undefined while it is still to be drawn. */
  peek(def: CellDefinition): string | undefined {
    return this.cache.get(geometryKey(def));
  }

  request(def: CellDefinition, done: (url: string) => void): () => void {
    const key = geometryKey(def);
    const cached = this.cache.get(key);
    if (cached) {
      done(cached);
      return () => {};
    }
    let job = this.queue.get(key);
    if (!job) this.queue.set(key, (job = { key, def, done: [] }));
    job.done.push(done);
    if (!this.handle) this.handle = requestAnimationFrame(this.work);
    return () => {
      const pending = this.queue.get(key);
      if (!pending) return;
      pending.done = pending.done.filter((d) => d !== done);
      if (!pending.done.length) this.queue.delete(key);
    };
  }

  private work = (): void => {
    this.handle = 0;
    this.renderer ??= new ThumbRenderer(this.palette, this.tiles);
    let budget = PER_FRAME;
    for (const job of this.queue.values()) {
      if (budget-- <= 0) break;
      this.queue.delete(job.key);
      const url = this.renderer.render(job.def);
      this.cache.set(job.key, url);
      for (const done of job.done) done(url);
    }
    if (this.queue.size) this.handle = requestAnimationFrame(this.work);
  };

  dispose(): void {
    cancelAnimationFrame(this.handle);
    this.queue.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }
}

let shared: { level: string; tiles: readonly Uint8Array[]; thumbs: PropThumbs } | null = null;

/**
 * The thumbnail cache for a tile bank. Tiles are immutable and shared between
 * undo snapshots, so the same pictures serve until a tile is added or removed.
 */
export function sharedPropThumbs(level: string, palette: LevelPalette, tiles: readonly Uint8Array[]): PropThumbs {
  if (shared && shared.level === level && shared.tiles.length === tiles.length && shared.tiles.every((t, i) => t === tiles[i])) return shared.thumbs;
  shared?.thumbs.dispose();
  const copy = tiles.slice();
  shared = { level, tiles: copy, thumbs: new PropThumbs(palette, copy) };
  return shared.thumbs;
}

/** The picture of a definition, once it has been drawn. */
export function usePropThumb(thumbs: PropThumbs, def: CellDefinition): string | undefined {
  const [url, setUrl] = useState(() => thumbs.peek(def));
  useEffect(() => {
    setUrl(thumbs.peek(def));
    return thumbs.request(def, setUrl);
  }, [thumbs, def]);
  return url;
}
