/**
 * Minimal PE32 image reader: maps virtual addresses in the retail executable
 * to file bytes so recovered data tables can be read straight from the user's
 * own copy of the game instead of being baked into this repository.
 */
import { ByteReader, FormatError, check } from '../util/binary.ts';

/** SHA-256 of the untouched retail MACHHUNT.EXE this project's addresses refer to. */
export const RETAIL_EXE_SHA256 = '1e89f2a61c7627426301fd1c45424981ceba643036b4d536df91cb1f6b986714';
export const RETAIL_EXE_SIZE = 699904;
export const IMAGE_BASE = 0x00400000;

interface Section {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawOffset: number;
}

export class PeImage {
  private readonly r: ByteReader;
  readonly sections: readonly Section[];
  readonly imageBase: number;

  constructor(readonly bytes: Uint8Array) {
    const r = (this.r = new ByteReader(bytes));
    check(bytes.length > 0x40 && r.cstring(0, 2) === 'MZ', 'Not a Windows executable');
    const pe = r.u32(0x3c);
    check(r.u32(pe) === 0x00004550, 'Missing PE signature');
    check(r.u16(pe + 4) === 0x014c, 'Expected a 32-bit x86 executable');
    const sectionCount = r.u16(pe + 6);
    const optionalSize = r.u16(pe + 20);
    this.imageBase = r.u32(pe + 24 + 28);
    const table = pe + 24 + optionalSize;
    const sections: Section[] = [];
    for (let i = 0; i < sectionCount; i++) {
      const at = table + i * 40;
      sections.push({
        name: r.cstring(at, 8),
        virtualSize: r.u32(at + 8),
        virtualAddress: r.u32(at + 12),
        rawSize: r.u32(at + 16),
        rawOffset: r.u32(at + 20),
      });
    }
    this.sections = sections;
  }

  /** File offset backing a virtual address, or null for uninitialized (.bss-style) memory. */
  fileOffset(va: number): number | null {
    const rva = va - this.imageBase;
    for (const s of this.sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        const delta = rva - s.virtualAddress;
        return delta < s.rawSize ? s.rawOffset + delta : null;
      }
    }
    return null;
  }

  private at(va: number, size: number): number {
    const offset = this.fileOffset(va);
    const end = this.fileOffset(va + size - 1);
    if (offset === null || end === null) throw new FormatError(`VA 0x${va.toString(16)} is not backed by file data`);
    return offset;
  }

  isFileBacked(va: number): boolean {
    return this.fileOffset(va) !== null;
  }

  u8(va: number): number {
    return this.r.u8(this.at(va, 1));
  }
  i8(va: number): number {
    return this.r.i8(this.at(va, 1));
  }
  u16(va: number): number {
    return this.r.u16(this.at(va, 2));
  }
  i16(va: number): number {
    return this.r.i16(this.at(va, 2));
  }
  u32(va: number): number {
    return this.r.u32(this.at(va, 4));
  }
  i32(va: number): number {
    return this.r.i32(this.at(va, 4));
  }
  slice(va: number, size: number): Uint8Array {
    return this.r.slice(this.at(va, size), size);
  }
  cstring(va: number, cap = 256): string {
    const offset = this.fileOffset(va);
    return offset === null ? '' : this.r.cstring(offset, cap);
  }
}
