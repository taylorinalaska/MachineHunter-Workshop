import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGame, setupGame } from './setup-game.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-setup-'));
  const source = join(dir, 'original game'), base = join(dir, 'workshop');
  const put = (file, data) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, data); };
  put(join(source, 'MACHHUNT.EXE'), 'original fixture');
  put(join(base, 'runtime/patch/patches.json'), JSON.stringify({ original_sha256: sha('original fixture'), patched_sha256: sha('patched fixture') }));
  for (const p of ['MHRuntime.dll', 'lua54.dll']) put(join(base, 'game', p), 'runtime fixture');
  return { source, base, put };
}

test('unsupported executables are refused before copying any retail files', () => {
  const { source, base, put } = fixture();
  put(join(source, 'MACHHUNT.EXE'), 'wrong version');
  assert.throws(() => setupGame(source, base), /Unsupported executable/);
  assert.equal(existsSync(join(base, 'retail')), false);
  assert.equal(readFileSync(join(source, 'MACHHUNT.EXE'), 'utf8'), 'wrong version');
});

test('missing movies are reported before changing the destination', () => {
  const { source, base, put } = fixture();
  put(join(source, 'DATA/DATA.ARC'), 'archive fixture');
  assert.throws(() => setupGame(source, base), /TITLE1.ETV is missing/);
  assert.equal(existsSync(join(base, 'retail')), false);
  assert.throws(() => checkGame(base), /Run Setup.bat/);
});

test('setup imports only required files, preserves settings, and is repeatable', () => {
  const { source, base, put } = fixture();
  for (const p of ['DATA/DATA.ARC','MOVIES/TITLE1.ETV','MOVIES/TITLE2.ETV']) put(join(source, p), p);
  put(join(source, 'MACHHUNT.INI'), 'private profile');
  put(join(base, 'game/mods/settings.cfg'), 'keep these settings');
  put(join(base, 'scripts/patch-exe.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('../game/MACHHUNT.EXE', import.meta.url), 'patched fixture');");
  setupGame(source, base);
  setupGame(source, base);
  checkGame(base);
  assert.equal(readFileSync(join(source, 'MACHHUNT.EXE'), 'utf8'), 'original fixture');
  assert.equal(readFileSync(join(base, 'game/mods/settings.cfg'), 'utf8'), 'keep these settings');
  assert.equal(existsSync(join(base, 'game/MACHHUNT.INI')), false);
});
