/**
 * The Workshop's local file API. It is the only part of the tool that touches
 * the disk: it serves the user's game files to the browser UI, stores
 * projects, installs mod files into the game folder and launches the game.
 *
 * It is used by both the Vite dev server (see vite.config.ts) and the
 * stand-alone server (serve.mjs). It only ever listens on the loopback
 * interface, refuses requests that did not come from its own page, and never
 * reads or writes outside the three folders below, except map files the user
 * picks in the Windows Open and Save As dialogs (files.mjs).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFiles } from './files.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const gameDir = join(repoRoot, 'game');
const retailDir = join(repoRoot, 'retail');
const projectsDir = join(repoRoot, 'projects');
const modsDir = join(gameDir, 'mods');
/** Which mods are switched off and what their options are set to; shared with the game. */
const modSettingsFile = join(modsDir, 'settings.cfg');

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()'-]{0,95}$/;
const MOD_ID = /^[A-Za-z0-9._-]{1,95}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Resolve `parts` under `base`, refusing anything that escapes it. */
function inside(base, ...parts) {
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) throw new HttpError(400, 'Path escapes its folder');
  return full;
}

function safeName(name) {
  if (!FILE_NAME.test(name) || name.includes('..')) throw new HttpError(400, `"${name}" is not an allowed file name`);
  return name;
}

function safeRelative(path) {
  const segments = String(path).split('/');
  if (!segments.length || segments.some((s) => !FILE_NAME.test(s) || s === '.' || s === '..')) throw new HttpError(400, 'Invalid path');
  return segments;
}

