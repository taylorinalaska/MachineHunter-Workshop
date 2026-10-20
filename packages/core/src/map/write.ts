/**
 * .MAP and .LMP writers. Both always emit a complete, freshly laid out file;
 * nothing is patched in place, so a map can change shape freely.
 *
 * Section order matches the retail files:
 *   header, group table, layer descriptors, per-layer blocks
 *   (row directory, cells, lighting, row bank), object pool, geometry,
 *   metadata, texture scrolls, texture cycles, path directory.
 */
import { ByteWriter, check, concatBytes } from '../util/binary.ts';
import {
  type CellDefinition,
  type FaceCommand,
  FLAT_QUAD_OPS,
  type GameMap,
  LAYER_DESCRIPTOR_BYTES,
  MAX_DEFINITIONS,
  MAX_LMP_BYTES,
  MAX_MAP_BYTES,
  type MapLayer,
  type MapObject,
  OBJECT_RECORD_BYTES,
  OP_TRIANGLE,
  TEXTURED_OPS,
  lightingSize,
} from './model.ts';
import { ACTION_ENABLE_OBJECT, ACTION_ENABLE_TYPE, CLASS_ACTION, definitionClass } from './definition-meta.ts';

export function encodeVertexStream(vertices: Int16Array): Uint8Array {
  check(vertices.length % 3 === 0, 'Vertex data must be x,y,z triples');
  const w = new ByteWriter(4 + vertices.length * 2);
  w.u32(vertices.length / 3);
  for (const v of vertices) w.i16(v);
  return w.finish();
}

export function encodeFaceStream(commands: readonly FaceCommand[]): Uint8Array {
  const w = new ByteWriter(2 + commands.length * 12);
  for (const c of commands) {
    const expected = c.op === 1 || c.op === 18 ? 0 : c.op === 2 ? 2 : c.op === OP_TRIANGLE ? 3 : TEXTURED_OPS.has(c.op) || FLAT_QUAD_OPS.has(c.op) ? 4 : -1;
    check(expected >= 0, `Face opcode ${c.op} cannot be written`);
    check(c.indices.length === expected, `Face opcode ${c.op} needs ${expected} operand(s)`);
    w.u16(c.op);
    if (TEXTURED_OPS.has(c.op)) {
      check(c.texture !== null && c.texture >= 0 && c.texture <= 0xffff, `Face opcode ${c.op} needs a texture word`);
      w.u16(c.texture);
    }
    for (const i of c.indices) w.u16(i);
  }
  w.u16(0);
  return w.finish();
}

/** Row an object is linked into: the engine walks rows by cell Y and expects ascending X inside a row. */
export function objectRow(object: Pick<MapObject, 'y'>): number {
  return object.y >> 8;
}

/** A layer's objects in pool order (row, then X; ties keep their current order). */
export function sortLayerObjects(layer: MapLayer): MapObject[] {
  return layer.objects
    .map((object, order) => ({ object, order }))
    .sort((a, b) => objectRow(a.object) - objectRow(b.object) || a.object.x - b.object.x || a.order - b.order)
    .map((e) => e.object);
}

export interface WrittenMap {
  bytes: Uint8Array;
  /** Final pool position of every object, in file order. */
  objectOrder: MapObject[];
  /** Action definitions whose target object could not be resolved (left untouched). */
  unresolvedObjectReferences: number[];
}

