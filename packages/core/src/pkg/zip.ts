/**
 * Stored (uncompressed) ZIP archives: the container of `.mhproject` files.
 * The runtime's loader only accepts stored entries with ASCII names, so that
 * is all this module writes; it can also read deflate-free archives it wrote.
 */
import { ByteReader, ByteWriter, FormatError, asciiBytes, check, concatBytes, crc32 } from '../util/binary.ts';

export const MAX_PACKAGE_ENTRIES = 256;
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 159;

function checkName(name: string): void {
  check(/^[A-Za-z0-9_./-]+$/.test(name) && name.length <= MAX_NAME_LENGTH, `"${name}" is not a valid package entry name`);
  check(!name.startsWith('/') && !name.split('/').includes('..'), `"${name}" escapes the package`);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function zipStored(files: Record<string, Uint8Array | string>): Uint8Array {
  const names = Object.keys(files);
  check(names.length > 0 && names.length <= MAX_PACKAGE_ENTRIES, `A package holds 1..${MAX_PACKAGE_ENTRIES} entries`);
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    checkName(name);
    check(!seen.has(name.toLowerCase()), `Duplicate package entry "${name}"`);
    seen.add(name.toLowerCase());
    const input = files[name];
    const data = typeof input === 'string' ? textEncoder.encode(input) : input;
    const nameBytes = asciiBytes(name);
    const sum = crc32(data);
    const local = new ByteWriter(30 + nameBytes.length);
    local.u32(0x04034b50).u16(20).u16(0).u16(0).u16(0).u16(0).u32(sum).u32(data.length).u32(data.length).u16(nameBytes.length).u16(0).bytes(nameBytes);
    const record = new ByteWriter(46 + nameBytes.length);
    record.u32(0x02014b50).u16(20).u16(20).u16(0).u16(0).u16(0).u16(0).u32(sum).u32(data.length).u32(data.length);
    record.u16(nameBytes.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(nameBytes);
    const localBytes = local.finish();
    locals.push(localBytes, data);
    central.push(record.finish());
    offset += localBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new ByteWriter(22).u32(0x06054b50).u16(0).u16(0).u16(names.length).u16(names.length).u32(centralSize).u32(offset).u16(0).finish();
  const out = concatBytes([...locals, ...central, end]);
  check(out.length <= MAX_PACKAGE_BYTES, 'The package exceeds 64 MiB');
  return out;
}

export function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  check(bytes.length <= MAX_PACKAGE_BYTES, 'The package exceeds 64 MiB');
  const r = new ByteReader(bytes);
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let pos = 0;
  while (pos + 30 <= bytes.length && r.u32(pos) === 0x04034b50) {
    const flags = r.u16(pos + 6);
    const method = r.u16(pos + 8);
    if (flags & 0x0009 || method !== 0) throw new FormatError('Only unencrypted, uncompressed (stored) packages are supported');
    const size = r.u32(pos + 18);
    const nameLength = r.u16(pos + 26);
    const start = pos + 30 + nameLength + r.u16(pos + 28);
    check(start + size <= bytes.length, 'The package is truncated');
    const name = textDecoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLength));
    checkName(name);
    check(!seen.has(name.toLowerCase()), `Duplicate package entry "${name}"`);
    seen.add(name.toLowerCase());
    const data = bytes.subarray(start, start + size);
    check(crc32(data) === r.u32(pos + 14), `Package entry "${name}" is corrupt (checksum mismatch)`);
    if (!name.endsWith('/')) files.set(name, data);
    pos = start + size;
  }
  check(files.size > 0, 'Not a package (no stored ZIP entries found)');
  return files;
}

export const utf8 = (text: string): Uint8Array => textEncoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => textDecoder.decode(bytes);
