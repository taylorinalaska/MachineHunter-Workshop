/**
 * DATA.ARC ("EARC") container.
 *
 *   0x00  char[4]  "EARC"
 *   0x04  uint32   entry count
 *   0x08  entries[count]: uint32 offset, uint32 storedSize, char[12] name
 *
 * The game addresses members by their zero-based directory index ("archive
 * ID"), so the directory order is part of the contract. Members may be stored
 * raw or RNC-packed; `read()` always returns the decoded bytes.
 */
import { ByteReader, check } from '../util/binary.ts';
import { isRnc, unpackRnc } from './rnc.ts';

export interface ArchiveEntry {
  /** Zero-based directory index; this is the engine's "archive ID". */
  id: number;
  name: string;
  offset: number;
  storedSize: number;
}

export class Archive {
  readonly entries: readonly ArchiveEntry[];
  private readonly byName = new Map<string, ArchiveEntry>();
  private readonly cache = new Map<number, Uint8Array>();

  constructor(private readonly bytes: Uint8Array) {
    const r = new ByteReader(bytes);
    check(bytes.length >= 8 && r.cstring(0, 4) === 'EARC', 'Not a Machine Hunter DATA.ARC (missing EARC signature)');
    const count = r.u32(4);
    check(count > 0 && count <= 4096 && 8 + count * 20 <= bytes.length, 'DATA.ARC directory is truncated');
    const entries: ArchiveEntry[] = [];
    for (let id = 0; id < count; id++) {
      const at = 8 + id * 20;
      const entry: ArchiveEntry = { id, offset: r.u32(at), storedSize: r.u32(at + 4), name: r.cstring(at + 8, 12) };
      check(entry.offset + entry.storedSize <= bytes.length, `${entry.name}: data range is beyond the end of the archive`);
      entries.push(entry);
      // The engine's lookup is case-insensitive; first match wins.
      const key = entry.name.toUpperCase();
      if (!this.byName.has(key)) this.byName.set(key, entry);
    }
    this.entries = entries;
  }

  find(name: string): ArchiveEntry | undefined {
    return this.byName.get(name.toUpperCase());
  }

  has(name: string): boolean {
    return this.byName.has(name.toUpperCase());
  }

  /** Raw stored bytes (possibly RNC-packed). */
  stored(entry: ArchiveEntry): Uint8Array {
    return this.bytes.subarray(entry.offset, entry.offset + entry.storedSize);
  }

  /** Decoded bytes of a member, by name or archive ID. Results are cached. */
  read(ref: string | number | ArchiveEntry): Uint8Array {
    const entry = typeof ref === 'string' ? this.find(ref) : typeof ref === 'number' ? this.entries[ref] : ref;
    check(entry, `DATA.ARC has no member ${String(ref)}`);
    let data = this.cache.get(entry.id);
    if (!data) {
      const stored = this.stored(entry);
      data = isRnc(stored) ? unpackRnc(stored) : stored;
      this.cache.set(entry.id, data);
    }
    return data;
  }

  /** Members whose name ends with the given extension (for example ".MAP"). */
  withExtension(extension: string): ArchiveEntry[] {
    const suffix = extension.toUpperCase();
    return this.entries.filter((e) => e.name.toUpperCase().endsWith(suffix));
  }
}