export function writeMap(map: GameMap): WrittenMap {
  const { groups, definitions } = map;
  check(groups.length >= 1 && groups.length <= 32, 'A map needs 1..32 groups');
  check(definitions.length >= 1 && definitions.length <= MAX_DEFINITIONS, `A map holds 1..${MAX_DEFINITIONS} cell definitions`);

  /* --------------------------------------------- object pool ordering */
  const objectOrder: MapObject[] = [];
  const rowStart = new Map<MapLayer, Int32Array>(); // first pool index per row, -1 when empty
  const rowEnd = new Set<number>(); // pool indices that end their row
  for (const group of groups) {
    for (const layer of group.layers) {
      const starts = new Int32Array(layer.height).fill(-1);
      let previousRow = -1;
      for (const object of sortLayerObjects(layer)) {
        const row = objectRow(object);
        check(object.x >= 0 && object.x < layer.width * 256 && row >= 0 && row < layer.height, 'An object lies outside its layer');
        if (row !== previousRow) {
          if (objectOrder.length) rowEnd.add(objectOrder.length - 1);
          starts[row] = objectOrder.length;
          previousRow = row;
        }
        objectOrder.push(object);
      }
      if (objectOrder.length) rowEnd.add(objectOrder.length - 1);
      rowStart.set(layer, starts);
    }
  }

  /* ------------------------------------------------------ layout area */
  let pos = 32 + groups.length * 4;
  const groupAt: number[] = [];
  for (const group of groups) {
    groupAt.push(pos);
    pos += 4 + group.layers.length * LAYER_DESCRIPTOR_BYTES;
  }
  interface LayerPlan {
    layer: MapLayer;
    descriptor: number;
    rowDirectory: number;
    cells: number;
    lighting: number;
    bank: number;
  }
  const plans: LayerPlan[] = [];
  groups.forEach((group, g) => {
    group.layers.forEach((layer, l) => {
      check(layer.cells.length === layer.width * layer.height, 'Layer cell grid does not match its dimensions');
      if (layer.lighting) check(layer.lighting.length === lightingSize(layer.width, layer.height), 'Layer lighting lattice does not match its dimensions');
      const plan: LayerPlan = { layer, descriptor: groupAt[g] + 4 + l * LAYER_DESCRIPTOR_BYTES, rowDirectory: pos, cells: 0, lighting: 0, bank: 0 };
      pos += layer.height * 4;
      plan.cells = pos;
      pos += layer.width * layer.height * 2;
      if (layer.lighting) {
        plan.lighting = pos;
        pos += layer.lighting.length;
      }
      plan.bank = pos;
      pos += layer.height * 36;
      plans.push(plan);
    });
  });
  const pool = (pos + 3) & ~3;

  const head = new Uint8Array(pool);
  const hv = new DataView(head.buffer);
  groups.forEach((group, g) => {
    hv.setUint32(32 + g * 4, groupAt[g], true);
    hv.setUint32(groupAt[g], group.layers.length, true);
  });
  for (const { layer, descriptor: d, rowDirectory, cells, lighting, bank } of plans) {
    hv.setUint32(d, cells - d, true);
    hv.setUint32(d + 4, rowDirectory - d, true);
    hv.setUint32(d + 8, bank - d, true);
    hv.setInt32(d + 0x0c, layer.originX, true);
    hv.setInt32(d + 0x10, layer.originY, true);
    hv.setUint32(d + 0x14, layer.width, true);
    hv.setUint32(d + 0x18, layer.height, true);
    hv.setUint32(d + 0x1c, lighting ? lighting - d : 0, true);
    const starts = rowStart.get(layer)!;
    for (let y = 0; y < layer.height; y++) {
      hv.setUint32(rowDirectory + y * 4, cells - rowDirectory + y * layer.width * 2, true);
      if (starts[y] >= 0) hv.setUint32(bank + y * 36, pool + starts[y] * OBJECT_RECORD_BYTES - bank, true);
    }
    for (let i = 0; i < layer.cells.length; i++) hv.setUint16(cells + i * 2, layer.cells[i], true);
    if (layer.lighting) head.set(layer.lighting, lighting);
  }

  /* ------------------------------------------------------ object pool */
  const pathCount = map.paths.length;
  const objects = new Uint8Array(objectOrder.length * OBJECT_RECORD_BYTES);
  const ov = new DataView(objects.buffer);
  objectOrder.forEach((object, i) => {
    const at = i * OBJECT_RECORD_BYTES;
    check(object.pathIndex >= -1 && object.pathIndex < pathCount, 'An object refers to a path that does not exist');
    ov.setUint32(at, rowEnd.has(i) ? 0 : 1, true);
    ov.setUint16(at + 4, object.typeWord, true);
    ov.setInt16(at + 6, object.x, true);
    ov.setInt16(at + 8, object.y, true);
    ov.setInt16(at + 10, object.pathIndex, true);
    objects[at + 12] = object.flags;
  });

  /* --------------------------------------------------------- geometry */
  const tableBytes = definitions.length * 8;
  const streams: Uint8Array[] = [];
  const streamAt = new Map<string, number>();
  let streamPos = tableBytes;
  const place = (bytes: Uint8Array): number => {
    const key = Array.from(bytes).join(',');
    let at = streamAt.get(key);
    if (at === undefined) {
      at = streamPos;
      streamAt.set(key, at);
      const padded = bytes.length & 1 ? concatBytes([bytes, new Uint8Array(1)]) : bytes;
      streams.push(padded);
      streamPos += padded.length;
    }
    return at;
  };
  const table = new Uint8Array(tableBytes);
  const tv = new DataView(table.buffer);
  definitions.forEach((def, id) => {
    if (id === 0 || (!def.vertices.length && !def.commands.length)) return; // empty: both offsets stay 0
    check(def.complete, `Definition ${id} has an undecoded face stream and cannot be rewritten`);
    tv.setUint32(id * 8, place(encodeVertexStream(def.vertices)), true);
    tv.setUint32(id * 8 + 4, place(encodeFaceStream(def.commands)), true);
  });
  const geometry = concatBytes([table, ...streams]);

  /* --------------------------------------------------------- metadata */
  const newIndexOf = new Map<number, number>();
  objectOrder.forEach((object, i) => {
    if (object.poolIndex >= 0) newIndexOf.set(object.poolIndex, i);
  });
  const unresolved: number[] = [];
  const metadata = new Uint8Array(definitions.length * 8);
  definitions.forEach((def, id) => {
    check(def.meta.length === 8, `Definition ${id} needs 8 metadata bytes`);
    metadata.set(def.meta, id * 8);
    // "Enable object" actions name their target by pool index, which has just changed.
    if (definitionClass(def.meta) === CLASS_ACTION && (def.meta[7] === ACTION_ENABLE_OBJECT || def.meta[7] === ACTION_ENABLE_TYPE)) {
      const target = newIndexOf.get(def.meta[2] | (def.meta[3] << 8));
      if (target === undefined) unresolved.push(id);
      else {
        metadata[id * 8 + 2] = target & 0xff;
        metadata[id * 8 + 3] = target >> 8;
      }
    }
  });

  /* ------------------------------------------------------ tail sections */
  const scrolls = new ByteWriter(4 + map.textureScrolls.length * 12);
  scrolls.u32(map.textureScrolls.length);
  for (const s of map.textureScrolls) scrolls.u32(s.texture).u32(s.axis).u32(s.direction);

  const cycles = new ByteWriter();
  cycles.u32(map.textureCycles.length);
  for (const c of map.textureCycles) {
    cycles.u32(c.texture).u32(c.frames.length).u32(c.period).u32(c.counter);
    for (const f of c.frames) cycles.u32(f);
  }

  const paths = new ByteWriter();
  paths.u32(pathCount);
  let pathAt = 4 + pathCount * 4;
  for (const p of map.paths) {
    paths.u32(pathAt);
    pathAt += 8 + p.points.length * 8;
  }
  for (const p of map.paths) {
    check(p.points.length <= 0x7fff, 'A path has too many points');
    paths.u16(p.word0).u16((p.flag ? 0x8000 : 0) | p.points.length).i16(p.group).i16(p.layer);
    for (const point of p.points) paths.i16(point.x).i16(point.y).u16(point.tail0).u16(point.tail1);
  }

  const parts = [head, objects, geometry, metadata, scrolls.finish(), cycles.finish(), paths.finish()];
  const starts: number[] = [];
  let size = 0;
  for (const part of parts) {
    starts.push(size);
    size += part.length;
  }
  check(size <= MAX_MAP_BYTES, `The compiled map is ${size} bytes; the engine's map buffer holds ${MAX_MAP_BYTES}`);
  const bytes = concatBytes(parts);
  const view = new DataView(bytes.buffer);
  [starts[2], starts[3], pool, starts[4], starts[5], starts[6], definitions.length - 1, groups.length].forEach((value, i) => view.setUint32(i * 4, value, true));
  return { bytes, objectOrder, unresolvedObjectReferences: unresolved };
}

