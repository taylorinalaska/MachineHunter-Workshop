/**
 * .MAP reader.
 *
 * File layout (all offsets little-endian; "rel" = relative to the named base):
 *
 *   +00 uint32 geometry section      per-definition {vertexStream rel, faceStream rel}
 *   +04 uint32 metadata section      8 bytes per definition
 *   +08 uint32 object pool           36-byte records
 *   +0C uint32 texture-scroll section (0 = none)
 *   +10 uint32 texture-cycle section  (0 = none)
 *   +14 uint32 path directory         (0 = none)
 *   +18 uint32 highest definition ID  (table length is this + 1)
 *   +1C uint32 group count
 *   +20 uint32 groupOffset[groupCount]
 *
 *   group:  uint32 layerCount, then 0x80-byte layer descriptors
 *   layer:  +00 rel cell grid        +04 rel row directory   +08 rel object row bank
 *           +0C origin X  +10 origin Y  +14 width  +18 height  +1C rel lighting lattice
 *           (rels are relative to the descriptor; the rest is runtime scratch)
 *   row bank: one 36-byte record per row; dword 0 is the bank-relative offset
 *           of the row's first object (0 = empty row). Within a row, an
 *           object's dword 0 is non-zero while another object follows.
 */
import { ByteReader, check } from '../util/binary.ts';
import {
  type CellDefinition,
  DEFINITION_MASK,
  type FaceCommand,
  FLAT_QUAD_OPS,
  type GameMap,
  LAYER_DESCRIPTOR_BYTES,
  MAX_MAP_BYTES,
  type MapGroup,
  type MapLayer,
  type MapObject,
  type MapPath,
  OBJECT_RECORD_BYTES,
  OP_TRIANGLE,
  TEXTURED_OPS,
  type TextureCycle,
  type TextureScroll,
  emptyDefinition,
  lightingSize,
} from './model.ts';

export interface ParseOptions {
  /** Companion .LMP bytes; when given, each definition's automap profile is attached. */
  lmp?: Uint8Array | null;
  /** Called with every byte range the parser consumed; used by the layout audit. */
  onRange?: (start: number, end: number, what: string) => void;
}

export interface ParsedMapInfo {
  header: number[];
  /** Object-pool slots that no row links to (MINES4 has some). */
  unlinkedObjectSlots: number;
  /** Definition IDs whose face stream could not be fully decoded. */
  incompleteDefinitions: number[];
}

const MAX_VERTICES = 512;
const MAX_COMMANDS = 1024;

/** Decode a face stream starting at `at`. Returns the commands and the offset just past the terminator. */
export function decodeFaceStream(r: ByteReader, at: number, vertexCount: number, limit: number): { commands: FaceCommand[]; end: number; complete: boolean } {
  const commands: FaceCommand[] = [];
  let p = at;
  for (let n = 0; n < MAX_COMMANDS; n++) {
    if (p + 2 > limit) return { commands, end: p, complete: false };
    const op = r.u16(p);
    p += 2;
    if (op === 0) return { commands, end: p, complete: true };
    let texture: number | null = null;
    let count: number;
    if (op === 1 || op === 18) count = 0;
    else if (op === 2) count = 2;
    else if (TEXTURED_OPS.has(op)) {
      if (p + 2 > limit) return { commands, end: p - 2, complete: false };
      texture = r.u16(p);
      p += 2;
      count = 4;
    } else if (FLAT_QUAD_OPS.has(op)) count = 4;
    else if (op === OP_TRIANGLE) count = 3;
    else return { commands, end: p - 2, complete: false }; // the engine stops at unknown opcodes too
    if (p + count * 2 > limit) return { commands, end: p, complete: false };
    const indices: number[] = [];
    for (let i = 0; i < count; i++) indices.push(r.u16(p + i * 2));
    p += count * 2;
    if (op !== 2 && indices.some((i) => i >= vertexCount)) return { commands, end: p, complete: false };
    commands.push({ op, texture, indices });
  }
  return { commands, end: p, complete: false };
}

/** Split an .LMP into per-definition automap payloads (16-bit words up to and including FFFF,FFFF). */
export function decodeLmp(lmp: Uint8Array, definitionCount: number): (Uint16Array | null)[] {
  const r = new ByteReader(lmp);
  check(lmp.length >= 8, '.LMP is truncated');
  const table = r.u32(4);
  check(table >= 8 && table + definitionCount * 2 <= lmp.length, '.LMP definition table does not fit the map');
  const out: (Uint16Array | null)[] = [];
  for (let id = 0; id < definitionCount; id++) {
    const rel = r.u16(table + id * 2);
    if (!rel) {
      out.push(null);
      continue;
    }
    const words: number[] = [];
    for (let p = table + rel; ; p += 4) {
      check(p + 4 <= lmp.length && words.length < 4096, `.LMP profile for definition ${id} is not terminated`);
      const a = r.u16(p);
      const b = r.u16(p + 2);
      words.push(a, b);
      if (a === 0xffff && b === 0xffff) break;
    }
    out.push(Uint16Array.from(words));
  }
  return out;
}

