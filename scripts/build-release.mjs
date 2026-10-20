/** Build from an allowlist, never by zipping a working directory or game install. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { transformSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] || 'release/v0.1');
if (existsSync(output)) throw new Error(`Output already exists: ${output}. Choose a new output folder; existing releases are never overwritten.`);
const deps = JSON.parse(readFileSync(join(root, 'scripts/release-deps.json')));
const cache = join(root, 'build/release-deps');
mkdirSync(cache, { recursive: true });
const digest = (data) => createHash('sha256').update(data).digest('hex');
async function download(url, path, sha) {
  if (!existsSync(path) || digest(readFileSync(path)) !== sha) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (digest(data) !== sha) throw new Error(`Checksum mismatch: ${url}`);
    writeFileSync(path, data);
  }
}
await download(`https://nodejs.org/dist/${deps.node.version}/win-x64/node.exe`, join(cache, 'node.exe'), deps.node.sha256);
const lua = join(cache, 'lua54.dll');
if (!existsSync(lua) || digest(readFileSync(lua)) !== deps.lua.sha256) {
  const archive = join(cache, 'lua.zip');
  await download(deps.lua.url, archive, deps.lua.archive_sha256);
  const unpack = join(cache, `lua-${Date.now()}`);
  execFileSync('python', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, unpack], { stdio: 'inherit' });
  copyFileSync(join(unpack, 'lua54.dll'), lua);
  if (digest(readFileSync(lua)) !== deps.lua.sha256) throw new Error('Lua DLL checksum mismatch');
}
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/workshop/vite.config.ts', 'apps/workshop'], { cwd: root, stdio: 'inherit' });
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'runtime/build.ps1'), '-NoInstall'], { cwd: root, stdio: 'inherit' });

mkdirSync(output, { recursive: true });
const name = 'MachineHunter-Workshop-v0.1';
const binary = join(output, `${name}-windows-x64`);
const source = join(output, `${name}-source`);
function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
function tree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink refused: ${from}/${entry.name}`);
    if (entry.isDirectory()) tree(join(from, entry.name), join(to, entry.name));
    else copy(join(from, entry.name), join(to, entry.name));
  }
}
// Export current source, including this release's uncommitted edits, without Git history.
const files = [];
function sourceFiles(folder) {
  if (!existsSync(join(root, folder))) return;
  for (const e of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = `${folder}/${e.name}`;
    if (e.isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
    if (e.isDirectory()) sourceFiles(path); else files.push(path);
  }
}
for (const folder of ['apps/workshop/src','apps/workshop/server','apps/workshop/test','apps/workshop/public','packages/core/src','packages/core/test','runtime/src','runtime/sdk','runtime/patch','runtime/tests','mods','gamedata','licenses','docs/sdk']) sourceFiles(folder);
for (const folder of ['scripts','apps/workshop','packages/core']) for (const e of readdirSync(join(root, folder), {withFileTypes:true})) if(e.isFile()) files.push(`${folder}/${e.name}`);
const allowedRoots = /^(apps\/workshop\/(src|server|test|public)\/|packages\/core\/(src|test)\/|runtime\/(src|sdk|patch|tests)\/|mods\/|gamedata\/|licenses\/|docs\/sdk\/)/;
const allowedFiles = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md', 'Workshop.bat', 'Play.bat', 'Setup.bat', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts', 'runtime/build.ps1', 'docs/DEVELOPING.md', 'docs/MODDING.md', 'docs/ARCHITECTURE.md', 'docs/THIRD_PARTY.md']);
for (const file of new Set([...files, ...allowedFiles])) {
  if (!existsSync(join(root, file))) continue;
  const allowed = allowedRoots.test(file) || allowedFiles.has(file) || /^scripts\/(?!build-gamedata\.)[^/]+\.(mjs|ts|ps1|json)$/.test(file) || /^(apps\/workshop|packages\/core)\/[^/]+\.(json|ts|html)$/.test(file);
  if (allowed && !/(^|\/)\.env(?:\.|$)/i.test(file) && !/\.(exe|dll|a|lib|obj|pdb|mhproject|log|tsbuildinfo|pem|key)$/i.test(file)) copy(join(root, file), join(source, file));
}
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md', 'Workshop.bat', 'Play.bat', 'Setup.bat', 'scripts/setup-game.mjs', 'scripts/launch.mjs', 'runtime/patch/patches.json']) copy(join(root, file), join(binary, file));
tree(join(root, 'apps/workshop/dist'), join(binary, 'apps/workshop/dist'));
tree(join(root, 'apps/workshop/server'), join(binary, 'apps/workshop/server'));
tree(join(root, 'licenses'), join(binary, 'licenses'));
copy(join(root, 'docs/MODDING.md'), join(binary, 'docs/MODDING.md'));
tree(join(root, 'docs/sdk'), join(binary, 'docs/sdk'));
copy(join(cache, 'node.exe'), join(binary, 'tools/node/node.exe'));
copy(lua, join(binary, 'game/lua54.dll'));
copy(join(root, 'build/runtime/MHRuntime.dll'), join(binary, 'game/MHRuntime.dll'));
writeFileSync(join(binary, 'scripts/patch-exe.mjs'), transformSync(readFileSync(join(root, 'scripts/patch-exe.ts'), 'utf8'), { loader: 'ts', target: 'es2022', format: 'esm' }).code);
for (const mod of readdirSync(join(root, 'mods'), { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const from = join(root, 'mods', mod.name);
  if (!existsSync(join(from, 'mod.json'))) continue;
  for (const file of ['mod.json', 'main.lua']) if (existsSync(join(from, file))) copy(join(from, file), join(binary, 'game/mods', mod.name, file));
  const dll = join(root, 'build/mods', mod.name, 'mod.dll');
  if (existsSync(dll)) copy(dll, join(binary, 'game/mods', mod.name, 'mod.dll'));
  if (existsSync(join(from, 'assets'))) tree(join(from, 'assets'), join(binary, 'game/mods', mod.name, 'assets'));
}
writeFileSync(join(binary, 'VERSION'), '0.1\n');
function manifest(folder) {
  const result = {};
  function walk(base, relative = '') { for (const e of readdirSync(base, { withFileTypes: true })) { const p = relative ? `${relative}/${e.name}` : e.name; if (e.isDirectory()) walk(join(base, e.name), p); else result[p] = digest(readFileSync(join(base, e.name))); } }
  walk(folder); return result;
}
function zip(folder, target) {
  // Python's zipfile handles long files and preserves the containing folder.
  const code = 'import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=6) as z:\n for f in sorted(p.rglob("*")):\n  if f.is_file(): z.write(f,str(pathlib.Path(p.name)/f.relative_to(p)))';
  execFileSync('python', ['-c', code, folder, target], { stdio: 'inherit' });
}
const sourceZip = join(output, `${name}-source.zip`);
zip(source, sourceZip);
copy(sourceZip, join(binary, 'source', `${name}-source.zip`));
writeFileSync(join(binary, 'FILES.sha256.json'), JSON.stringify(manifest(binary), null, 2));
const binaryZip = join(output, `${name}-windows-x64.zip`);
zip(binary, binaryZip);
writeFileSync(join(output, 'SHA256SUMS.txt'), [sourceZip, binaryZip].map((f) => `${digest(readFileSync(f))}  ${f.slice(output.length + 1)}`).join('\n') + '\n');
console.log(`\nRelease ready: ${output}`);
