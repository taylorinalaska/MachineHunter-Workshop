/**
 * Reading a mod someone wants to install: a .zip, or a folder picked in the
 * browser. Either way the result is the files of one mod package, keyed by
 * their path inside the mod (`mod.json`, `main.lua`, `assets/audio/x.wav`).
 */
import { type ModManifest, checkModManifest } from '@mh/core';

const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
/** The file names the Workshop's server will write (see server/api.mjs). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.()'-]{0,95}$/;

export interface ModPackage {
  manifest: ModManifest;
  problems: string[];
  files: Map<string, Uint8Array>;
  bytes: number;
  hasNative: boolean;
  hasScript: boolean;
  maps: number;
  /** Game files it replaces (assets/archive) and sounds of its own (assets/audio). */
  archive: number;
  audio: number;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Files of a ZIP archive; stored and deflated entries, no encryption or ZIP64. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That file is not a ZIP archive.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > MAX_FILES) throw new Error(`The archive holds ${count} files; a mod is limited to ${MAX_FILES}.`);

  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('The archive is damaged.');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('The archive is password protected.');
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('The archive is too large (ZIP64).');
    total += size;
    if (total > MAX_BYTES) throw new Error('The mod is larger than 64 MB.');
    if (local + 30 > bytes.length) throw new Error('The archive is damaged.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
    else throw new Error(`"${name}" uses a compression method this tool cannot read.`);
  }
  return files;
}

/** Files of a folder chosen with a directory picker, keyed by their path below the chosen folder's parent. */
export async function readFolder(list: FileList): Promise<Map<string, Uint8Array>> {
  if (list.length > MAX_FILES) throw new Error(`The folder holds ${list.length} files; a mod is limited to ${MAX_FILES}.`);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of Array.from(list)) {
    total += file.size;
    if (total > MAX_BYTES) throw new Error('The mod is larger than 64 MB.');
    files.set(file.webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer()));
  }
  return files;
}

/**
 * Turn a pile of files into a mod package. The mod is wherever `mod.json` is:
 * at the top, or inside the one folder an archive was made from.
 */
export function readModPackage(source: Map<string, Uint8Array>): ModPackage {
  const manifests = [...source.keys()].filter((p) => p === 'mod.json' || p.endsWith('/mod.json')).sort((a, b) => a.length - b.length);
  if (!manifests.length) throw new Error('There is no mod.json in it, so it is not a Machine Hunter mod.');
  const root = manifests[0].slice(0, -'mod.json'.length);

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(source.get(manifests[0])!));
  } catch (error) {
    throw new Error(`Its mod.json is not valid JSON: ${(error as Error).message}`);
  }
  // The folder a mod is installed in is always named after its id, so only the manifest itself is checked here.
  const { manifest, problems } = checkModManifest(json);
  if (!manifest) throw new Error(`Its mod.json cannot be used. ${problems.join(' ')}`);

  const files = new Map<string, Uint8Array>();
  const refused: string[] = [];
  let bytes = 0;
  for (const [path, data] of source) {
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    const segments = relative.split('/');
    if (segments.some((s) => !SAFE_SEGMENT.test(s) || s === '.' || s === '..')) {
      refused.push(relative);
      continue;
    }
    files.set(relative, data);
    bytes += data.length;
  }
  if (refused.length) problems.push(`${refused.length} file${refused.length > 1 ? 's have names' : ' has a name'} the Workshop will not write and will be left out: ${refused.slice(0, 4).join(', ')}${refused.length > 4 ? '…' : ''}`);

  const paths = [...files.keys()];
  return {
    manifest,
    problems,
    files,
    bytes,
    hasNative: files.has('mod.dll'),
    hasScript: files.has('main.lua'),
    maps: paths.filter((p) => p.startsWith('maps/') && p.toLowerCase().endsWith('.mhproject')).length,
    archive: paths.filter((p) => p.startsWith('assets/archive/')).length,
    audio: paths.filter((p) => p.startsWith('assets/audio/')).length,
  };
}
