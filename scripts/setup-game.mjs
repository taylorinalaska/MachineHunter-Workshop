import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const specFor = (base) => JSON.parse(readFileSync(join(base, 'runtime/patch/patches.json'), 'utf8'));
const required = ['DATA/DATA.ARC', 'MOVIES/TITLE1.ETV', 'MOVIES/TITLE2.ETV'];

export function checkGame(base = root) {
  const spec = specFor(base);
  const missing = [...required.map((p) => `game/${p}`), 'retail/MACHHUNT_ORIGINAL.EXE', 'game/MACHHUNT.EXE', 'game/MHRuntime.dll', 'game/lua54.dll'].filter((p) => !existsSync(join(base, p)));
  if (missing.length) throw new Error(`Game setup is incomplete. Run Setup.bat.\nMissing: ${missing.join(', ')}`);
  if (hash(join(base, 'retail/MACHHUNT_ORIGINAL.EXE')) !== spec.original_sha256) throw new Error('The original executable is unsupported. Run Setup.bat with an unmodified retail copy.');
  if (hash(join(base, 'game/MACHHUNT.EXE')) !== spec.patched_sha256) throw new Error('The game executable needs repairing. Run Setup.bat again.');
}

export function setupGame(source, base = root) {
  source = resolve(source);
  if (!statSync(source).isDirectory()) source = dirname(source);
  const original = ['MACHHUNT.EXE', 'MACHHUNT_ORIGINAL.EXE'].map((p) => join(source, p)).find(existsSync);
  if (!original) throw new Error('Choose the game folder containing the original MACHHUNT.EXE, DATA and MOVIES folders.');
  const spec = specFor(base);
  if (hash(original) !== spec.original_sha256) throw new Error(`Unsupported executable. v0.1 requires the unmodified 699,904-byte Windows retail MACHHUNT.EXE.\nExpected SHA-256: ${spec.original_sha256}\nYour original installation has not been changed.`);
  for (const file of required) if (!existsSync(join(source, file)) || statSync(join(source, file)).size === 0) throw new Error(`${file} is missing from the selected game folder. Copy it from your own game disc/installation first.`);
  for (const file of ['MHRuntime.dll', 'lua54.dll']) if (!existsSync(join(base, 'game', file))) throw new Error(`The Workshop download is incomplete: game/${file} is missing. Extract the complete release ZIP, or follow docs/DEVELOPING.md to build from source.`);
  // Validate before copying; import no profiles, save games, settings or mods.
  for (const [from, to] of [[original, join(base, 'retail/MACHHUNT_ORIGINAL.EXE')], ...required.map((p) => [join(source, p), join(base, 'game', p)])]) {
    mkdirSync(dirname(to), { recursive: true });
    if (resolve(from).toLowerCase() !== resolve(to).toLowerCase()) copyFileSync(from, to);
  }
  const compiled = join(base, 'scripts/patch-exe.mjs');
  const args = existsSync(compiled) ? [compiled] : [join(base, 'node_modules/tsx/dist/cli.mjs'), join(base, 'scripts/patch-exe.ts')];
  execFileSync(process.execPath, args, { cwd: base, stdio: 'inherit', windowsHide: true });
  checkGame(base);
  console.log('\nSetup complete. Open Workshop.bat to edit maps, or Play.bat to play.');
}

export function chooseGameFolder() {
  if (process.platform !== 'win32') throw new Error('Pass the original game folder as an argument to Setup.bat.');
  const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select your original Machine Hunter folder (MACHHUNT.EXE, DATA, MOVIES)'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') { [Console]::Write($d.SelectedPath) }";
  const folder = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  if (!folder) throw new Error('Setup cancelled. Run Setup.bat whenever you are ready.');
  return folder;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) { checkGame(); console.log('Game files are ready.'); }
    else setupGame(process.argv[2] || chooseGameFolder());
  } catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
}
