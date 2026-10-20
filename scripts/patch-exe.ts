/**
 * Builds game/MACHHUNT.EXE from the untouched retail executable.
 *
 *   npx tsx scripts/patch-exe.ts [--check] [--out <path>]
 *
 * Two things are changed, both listed in runtime/patch/patches.json:
 *   1. A handful of bytes so the 1997 game starts on current Windows (use the
 *      game's own windowed renderer, skip the physical-CD checks).
 *   2. A new ".mhmod" section holding a 66-byte entry stub that loads
 *      MHRuntime.dll, calls MHRuntimeInit, then jumps to the original entry
 *      point with every register restored.
 *
 * The input must be the exact retail file; anything else is refused.
 * With --check nothing is written: the script verifies that the existing
 * game/MACHHUNT.EXE is exactly what it would produce.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'game', 'MACHHUNT.EXE');
const inputPath = join(root, 'retail', 'MACHHUNT_ORIGINAL.EXE');

const IMAGE_BASE = 0x00400000;
/** Import-table slots of the retail executable. */
const IAT_GET_PROC_ADDRESS = 0x0074a59c;
const IAT_LOAD_LIBRARY_A = 0x0074a5a0;
const ORIGINAL_ENTRY_RVA = 0x61980;

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const align = (value: number, to: number) => (value + to - 1) & ~(to - 1);
const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((b) => parseInt(b, 16)));

const spec = JSON.parse(readFileSync(join(root, 'runtime', 'patch', 'patches.json'), 'utf8'));
if (!existsSync(inputPath)) fail('retail/MACHHUNT_ORIGINAL.EXE is missing. Copy the untouched executable from your own copy of the game.');
const original = new Uint8Array(readFileSync(inputPath));
if (sha256(original) !== spec.original_sha256) fail(`retail/MACHHUNT_ORIGINAL.EXE is not the expected retail build (SHA-256 ${sha256(original)}).`);

/* ------------------------------------------------- 1. compatibility bytes */
let image = original.slice();
for (const patch of spec.compatibility_patches) {
  const offset = Number(patch.file_offset);
  const before = hex(patch.before);
  const after = hex(patch.after);
  if (before.length !== after.length) fail(`${patch.purpose}: patch length mismatch`);
  if (!before.every((b, i) => image[offset + i] === b)) fail(`${patch.purpose}: the bytes at 0x${offset.toString(16)} are not what the patch expects`);
  image.set(after, offset);
}

/* --------------------------------------------------- 2. loader entry stub */
function buildStub(sectionVa: number, entryVa: number): Uint8Array {
  const code: number[] = [];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  code.push(0x9c, 0x60); // pushfd; pushad
  const pushDll = code.length + 1;
  code.push(0x68, 0, 0, 0, 0); // push "MHRuntime.dll"
  code.push(0xff, 0x15, ...u32(IAT_LOAD_LIBRARY_A)); // call [LoadLibraryA]
  code.push(0x85, 0xc0); // test eax, eax
  const jz1 = code.length;
  code.push(0x74, 0);
  const pushExport = code.length + 1;
  code.push(0x68, 0, 0, 0, 0); // push "MHRuntimeInit"
  code.push(0x50); // push eax (module)
  code.push(0xff, 0x15, ...u32(IAT_GET_PROC_ADDRESS)); // call [GetProcAddress]
  code.push(0x85, 0xc0);
  const jz2 = code.length;
  code.push(0x74, 0);
  code.push(0xff, 0xd0); // call eax
  const skip = code.length;
  code.push(0x61, 0x9d); // popad; popfd
  const jump = code.length;
  code.push(0xe9, 0, 0, 0, 0); // jmp original entry
  const dllAt = code.length;
  code.push(...Buffer.from('MHRuntime.dll\0', 'latin1'));
  const exportAt = code.length;
  code.push(...Buffer.from('MHRuntimeInit\0', 'latin1'));
  for (const at of [jz1, jz2]) code[at + 1] = skip - (at + 2);
  code.splice(pushDll, 4, ...u32(sectionVa + dllAt));
  code.splice(pushExport, 4, ...u32(sectionVa + exportAt));
  code.splice(jump + 1, 4, ...u32((entryVa - (sectionVa + jump + 5)) >>> 0));
  return Uint8Array.from(code);
}

const view = () => new DataView(image.buffer, image.byteOffset, image.byteLength);
const pe = view().getUint32(0x3c, true);
if (view().getUint32(pe, true) !== 0x00004550) fail('Not a PE executable');
const coff = pe + 4;
const sectionCount = view().getUint16(coff + 2, true);
const optionalSize = view().getUint16(coff + 16, true);
const optional = coff + 20;
if (sectionCount !== 6 || optionalSize !== 0xe0) fail('Unexpected PE layout');
const sectionAlign = view().getUint32(optional + 0x20, true);
const fileAlign = view().getUint32(optional + 0x24, true);
if (view().getUint32(optional + 0x10, true) !== ORIGINAL_ENTRY_RVA) fail('Unexpected entry point');
const sectionTable = optional + optionalSize;
const last = sectionTable + (sectionCount - 1) * 40;
const lastVirtualSize = view().getUint32(last + 8, true);
const lastRva = view().getUint32(last + 12, true);
const lastRawSize = view().getUint32(last + 16, true);
const lastRaw = view().getUint32(last + 20, true);
const newRva = align(lastRva + Math.max(lastVirtualSize, lastRawSize), sectionAlign);
const newRaw = align(lastRaw + lastRawSize, fileAlign);
if (newRaw !== image.length) fail('Unexpected data after the last section');

const stub = buildStub(IMAGE_BASE + newRva, IMAGE_BASE + ORIGINAL_ENTRY_RVA);
const newRawSize = align(stub.length, fileAlign);
const grown = new Uint8Array(image.length + newRawSize);
grown.set(image);
grown.set(stub, newRaw);
image = grown;

const header = sectionTable + sectionCount * 40;
if (header + 40 > view().getUint32(sectionTable + 20, true)) fail('No room for another section header');
image.set(Buffer.from('.mhmod\0\0', 'latin1'), header);
const v = view();
v.setUint32(header + 8, stub.length, true); // virtual size
v.setUint32(header + 12, newRva, true);
v.setUint32(header + 16, newRawSize, true);
v.setUint32(header + 20, newRaw, true);
v.setUint32(header + 36, 0x60000020, true); // code | execute | read
v.setUint16(coff + 2, sectionCount + 1, true);
v.setUint32(optional + 0x10, newRva, true); // entry point
v.setUint32(optional + 0x38, align(newRva + stub.length, sectionAlign), true); // image size
v.setUint32(optional + 0x40, 0, true); // checksum

const digest = sha256(image);
if (digest !== spec.patched_sha256) fail(`Internal error: the patched executable hashes to ${digest}, not the recorded ${spec.patched_sha256}.`);

if (args.includes('--check')) {
  if (!existsSync(outPath)) fail(`${outPath} does not exist.`);
  const current = sha256(new Uint8Array(readFileSync(outPath)));
  if (current !== digest) fail(`${outPath} differs from the expected patched executable.`);
  console.log(`${outPath} is the expected patched executable (${digest.slice(0, 16)}…).`);
} else {
  writeFileSync(outPath, image);
  console.log(`Wrote ${outPath} (${image.length} bytes, SHA-256 ${digest.slice(0, 16)}…).`);
}