export function parseMap(bytes: Uint8Array, options: ParseOptions = {}): GameMap & { info: ParsedMapInfo } {
  check(bytes.length >= 36 && bytes.length <= MAX_MAP_BYTES, 'A MAP must be decompressed and at most 0x50000 bytes');
  const r = new ByteReader(bytes);
  const mark = options.onRange ?? (() => {});
  const header = Array.from({ length: 8 }, (_, i) => r.u32(i * 4));
  const [geometry, metadata, pool, scrollAt, cycleAt, pathsAt, maxDefinition, groupCount] = header;
  check(pool >= 36 && pool <= geometry && geometry < metadata && metadata <= bytes.length, 'MAP section offsets are inconsistent');
  check((geometry - pool) % OBJECT_RECORD_BYTES === 0, 'MAP object pool is not a whole number of records');
  check(groupCount >= 1 && groupCount <= 32, `MAP has an invalid group count (${groupCount})`);
  check(maxDefinition <= DEFINITION_MASK, 'MAP declares more than 2048 cell definitions');
  const definitionCount = maxDefinition + 1;
  mark(0, 32 + groupCount * 4, 'header');

  /* ------------------------------------------------------------- groups */
  const groups: MapGroup[] = [];
  const seenObjects = new Set<number>();
  for (let g = 0; g < groupCount; g++) {
    const groupAt = r.u32(32 + g * 4);
    const layerCount = r.u32(groupAt);
    check(layerCount <= 32 && groupAt + 4 + layerCount * LAYER_DESCRIPTOR_BYTES <= pool, `Group ${g} has invalid layer descriptors`);
    mark(groupAt, groupAt + 4 + layerCount * LAYER_DESCRIPTOR_BYTES, 'layer descriptors');
    const layers: MapLayer[] = [];
    for (let l = 0; l < layerCount; l++) {
      const d = groupAt + 4 + l * LAYER_DESCRIPTOR_BYTES;
      const width = r.u32(d + 0x14);
      const height = r.u32(d + 0x18);
      check(width <= 256 && height <= 256, `Group ${g} layer ${l} has implausible dimensions`);
      const rowDirectory = d + r.u32(d + 4);
      const bank = d + r.u32(d + 8);
      const cells = new Uint16Array(width * height);
      const objects: MapObject[] = [];
      if (height) mark(rowDirectory, rowDirectory + height * 4, 'row directory');
      for (let y = 0; y < height; y++) {
        const row = rowDirectory + r.u32(rowDirectory + y * 4);
        check(row + width * 2 <= pool, `Group ${g} layer ${l}: cell row ${y} is outside the layout area`);
        mark(row, row + width * 2, 'cells');
        for (let x = 0; x < width; x++) cells[y * width + x] = r.u16(row + x * 2);

        mark(bank + y * 36, bank + y * 36 + 36, 'row bank');
        const first = r.u32(bank + y * 36);
        if (!first) continue;
        for (let o = bank + first; ; o += OBJECT_RECORD_BYTES) {
          check(o >= pool && o + OBJECT_RECORD_BYTES <= geometry && (o - pool) % OBJECT_RECORD_BYTES === 0, `Group ${g} layer ${l} row ${y}: object chain leaves the pool`);
          check(!seenObjects.has(o), `Group ${g} layer ${l} row ${y}: object is linked twice`);
          seenObjects.add(o);
          objects.push({
            typeWord: r.u16(o + 4),
            x: r.i16(o + 6),
            y: r.i16(o + 8),
            pathIndex: r.i16(o + 10),
            flags: r.u8(o + 12),
            poolIndex: (o - pool) / OBJECT_RECORD_BYTES,
          });
          if (!r.u32(o)) break;
        }
      }
      let lighting: Uint8Array | null = null;
      const lightRel = r.u32(d + 0x1c);
      if (lightRel) {
        const at = d + lightRel;
        const size = lightingSize(width, height);
        check(at + size <= pool, `Group ${g} layer ${l}: lighting lattice is outside the layout area`);
        lighting = bytes.slice(at, at + size);
        mark(at, at + size, 'lighting');
      }
      layers.push({ width, height, originX: r.i32(d + 0x0c), originY: r.i32(d + 0x10), cells, lighting, objects });
    }
    groups.push({ layers });
  }
  mark(pool, geometry, 'object pool');

  /* -------------------------------------------------------- definitions */
  const automap = options.lmp ? decodeLmp(options.lmp, definitionCount) : null;
  const definitions: CellDefinition[] = [];
  const incomplete: number[] = [];
  mark(geometry, geometry + definitionCount * 8, 'geometry table');
  mark(metadata, metadata + definitionCount * 8, 'metadata table');
  for (let id = 0; id < definitionCount; id++) {
    const def = emptyDefinition();
    def.meta = bytes.slice(metadata + id * 8, metadata + id * 8 + 8);
    def.automap = automap ? automap[id] : null;
    const vertexRel = r.u32(geometry + id * 8);
    const faceRel = r.u32(geometry + id * 8 + 4);
    if (id > 0 && (vertexRel || faceRel)) {
      const vertexAt = geometry + vertexRel;
      const count = r.u32(vertexAt);
      check(count <= MAX_VERTICES && vertexAt + 4 + count * 6 <= metadata, `Definition ${id} has an invalid vertex stream`);
      mark(vertexAt, vertexAt + 4 + count * 6, 'vertices');
      def.vertices = new Int16Array(count * 3);
      for (let i = 0; i < count * 3; i++) def.vertices[i] = r.i16(vertexAt + 4 + i * 2);
      const faces = decodeFaceStream(r, geometry + faceRel, count, metadata);
      mark(geometry + faceRel, faces.end, 'faces');
      def.commands = faces.commands;
      def.complete = faces.complete;
      if (!faces.complete) incomplete.push(id);
    }
    definitions.push(def);
  }
  for (const group of groups) {
    for (const layer of group.layers) {
      for (const word of layer.cells) check((word & DEFINITION_MASK) < definitionCount, 'A cell refers to a definition past the end of the table');
    }
  }

  /* ------------------------------------------------------ texture fx */
  const textureScrolls: TextureScroll[] = [];
  if (scrollAt) {
    const count = r.u32(scrollAt);
    check(count <= 4096 && scrollAt + 4 + count * 12 <= bytes.length, 'Invalid texture-scroll section');
    mark(scrollAt, scrollAt + 4 + count * 12, 'texture scrolls');
    for (let i = 0; i < count; i++) {
      const at = scrollAt + 4 + i * 12;
      textureScrolls.push({ texture: r.u32(at), axis: r.u32(at + 4), direction: r.i32(at + 8) });
    }
  }
  const textureCycles: TextureCycle[] = [];
  if (cycleAt) {
    const count = r.u32(cycleAt);
    check(count <= 4096, 'Invalid texture-cycle section');
    let at = cycleAt + 4;
    for (let i = 0; i < count; i++) {
      const frameCount = r.u32(at + 4);
      check(frameCount <= 4096 && at + 16 + frameCount * 4 <= bytes.length, 'Invalid texture-cycle record');
      const frames: number[] = [];
      for (let j = 0; j < frameCount; j++) frames.push(r.u32(at + 16 + j * 4));
      textureCycles.push({ texture: r.u32(at), period: r.u32(at + 8), counter: r.u32(at + 12), frames });
      at += 16 + frameCount * 4;
    }
    mark(cycleAt, at, 'texture cycles');
  }

  /* ------------------------------------------------------------- paths */
  const paths: MapPath[] = [];
  if (pathsAt) {
    const count = r.u32(pathsAt);
    check(count <= 4096 && pathsAt + 4 + count * 4 <= bytes.length, 'Invalid path directory');
    mark(pathsAt, pathsAt + 4 + count * 4, 'path directory');
    for (let i = 0; i < count; i++) {
      const at = pathsAt + r.u32(pathsAt + 4 + i * 4);
      const countWord = r.u16(at + 2);
      const pointCount = countWord & 0x7fff;
      check(pointCount <= 4096 && at + 8 + pointCount * 8 <= bytes.length, `Path ${i} has an invalid point list`);
      mark(at, at + 8 + pointCount * 8, 'path');
      const points = [];
      for (let j = 0; j < pointCount; j++) {
        const p = at + 8 + j * 8;
        points.push({ x: r.i16(p), y: r.i16(p + 2), tail0: r.u16(p + 4), tail1: r.u16(p + 6) });
      }
      paths.push({ word0: r.u16(at), flag: (countWord & 0x8000) !== 0, group: r.i16(at + 4), layer: r.i16(at + 6), points });
    }
  }

  return {
    groups,
    definitions,
    paths,
    textureScrolls,
    textureCycles,
    info: { header, unlinkedObjectSlots: (geometry - pool) / OBJECT_RECORD_BYTES - seenObjects.size, incompleteDefinitions: incomplete },
  };
}
