/**
 * RNC ProPack decompression (methods 1 and 2), as used by DATA.ARC members.
 *
 * Header (big-endian, 18 bytes): "RNC", method, unpacked size, packed size,
 * unpacked CRC-16, packed CRC-16, leeway, chunk count.
 *
 * Decoding logic follows bitplane/propack (upstream WTFPL + Warranty notice); see docs/THIRD_PARTY.md.
 */
import { FormatError, check } from '../util/binary.ts';

const HEADER_SIZE = 18;

export function isRnc(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_SIZE && bytes[0] === 0x52 && bytes[1] === 0x4e && bytes[2] === 0x43 && (bytes[3] === 1 || bytes[3] === 2);
}

function crc16(data: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

const ror16 = (key: number): number => (key & 1 ? 0x8000 | (key >>> 1) : key >>> 1);

function reverseBits(value: number, count: number): number {
  let result = 0;
  for (let i = 0; i < count; i++) {
    result = (result << 1) | (value & 1);
    value >>>= 1;
  }
  return result;
}

class BitReader {
  pos: number;
  /** 32 bits are enough: at most 16 bits are ever inspected before a refill. */
  bitBuffer = 0;
  bitCount = 0;

  constructor(
    readonly data: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  peek(offset: number): number {
    const i = this.pos + offset;
    return i < this.end ? this.data[i] : 0;
  }

  readByte(): number {
    if (this.pos >= this.end) throw new FormatError('RNC: unexpected end of packed data');
    return this.data[this.pos++];
  }

  /** Method 1 refills may legitimately run two bytes past the packed end. */
  private readTokenByte(): number {
    if (this.pos >= this.end + 2) throw new FormatError('RNC: unexpected end of packed data');
    const b = this.peek(0);
    this.pos++;
    return b;
  }

  /** Method 1: LSB-first bits from 16-bit little-endian tokens. */
  bits1(count: number): number {
    let bits = 0;
    let weight = 1;
    for (let i = 0; i < count; i++) {
      if (!this.bitCount) {
        const b1 = this.readTokenByte();
        const b2 = this.readTokenByte();
        this.bitBuffer = ((this.peek(1) << 24) | (this.peek(0) << 16) | (b2 << 8) | b1) >>> 0;
        this.bitCount = 16;
      }
      if (this.bitBuffer & 1) bits |= weight;
      this.bitBuffer >>>= 1;
      weight <<= 1;
      this.bitCount--;
    }
    return bits;
  }

  /** Method 2: MSB-first bits, one byte at a time. */
  bits2(count: number): number {
    let bits = 0;
    for (let i = 0; i < count; i++) {
      if (!this.bitCount) {
        this.bitBuffer = this.readByte();
        this.bitCount = 8;
      }
      bits <<= 1;
      if (this.bitBuffer & 0x80) bits |= 1;
      this.bitBuffer = (this.bitBuffer << 1) & 0xff;
      this.bitCount--;
    }
    return bits;
  }
}

interface HuffmanEntry {
  depth: number;
  code: number;
}

function readTable(r: BitReader): HuffmanEntry[] {
  const count = Math.min(r.bits1(5), 16);
  if (!count) return [];
  const depths: number[] = [];
  for (let i = 0; i < count; i++) depths.push(r.bits1(4));
  const table: HuffmanEntry[] = depths.map((depth) => ({ depth, code: 0 }));
  let value = 0;
  let divisor = 0x80000000;
  for (let bitCount = 1; bitCount <= 16; bitCount++) {
    for (let i = 0; i < count; i++) {
      if (depths[i] === bitCount) {
        table[i].code = reverseBits(Math.floor(value / divisor), bitCount);
        value += divisor;
      }
    }
    divisor /= 2;
  }
  return table;
}

function decodeSymbol(r: BitReader, table: HuffmanEntry[]): number {
  for (let i = 0; i < table.length; i++) {
    const { depth, code } = table[i];
    if (depth && code === (r.bitBuffer & ((1 << depth) - 1))) {
      r.bits1(depth);
      return i < 2 ? i : r.bits1(i - 1) | (1 << (i - 1));
    }
  }
  throw new FormatError('RNC: invalid Huffman code');
}

function unpackMethod1(r: BitReader, unpackedSize: number): Uint8Array {
  const out = new Uint8Array(unpackedSize);
  let at = 0;
  const put = (b: number) => {
    if (at >= unpackedSize) throw new FormatError('RNC: output overrun');
    out[at++] = b;
  };
  while (at < unpackedSize) {
    const rawTable = readTable(r);
    const offsetTable = readTable(r);
    const lengthTable = readTable(r);
    const subchunks = r.bits1(16);
    for (let sc = 0; sc < subchunks; sc++) {
      const literals = decodeSymbol(r, rawTable);
      if (literals) {
        for (let i = 0; i < literals; i++) put(r.readByte());
        // Literal bytes are byte-aligned, so re-prime the lookahead bits that
        // follow the still-unconsumed bits of the current token.
        const lookahead = (r.peek(2) << 16) | (r.peek(1) << 8) | r.peek(0);
        r.bitBuffer = ((lookahead << r.bitCount) | (r.bitBuffer & ((1 << r.bitCount) - 1))) >>> 0;
      }
      if (sc < subchunks - 1) {
        const distance = decodeSymbol(r, offsetTable) + 1;
        const length = decodeSymbol(r, lengthTable) + 2;
        if (distance > at) throw new FormatError('RNC: match before start of output');
        for (let i = 0; i < length; i++) put(out[at - distance]);
      }
    }
  }
  return out;
}

function matchCount2(r: BitReader): number {
  let count = r.bits2(1) + 4;
  if (r.bits2(1)) count = ((count - 1) << 1) + r.bits2(1);
  return count;
}

function matchOffset2(r: BitReader): number {
  let offset = 0;
  if (r.bits2(1)) {
    offset = r.bits2(1);
    if (r.bits2(1)) {
      offset = ((offset << 1) | r.bits2(1)) | 4;
      if (!r.bits2(1)) offset = (offset << 1) | r.bits2(1);
    } else if (!offset) {
      offset = r.bits2(1) + 2;
    }
  }
  return ((offset << 8) | r.readByte()) + 1;
}

function unpackMethod2(r: BitReader, unpackedSize: number): Uint8Array {
  const out = new Uint8Array(unpackedSize);
  let at = 0;
  const put = (b: number) => {
    if (at >= unpackedSize) throw new FormatError('RNC: output overrun');
    out[at++] = b;
  };
  const copy = (distance: number, length: number) => {
    if (distance > at) throw new FormatError('RNC: match before start of output');
    for (let i = 0; i < length; i++) put(out[at - distance]);
  };
  while (at < unpackedSize) {
    for (;;) {
      if (!r.bits2(1)) {
        put(r.readByte());
        continue;
      }
      if (r.bits2(1)) {
        if (r.bits2(1)) {
          let length = 3;
          if (r.bits2(1)) {
            length = r.readByte() + 8;
            if (length === 8) {
              r.bits2(1); // end-of-chunk marker
              break;
            }
          }
          copy(matchOffset2(r), length);
        } else {
          copy(r.readByte() + 1, 2);
        }
      } else {
        const length = matchCount2(r);
        if (length !== 9) {
          copy(matchOffset2(r), length);
        } else {
          const literals = (r.bits2(4) << 2) + 12;
          for (let i = 0; i < literals; i++) put(r.readByte());
        }
      }
    }
  }
  return out;
}

export interface RncHeader {
  method: 1 | 2;
  unpackedSize: number;
  packedSize: number;
}

export function readRncHeader(data: Uint8Array): RncHeader {
  check(isRnc(data), 'Not an RNC stream');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { method: data[3] as 1 | 2, unpackedSize: view.getUint32(4, false), packedSize: view.getUint32(8, false) };
}

/** Decompress an RNC method 1/2 stream. Encrypted or locked streams are rejected (the game uses neither). */
export function unpackRnc(data: Uint8Array): Uint8Array {
  const header = readRncHeader(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unpackedCrc = view.getUint16(12, false);
  const packedCrc = view.getUint16(14, false);
  const end = HEADER_SIZE + header.packedSize;
  check(data.length >= end, 'RNC: truncated stream');
  check(crc16(data, HEADER_SIZE, end) === packedCrc, 'RNC: packed data checksum mismatch');

  const r = new BitReader(data, HEADER_SIZE, end);
  const readBit = () => (header.method === 1 ? r.bits1(1) : r.bits2(1));
  check(!readBit(), 'RNC: locked stream');
  check(!readBit(), 'RNC: encrypted stream');
  const out = header.method === 1 ? unpackMethod1(r, header.unpackedSize) : unpackMethod2(r, header.unpackedSize);
  check(crc16(out, 0, out.length) === unpackedCrc, 'RNC: unpacked data checksum mismatch');
  return out;
}
