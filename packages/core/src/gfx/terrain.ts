/**
 * Terrain texture bank (.BIN).
 *
 *   uint32 tileCount
 *   uint32 tileOffset[tileCount]   relative to the first pixel byte; always i * 4096
 *   uint8  pixels[tileCount][64*64]
 *
 * Tiles are 64x64 source-palette indices, row-major, top row first. A face's
 * texture word selects a tile with its low 14 bits.
 *
 * The unmodified engine keeps the tile pointers in a 128-entry table (the
 * largest retail bank has 125 tiles); one more entry would overwrite other
 * game state. The Workshop runtime moves that table, which raises the limit
 * to `MAX_TILES`.
 */
import { ByteReader, ByteWriter, check } from '../util/binary.ts';

export const TILE_SIZE = 64;
export const TILE_BYTES = TILE_SIZE * TILE_SIZE;
/** Tiles the original engine has room for. */
export const RETAIL_MAX_TILES = 128;
/** Tiles a map may use when it is loaded by the Workshop runtime. */
export const MAX_TILES = 1024;

export function decodeTerrainBank(bytes: Uint8Array): Uint8Array[] {
  const r = new ByteReader(bytes);
  const count = r.u32(0);
  check(count > 0 && count <= MAX_TILES, `Terrain bank has an invalid tile count (${count})`);
  const pixelBase = 4 + count * 4;
  check(bytes.length === pixelBase + count * TILE_BYTES, 'Terrain bank size does not match its tile count');
  const tiles: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    check(r.u32(4 + i * 4) === i * TILE_BYTES, `Terrain tile ${i} has a non-sequential offset`);
    tiles.push(bytes.subarray(pixelBase + i * TILE_BYTES, pixelBase + (i + 1) * TILE_BYTES));
  }
  return tiles;
}

export function encodeTerrainBank(tiles: readonly Uint8Array[]): Uint8Array {
  check(tiles.length > 0 && tiles.length <= MAX_TILES, `A terrain bank holds 1..${MAX_TILES} tiles (got ${tiles.length})`);
  const w = new ByteWriter(4 + tiles.length * (4 + TILE_BYTES));
  w.u32(tiles.length);
  tiles.forEach((_, i) => w.u32(i * TILE_BYTES));
  for (const tile of tiles) {
    check(tile.length === TILE_BYTES, 'Terrain tiles must be 64x64 indexed pixels');
    w.bytes(tile);
  }
  return w.finish();
}