/** Write a file so that a crash part-way never leaves it half written: write a temporary file, then swap it in. */
async function writeWhole(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Upload is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function sendFile(res, path, type = 'application/octet-stream') {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (!info.isFile()) throw new HttpError(404, 'File not found');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-store' });
  createReadStream(path).pipe(res);
}

async function listMods() {
  if (!existsSync(modsDir)) return [];
  const out = [];
  for (const entry of await readdir(modsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !MOD_ID.test(entry.name)) continue;
    const dir = join(modsDir, entry.name);
    let manifest = null;
    let manifestError = null;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'mod.json'), 'utf8'));
    } catch (error) {
      // A folder without a readable mod.json is listed as broken.
      manifestError = error.code === 'ENOENT' ? 'There is no mod.json in this folder.' : `mod.json could not be read: ${error.message}`;
    }
    const names = async (...parts) => {
      try {
        return (await readdir(join(dir, ...parts), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
      } catch {
        return [];
      }
    };
    const maps = [];
    try {
      for (const f of await readdir(join(dir, 'maps'))) {
        if (f.toLowerCase().endsWith('.mhproject')) maps.push({ file: f, size: (await stat(join(dir, 'maps', f))).size });
      }
    } catch {
      /* no maps folder */
    }
    out.push({
      id: entry.name,
      manifest,
      manifestError,
      maps,
      hasNative: existsSync(join(dir, 'mod.dll')),
      hasScript: existsSync(join(dir, 'main.lua')),
      /** Game files it replaces, and sounds of its own. */
      archive: await names('assets', 'archive'),
      audio: await names('assets', 'audio'),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function status() {
  const has = (...p) => existsSync(join(...p));
  return {
    root: repoRoot,
    game: {
      archive: has(gameDir, 'DATA', 'DATA.ARC'),
      executable: has(gameDir, 'MACHHUNT.EXE'),
      runtime: has(gameDir, 'MHRuntime.dll'),
      movies: has(gameDir, 'MOVIES', 'TITLE1.ETV') && has(gameDir, 'MOVIES', 'TITLE2.ETV'),
      lua: has(gameDir, 'lua54.dll'),
    },
    retailExecutable: has(retailDir, 'MACHHUNT_ORIGINAL.EXE'),
  };
}

/**
 * Start the game. With `map` (a mod ID and a file in its maps folder) the
 * runtime is asked, through the MH_AUTOSTART_MAP environment variable, to skip
 * the launcher dialog, the logos and the menus and load that map directly.
 */
/** Whether a copy of the game is already running (Windows only; elsewhere assume not). */
function gameRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq MACHHUNT.EXE', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return /"MACHHUNT\.EXE"/i.test(out);
  } catch {
    return false;
  }
}

function launchGame(map) {
  const exe = join(gameDir, 'MACHHUNT.EXE');
  // A second copy cannot take the display and would fight the first over the log and settings.
  if (gameRunning()) throw new HttpError(409, 'The game is already running. Close it first.');
  if (!existsSync(exe)) throw new HttpError(409, 'game/MACHHUNT.EXE is missing');
  if (!existsSync(join(gameDir, 'MHRuntime.dll'))) throw new HttpError(409, 'game/MHRuntime.dll is missing. Build the runtime first (npm run runtime:build).');
  const env = { ...process.env };
  delete env.MH_AUTOSTART_MAP;
  if (map) {
    if (!MOD_ID.test(map.mod)) throw new HttpError(400, 'Invalid mod ID');
    const file = safeName(map.file);
    if (!file.toLowerCase().endsWith('.mhproject')) throw new HttpError(400, 'Only .mhproject maps can be started directly');
    if (!existsSync(inside(modsDir, map.mod, 'maps', file))) throw new HttpError(404, `${file} is not installed in mods/${map.mod}/maps`);
    // Relative to the game folder, which is the game's working directory.
    env.MH_AUTOSTART_MAP = ['mods', map.mod, 'maps', file].join('\\');
  }
  const child = spawn(exe, [], { cwd: gameDir, detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

/** Map files the user keeps anywhere, picked in the Windows file dialogs; see files.mjs. */
const files = createFiles({ projectsDir, HttpError });

/**
 * Handle one `/api/...` request. Returns false when the URL is not an API
 * route so the caller can fall through to static files.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    // Only our own page may talk to the API: the Host must be loopback, and
    // anything that changes state must be a same-origin request carrying a
    // header a cross-site form or image tag cannot set.
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden host');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
    if (req.method !== 'GET' && req.headers['x-mh-workshop'] !== '1') throw new HttpError(403, 'Missing Workshop request header');

    const route = url.pathname.slice(5).split('/').map(decodeURIComponent);
    const method = req.method;

    if (route[0] === 'status' && method === 'GET') return sendJson(res, await status()), true;
    if (route[0] === 'game' && route[1] === 'archive' && method === 'GET') return await sendFile(res, join(gameDir, 'DATA', 'DATA.ARC')), true;
    if (route[0] === 'game' && route[1] === 'retail-exe' && method === 'GET') return await sendFile(res, join(retailDir, 'MACHHUNT_ORIGINAL.EXE')), true;
    if (route[0] === 'game' && route[1] === 'log' && method === 'GET') {
      const path = join(gameDir, 'logs', 'mh-runtime.log');
      return sendJson(res, { text: existsSync(path) ? await readFile(path, 'utf8') : '' }), true;
    }
    if (route[0] === 'mod-settings' && route.length === 1) {
      if (method === 'GET') return sendJson(res, { text: existsSync(modSettingsFile) ? await readFile(modSettingsFile, 'utf8') : '' }), true;
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body.length > 32 * 1024) throw new HttpError(413, 'The settings file is limited to 32 KB');
        await mkdir(modsDir, { recursive: true });
        await writeWhole(modSettingsFile, body);
        return sendJson(res, { ok: true }), true;
      }
    }
    if (route[0] === 'game' && route[1] === 'launch' && method === 'POST') {
      const mod = url.searchParams.get('mod');
      const map = url.searchParams.get('map');
      launchGame(mod && map ? { mod, file: map } : null);
      return sendJson(res, { ok: true }), true;
    }

    if (await files.handle(route, method, url, req, res, { readBody, sendJson, sendFile })) return true;

    if (route[0] === 'mods') {
      if (route.length === 1 && method === 'GET') return sendJson(res, await listMods()), true;
      const id = route[1] ?? '';
      if (!MOD_ID.test(id)) throw new HttpError(400, 'Invalid mod id');
      const modDir = inside(modsDir, id);
      if (route.length === 2 && method === 'DELETE') {
        // Removing a mod deletes its folder: code, assets and any maps installed in it.
        if (modDir === modsDir) throw new HttpError(400, 'Invalid mod id');
        await rm(modDir, { recursive: true, force: true });
        return sendJson(res, { ok: true }), true;
      }
      if (route[2] === 'file') {
        const path = inside(modDir, ...safeRelative(url.searchParams.get('path') ?? ''));
        if (method === 'GET') return await sendFile(res, path), true;
        if (method === 'PUT') {
          await mkdir(dirname(path), { recursive: true });
          await writeWhole(path, await readBody(req));
          return sendJson(res, { ok: true }), true;
        }
        if (method === 'DELETE') {
          await rm(path, { force: true });
          return sendJson(res, { ok: true }), true;
        }
      }
    }
    throw new HttpError(404, 'Unknown API route');
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.status : 500;
    if (!res.headersSent) sendJson(res, { error: error.message ?? String(error) }, statusCode);
    else res.end();
    return true;
  }
}
