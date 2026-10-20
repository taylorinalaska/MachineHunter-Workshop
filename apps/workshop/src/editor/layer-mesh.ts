/** Builds renderable geometry for one layer from its composed cell definitions. */
import { type CellDefinition, DEFINITION_MASK, TEXTURED_OPS, TEXTURE_INDEX_MASK, TEXTURE_MASKED, isControlOp, uvRotation } from '@mh/core';
import * as THREE from 'three';
import { FACE_FLAT, FACE_MASKED } from './terrain-material.ts';

/** Tile corners in the order the renderer hands them to a quad's vertices. */
const UV_CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

export interface LayerGeometryInput {
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** Height of the layer's floor, in cells. */
  elevation: number;
  /** Composed cell words. */
  cells: Uint16Array;
  lighting: Uint8Array;
  definitions: readonly CellDefinition[];
  tileCount: number;
}

/** Lattice light (0..31, before the engine's halving) at a point of the layer. */
export function sampleLight(lighting: Uint8Array, width: number, height: number, x: number, y: number, heightUnits: number): number {
  const xi = Math.max(0, Math.min(width, Math.floor(x)));
  const yi = Math.max(0, Math.min(height, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - xi));
  const fy = Math.max(0, Math.min(1, y - yi));
  const x1 = Math.min(width, xi + 1);
  const y1 = Math.min(height, yi + 1);
  const stride = width + 1;
  const at = (px: number, py: number, plane: number) => lighting[(py * stride + px) * 2 + plane] & 31;
  const bilinear = (plane: number) => {
    const top = at(xi, yi, plane) + (at(x1, yi, plane) - at(xi, yi, plane)) * fx;
    const bottom = at(xi, y1, plane) + (at(x1, y1, plane) - at(xi, y1, plane)) * fx;
    return top + (bottom - top) * fy;
  };
  const floor = bilinear(0);
  const fz = Math.max(0, Math.min(255, heightUnits)) / 256;
  return fz > 0 ? floor + (bilinear(1) - floor) * fz : floor;
}

export function buildLayerGeometry(input: LayerGeometryInput): THREE.BufferGeometry {
  const { width, height, cells, definitions, lighting } = input;
  const positions: number[] = [];
  const uvs: number[] = [];
  const tiles: number[] = [];
  const lights: number[] = [];
  const flags: number[] = [];
  const indices: number[] = [];

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const def = definitions[cells[cy * width + cx] & DEFINITION_MASK];
      if (!def || !def.commands.length) continue;
      const v = def.vertices;
      for (const command of def.commands) {
        if (isControlOp(command.op)) continue;
        const textured = TEXTURED_OPS.has(command.op);
        const texture = command.texture ?? 0;
        const tile = texture & TEXTURE_INDEX_MASK;
        const faceFlags = !textured || tile >= input.tileCount ? FACE_FLAT : texture & TEXTURE_MASKED ? FACE_MASKED : 0;
        const rotation = uvRotation(command.op);
        const base = positions.length / 3;
        const count = command.indices.length;
        for (let k = 0; k < count; k++) {
          const i = command.indices[k] * 3;
          const lx = cx + v[i] / 256;
          const ly = cy + v[i + 1] / 256;
          const up = -v[i + 2] / 256;
          positions.push(input.originX + lx, input.elevation + up, input.originY + ly);
          const corner = UV_CORNERS[(k - rotation + 4) & 3];
          uvs.push(corner[0], corner[1]);
          tiles.push(tile);
          lights.push(sampleLight(lighting, width, height, lx, ly, up * 256));
          flags.push(faceFlags);
        }
        // The game's front faces wind clockwise on screen; three.js wants counter-clockwise.
        indices.push(base, base + 2, base + 1);
        if (count === 4) indices.push(base, base + 3, base + 2);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aTile', new THREE.Float32BufferAttribute(tiles, 1));
  geometry.setAttribute('aLight', new THREE.Float32BufferAttribute(lights, 1));
  geometry.setAttribute('aFlags', new THREE.Float32BufferAttribute(flags, 1));
  geometry.setIndex(indices);
  return geometry;
}
