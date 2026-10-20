/**
 * Unpacks every member of game/DATA/DATA.ARC (decompressed) into a folder.
 *
 *   npx tsx scripts/extract-archive.ts [output-folder]
 *
 * The Workshop itself never needs this: it reads the archive directly. It is
 * here for research with external tools. The default output, build/extracted,
 * is ignored by git because the contents are the game's own data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, isRnc } from '../packages/core/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = join(root, 'game', 'DATA', 'DATA.ARC');
const out = process.argv[2] ?? join(root, 'build', 'extracted');
if (!existsSync(archivePath)) {
  console.error('game/DATA/DATA.ARC is missing.');
  process.exit(1);
}
const archive = new Archive(new Uint8Array(readFileSync(archivePath)));
mkdirSync(out, { recursive: true });
let packed = 0;
const manifest = archive.entries.map((entry) => {
  const data = archive.read(entry);
  const rnc = isRnc(archive.stored(entry));
  if (rnc) packed++;
  writeFileSync(join(out, entry.name), data);
  return { id: entry.id, name: entry.name, storedSize: entry.storedSize, size: data.length, rnc };
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Extracted ${manifest.length} files (${packed} were RNC-packed) to ${out}`);
