/**
 * Test access to the user's retail game files. Corpus tests are skipped when
 * the files are absent so a checkout without game data still passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, PeImage } from '../src/index.ts';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const archivePath = join(repoRoot, 'game', 'DATA', 'DATA.ARC');
const exePath = join(repoRoot, 'retail', 'MACHHUNT_ORIGINAL.EXE');

export const hasGameData = existsSync(archivePath) && existsSync(exePath);

let archive: Archive | undefined;
let exe: PeImage | undefined;

export function gameArchive(): Archive {
  return (archive ??= new Archive(new Uint8Array(readFileSync(archivePath))));
}

export function retailExe(): PeImage {
  return (exe ??= new PeImage(new Uint8Array(readFileSync(exePath))));
}
