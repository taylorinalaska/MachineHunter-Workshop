import { describe, expect, it } from 'vitest';
import { type GameMap, allObjects, objectRow, parseMap, readLevelTable, writeLmp, writeMap } from '../src/index.ts';
import { gameArchive, hasGameData, retailExe } from './game.ts';

/** Structural view of a map that ignores file layout and pool positions. */
function semantic(map: GameMap) {
  return {
    groups: map.groups.map((g) =>
      g.layers.map((l) => ({
        size: [l.width, l.height, l.originX, l.originY],
        cells: Array.from(l.cells),
        lighting: l.lighting ? Array.from(l.lighting) : null,
        objects: l.objects.map((o) => [o.typeWord, o.x, o.y, o.pathIndex, o.flags]),
      })),
    ),
    definitions: map.definitions.map((d) => ({
      vertices: Array.from(d.vertices),
      commands: d.commands.map((c) => [c.op, c.texture, ...c.indices]),
      automap: d.automap ? Array.from(d.automap) : null,
      complete: d.complete,
    })),
    paths: map.paths,
    textureScrolls: map.textureScrolls,
    textureCycles: map.textureCycles,
  };
}

describe.skipIf(!hasGameData)('retail maps', () => {
  const levels = hasGameData ? readLevelTable(retailExe()) : [];

  it.each(levels.map((l) => [l.id, l] as const))('%s parses, rewrites and re-parses identically', (_id, level) => {
    const arc = gameArchive();
    const lmpBytes = arc.read(level.resources.lmp);
    const original = parseMap(arc.read(level.resources.map), { lmp: lmpBytes });
    expect(original.info.incompleteDefinitions).toEqual([]);

    // Retail rows are already in the order the writer produces.
    for (const group of original.groups) {
      for (const layer of group.layers) {
        for (let i = 1; i < layer.objects.length; i++) {
          const a = layer.objects[i - 1];
          const b = layer.objects[i];
          expect(objectRow(a) < objectRow(b) || (objectRow(a) === objectRow(b) && a.x <= b.x)).toBe(true);
        }
      }
    }

    const written = writeMap(original);
    const lmp = writeLmp(original.definitions);
    const again = parseMap(written.bytes, { lmp });
    expect(semantic(again)).toEqual(semantic(original));
    expect(written.objectOrder.length).toBe([...allObjects(original)].length);

    // Object references in metadata must follow their objects. SEWER1 ships
    // three actions naming an object index (573) that does not exist.
    expect(written.unresolvedObjectReferences.length).toBe(level.id === 'SEWER1' ? 3 : 0);
    const metaOf = (m: GameMap) => m.definitions.map((d) => Array.from(d.meta));
    if (!original.info.unlinkedObjectSlots) expect(metaOf(again)).toEqual(metaOf(original));

    // A second pass must be a fixed point at the byte level.
    expect(writeMap(again).bytes).toEqual(written.bytes);
  });
});
