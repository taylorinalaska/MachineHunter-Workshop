/** Small helpers for reading and writing the game's little-endian binary formats. */

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FormatError(message);
}

/** Bounds-checked little-endian view over a byte buffer. */
export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  private need(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.length) {
      throw new FormatError(`Read of ${size} byte(s) at 0x${offset.toString(16)} is outside the ${this.bytes.length}-byte buffer`);
    }
  }

  u8(offset: number): number {
    this.need(offset, 1);
    return this.bytes[offset];
  }
  i8(offset: number): number {
    this.need(offset, 1);
    return this.view.getInt8(offset);
  }
  u16(offset: number): number {
    this.need(offset, 2);
    return this.view.getUint16(offset, true);
  }
  i16(offset: number): number {
    this.need(offset, 2);
    return this.view.getInt16(offset, true);
  }
  u32(offset: number): number {
    this.need(offset, 4);
    return this.view.getUint32(offset, true);
  }
  i32(offset: number): number {
    this.need(offset, 4);
    return this.view.getInt32(offset, true);
  }
  /** A view (not a copy) of `size` bytes. */
  slice(offset: number, size: number): Uint8Array {
    this.need(offset, size);
    return this.bytes.subarray(offset, offset + size);
  }
  /** NUL-terminated ASCII, reading at most `cap` bytes. */
  cstring(offset: number, cap: number): string {
    const end = Math.min(this.bytes.length, offset + cap);
    let out = '';
    for (let i = offset; i < end && this.bytes[i] !== 0; i++) out += String.fromCharCode(this.bytes[i]);
    return out;
  }
}

/** Growable little-endian writer. */
export class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private size = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buffer.buffer);
  }

  get length(): number {
    return this.size;
  }

  private reserve(extra: number): void {
    const needed = this.size + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.size));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): this {
    this.reserve(1);
    this.view.setUint8(this.size, value);
    this.size += 1;
    return this;
  }
  u16(value: number): this {
    this.reserve(2);
    this.view.setUint16(this.size, value, true);
    this.size += 2;
    return this;
  }
  i16(value: number): this {
    this.reserve(2);
    this.view.setInt16(this.size, value, true);
    this.size += 2;
    return this;
  }
  u32(value: number): this {
    this.reserve(4);
    this.view.setUint32(this.size, value >>> 0, true);
    this.size += 4;
    return this;
  }
  bytes(data: ArrayLike<number>): this {
    this.reserve(data.length);
    this.buffer.set(data, this.size);
    this.size += data.length;
    return this;
  }
  zeros(count: number): this {
    this.reserve(count);
    this.buffer.fill(0, this.size, this.size + count);
    this.size += count;
    return this;
  }
  /** Pad with zero bytes until the length is a multiple of `alignment`. */
  align(alignment: number): this {
    const rem = this.size % alignment;
    return rem ? this.zeros(alignment - rem) : this;
  }
  /** Overwrite a previously written dword. */
  patchU32(offset: number, value: number): this {
    this.view.setUint32(offset, value >>> 0, true);
    return this;
  }
  finish(): Uint8Array {
    return this.buffer.slice(0, this.size);
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (ZIP / PNG polynomial). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    check(code < 0x80, `Non-ASCII character in "${text}"`);
    out[i] = code;
  }
  return out;
}

export function hex(value: number, width = 0): string {
  return value.toString(16).toUpperCase().padStart(width, '0');
}