/** Build the automap companion file from each definition's `automap` words. */
export function writeLmp(definitions: readonly CellDefinition[]): Uint8Array {
  const tableBytes = definitions.length * 2;
  const table = new Uint8Array(tableBytes);
  const tv = new DataView(table.buffer);
  const payloads: Uint8Array[] = [];
  const placed = new Map<string, number>();
  let rel = tableBytes; // offsets are relative to the table, which starts at file offset 8
  definitions.forEach((def, id) => {
    if (!def.automap || !def.automap.length) return;
    const key = Array.from(def.automap).join(',');
    let at = placed.get(key);
    if (at === undefined) {
      at = rel;
      placed.set(key, at);
      const w = new ByteWriter(def.automap.length * 2);
      for (const word of def.automap) w.u16(word);
      payloads.push(w.finish());
      rel += def.automap.length * 2;
    }
    check(at <= 0xffff, 'Automap data exceeds its 16-bit offset range');
    tv.setUint16(id * 2, at, true);
  });
  const out = concatBytes([new ByteWriter(8).u32(0).u32(8).finish(), table, ...payloads]);
  check(out.length <= MAX_LMP_BYTES, `The automap file is ${out.length} bytes; the engine's buffer holds ${MAX_LMP_BYTES}`);
  return out;
}
