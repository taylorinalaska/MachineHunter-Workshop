/**
 * GPU version of the game's indexed-color terrain renderer.
 *
 * Tiles are kept as 8-bit source indices in a texture array. The fragment
 * shader looks the index up in a 256 x 32 table that already combines the
 * level's .BRT (light row) and .PLT (display color), so a face is lit
 * exactly as the software renderer would light it:
 *
 *   light = clamp(lattice / 2 + 4 + bias - |height above focus| / 96 + dynamic, 0, 31)
 *   color = PLT[ BRT[light][index] ]
 *
 * `dynamic` is the game's short-lived lights (the flicker of the light-emitter
 * entities): up to 15 levels at the source, falling to nothing 1.25 cells
 * away, on the layer the source stands on.
 */
import { type LevelPalette, TILE_SIZE } from '@mh/core';
import * as THREE from 'three';

export function makeTileTexture(tiles: readonly Uint8Array[]): THREE.DataArrayTexture {
  const depth = Math.max(1, tiles.length);
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * depth);
  tiles.forEach((tile, i) => data.set(tile, i * TILE_SIZE * TILE_SIZE));
  const texture = new THREE.DataArrayTexture(data, TILE_SIZE, TILE_SIZE, depth);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.internalFormat = 'R8';
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** 256 (source index) x 32 (light row) RGBA lookup for lighting bank 0. */
export function makePaletteTexture(palette: LevelPalette): THREE.DataTexture {
  const data = new Uint8Array(256 * 32 * 4);
  for (let light = 0; light < 32; light++) data.set(palette.rgbaTable(light), light * 256 * 4);
  const texture = new THREE.DataTexture(data, 256, 32, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}


export const FACE_MASKED = 1;
export const FACE_FLAT = 2;
/** Dynamic lights the shader can show at once. */
export const FLASH_COUNT = 8;

const vertexShader = /* glsl */ `
  in float aTile;
  in float aLight;
  in float aFlags;
  uniform float uFocusY;
  uniform float uBias;
  uniform float uFullbright;
  uniform float uStorey;
  uniform vec4 uFlash[${FLASH_COUNT}]; // x, z, layer, strength (0 = unused)
  out vec2 vUv;
  out float vLight;
  flat out float vTile;
  flat out float vFlags;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    // The engine halves the lattice value, adds 4 and the brightness setting,
    // then darkens by one row per 96 units (0.375 cell) of height from the view focus.
    float falloff = floor(abs(world.y - uFocusY) * 256.0 / 96.0);
    float dynamic = 0.0;
    for (int i = 0; i < ${FLASH_COUNT}; i++) {
      if (uFlash[i].w > 0.0 && abs(uFlash[i].z - uStorey) < 0.5) {
        dynamic += uFlash[i].w * max(0.0, 1.0 - distance(world.xz, uFlash[i].xy) / 1.25);
      }
    }
    float lit = clamp(floor(aLight / 2.0) + 4.0 + uBias - falloff + floor(dynamic), 0.0, 31.0);
    vLight = mix(lit, 15.0, uFullbright);
    vUv = uv;
    vTile = aTile;
    vFlags = aFlags;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray uTiles;
  uniform sampler2D uPalette;
  uniform float uDim;
  uniform float uOpacity;
  in vec2 vUv;
  in float vLight;
  flat in float vTile;
  flat in float vFlags;
  out vec4 outColor;
  void main() {
    int flags = int(vFlags + 0.5);
    vec3 color;
    if ((flags & ${FACE_FLAT}) != 0) {
      color = vec3(0.07, 0.075, 0.085);
    } else {
      float index = floor(texture(uTiles, vec3(clamp(vUv, 0.0, 0.9999), vTile)).r * 255.0 + 0.5);
      if ((flags & ${FACE_MASKED}) != 0 && index < 0.5) discard;
      color = texelFetch(uPalette, ivec2(int(index), int(floor(vLight + 0.001))), 0).rgb;
    }
    outColor = vec4(color * uDim, uOpacity);
  }
`;

export interface TerrainUniforms {
  tiles: THREE.DataArrayTexture;
  palette: THREE.DataTexture;
}

export function makeTerrainMaterial(u: TerrainUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: {
      uTiles: { value: u.tiles },
      uPalette: { value: u.palette },
      uFocusY: { value: 0 },
      uBias: { value: 0 },
      uFullbright: { value: 0 },
      uDim: { value: 1 },
      uOpacity: { value: 1 },
      uStorey: { value: 0 },
      uFlash: { value: Array.from({ length: FLASH_COUNT }, () => new THREE.Vector4()) },
    },
    side: THREE.FrontSide,
  });
}
