/** Custom terrain textures: turning pictures into tiles, and taking tiles back out of a map. */
import { type LevelPalette, type MapProject, type Surface, TEXTURE_INDEX_MASK, TILE_SIZE, neutralColors, quantizeRgba, shadableIndices, sliceTiles } from '@mh/core';

/** Largest picture that is cut into a sheet of tiles instead of being scaled down to one. */
const MAX_SHEET = 512;

export interface ImportedTiles {
  name: string;
  tiles: Uint8Array[];
}

/**
 * Convert pictures to tiles in a level's colors. A picture whose sides are
 * both multiples of 64 (up to 512) is treated as a sheet and cut into tiles,
 * left to right and top to bottom; anything else is scaled to a single tile.
 */
export async function imagesToTiles(files: readonly File[], palette: LevelPalette, dither: boolean): Promise<ImportedTiles[]> {
  const allowed = shadableIndices(palette);
  const colors = neutralColors(palette);
  const out: ImportedTiles[] = [];
  for (const file of files) {
    const bitmap = await createImageBitmap(file);
    const sheet = bitmap.width % TILE_SIZE === 0 && bitmap.height % TILE_SIZE === 0 && bitmap.width <= MAX_SHEET && bitmap.height <= MAX_SHEET;
    const width = sheet ? bitmap.width : TILE_SIZE;
    const height = sheet ? bitmap.height : TILE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = 'high';
    if (sheet) g.drawImage(bitmap, 0, 0);
    else {
      // Fill the tile, cropping the longer side evenly.
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      g.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    }
    bitmap.close();
    const pixels = quantizeRgba(g.getImageData(0, 0, width, height).data, width, height, { allowed, colors, dither });
    out.push({ name: file.name, tiles: sliceTiles(pixels, width, height) });
  }
  return out;
}

/**
 * Remove a tile that was added to the map. Faces that used it fall back to
 * `fallback`; references to later tiles move down by one.
 */
export function removeCustomTile(project: MapProject, index: number, fallback = 0): void {
  if (index < project.baseTileCount || index >= project.tiles.length) return;
  const remap = (word: number): number => {
    const tile = word & TEXTURE_INDEX_MASK;
    if (tile < index) return word;
    return (word & ~TEXTURE_INDEX_MASK) | (tile === index ? fallback : tile - 1);
  };
  const remapNullable = (word: number | null): number | null => (word === null ? null : remap(word));
  const remapSides = (sides: Partial<Record<string, number>>) => {
    for (const key of Object.keys(sides)) sides[key] = remap(sides[key]!);
  };
  const remapSurface = (s: Surface) => {
    if (s.kind === 'floor') s.tile = remapNullable(s.tile);
    else if (s.kind === 'ramp') {
      s.tile = remapNullable(s.tile);
      remapSides(s.sides);
    } else if (s.kind === 'block') {
      s.topTile = remapNullable(s.topTile);
      s.floorTile = remapNullable(s.floorTile);
      remapSides(s.sides);
    } else if (s.kind === 'split') for (const half of Object.values(s.halves)) half!.tile = remapNullable(half!.tile);
  };
  for (const group of project.groups) {
    for (const layer of group.layers) {
      for (const surface of layer.surfaces.values()) remapSurface(surface);
      for (const wall of layer.walls.values()) wall.tile = remapNullable(wall.tile);
    }
  }
  // Library definitions are shared with undo snapshots, so changed ones are replaced, not edited.
  project.definitions = project.definitions.map((def) =>
    def.commands.some((c) => c.texture !== undefined && c.texture !== null && (c.texture & TEXTURE_INDEX_MASK) >= index) ? { ...def, commands: def.commands.map((c) => (c.texture === undefined || c.texture === null ? c : { ...c, texture: remap(c.texture) })) } : def,
  );
  project.tiles.splice(index, 1);
}
