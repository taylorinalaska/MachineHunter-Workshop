/**
 * Map files wherever the user keeps them: the Windows Open and Save As
 * dialogs, reading and writing the files picked in them, the recent-files
 * list and autosaves.
 *
 * The browser page cannot name an arbitrary path and have it read or
 * written: only files the user picked in one of the dialogs (this session or
 * an earlier one, through the recent list) and the Workshop's own autosaves
 * are allowed, and only .mhproject files.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const MAX_RECENT = 15;

export function createFiles({ projectsDir, HttpError, showDialog }) {
  const recentFile = join(projectsDir, 'recent.json');
  const autosaveDir = join(projectsDir, 'autosave');
  /** Lower-cased full paths the page may read and write. */
  const allowed = new Set();
  let dialogOpen = false;
  let pendingDialog = null;

  const key = (path) => resolve(path).toLowerCase();
  const isMap = (path) => extname(path).toLowerCase() === '.mhproject';

  async function readRecent() {
    try {
      const list = JSON.parse(await readFile(recentFile, 'utf8'));
      return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
    } catch {
      // First run: the maps saved in the projects folder before files could be kept anywhere.
      if (!existsSync(projectsDir)) return [];
      return (await readdir(projectsDir)).filter((f) => isMap(f)).map((f) => join(projectsDir, f));
    }
  }

  async function writeRecent(list) {
    await mkdir(projectsDir, { recursive: true });
    await writeWhole(recentFile, JSON.stringify(list, null, 2));
  }

  async function remember(path) {
    const full = resolve(path);
    allowed.add(key(full));
    const list = (await readRecent()).filter((p) => key(p) !== key(full));
    await writeRecent([full, ...list].slice(0, MAX_RECENT));
  }

  async function check(path) {
    if (typeof path !== 'string' || !path) throw new HttpError(400, 'No file named');
    const full = resolve(path);
    if (!isMap(full)) throw new HttpError(400, 'Only .mhproject files can be opened and saved');
    if (allowed.has(key(full)) || full.toLowerCase().startsWith(autosaveDir.toLowerCase() + sep)) return full;
    if ((await readRecent()).some((p) => key(p) === key(full))) {
      allowed.add(key(full));
      return full;
    }
    throw new HttpError(403, 'Pick the file in the Open or Save As dialog first');
  }

  /** The Windows Open or Save As dialog, in front of every window. Resolves to the picked path, or null. */
  function dialog(kind, { directory, name, title }) {
    if (process.platform !== 'win32') throw new HttpError(501, 'The file dialogs need Windows');
    if (dialogOpen) throw new HttpError(409, 'A file dialog is already open');
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
if ($env:MH_DLG_KIND -eq 'save') {
  $d = New-Object System.Windows.Forms.SaveFileDialog
  $d.OverwritePrompt = $true
  $d.AddExtension = $true
  $d.DefaultExt = 'mhproject'
  $d.FileName = $env:MH_DLG_NAME
} else {
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.CheckFileExists = $true
}
$d.Filter = 'Machine Hunter maps (*.mhproject)|*.mhproject|All files (*.*)|*.*'
$d.Title = $env:MH_DLG_TITLE
if ($env:MH_DLG_DIR -and (Test-Path -LiteralPath $env:MH_DLG_DIR)) { $d.InitialDirectory = $env:MH_DLG_DIR }
$result = $d.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const env = { ...process.env, MH_DLG_KIND: kind, MH_DLG_DIR: directory ?? '', MH_DLG_NAME: name ?? '', MH_DLG_TITLE: title ?? '' };
    dialogOpen = true;
    return new Promise((done, fail) => {
      execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, windowsHide: true, timeout: 30 * 60 * 1000, encoding: 'utf8' }, (error, stdout) => {
        dialogOpen = false;
        if (error) return fail(new HttpError(500, `The file dialog failed: ${error.message}`));
        const picked = stdout.trim();
        done(picked ? resolve(picked) : null);
      });
    });
  }

  /** Where a map's autosave goes: one per file (or per unsaved map's name), in projects/autosave. */
  function autosavePath(forPath, name) {
    const stem = (forPath ? basename(forPath, extname(forPath)) : `unsaved-${name || 'map'}`).replace(/[^A-Za-z0-9 _.()'-]/g, '_').slice(0, 60) || 'map';
    const tag = forPath ? `-${createHash('sha1').update(key(forPath)).digest('hex').slice(0, 8)}` : '';
    return join(autosaveDir, `${stem}${tag}.mhproject`);
  }

  async function info(path) {
    try {
      const s = await stat(path);
      return { size: s.size, modified: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Lists the autosaves with the file each belongs to. */
  async function autosaves() {
    if (!existsSync(autosaveDir)) return [];
    const out = [];
    for (const f of await readdir(autosaveDir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await readFile(join(autosaveDir, f), 'utf8'));
        const file = join(autosaveDir, f.replace(/\.json$/i, '.mhproject'));
        const i = await info(file);
        if (i) out.push({ autosave: file, for: meta.for ?? null, name: meta.name ?? '', ...i });
      } catch {
        /* a stray file */
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  return {
    async handle(route, method, url, req, res, { readBody, sendJson, sendFile }) {
      if (route[0] === 'dialog' && method === 'GET') {
        if (!pendingDialog || route[1] !== pendingDialog.id) throw new HttpError(404, 'File dialog not found');
        const { result, error } = pendingDialog;
        if (error) throw error;
        sendJson(res, result ?? { pending: true });
        return true;
      }
      if (route[0] === 'dialog' && method === 'POST') {
        if (pendingDialog && !pendingDialog.result && !pendingDialog.error) throw new HttpError(409, 'A file dialog is already open');
        const kind = route[1] === 'save' ? 'save' : 'open';
        const recent = await readRecent();
        const suggested = url.searchParams.get('path');
        const directory = suggested ? dirname(resolve(suggested)) : recent[0] ? dirname(recent[0]) : projectsDir;
        const name = url.searchParams.get('name') ?? (suggested ? basename(suggested) : '');
        // Do not hold an HTTP connection open while the user chooses a file.
        // Browsers and local servers can time out an idle dialog request.
        const job = { id: randomUUID(), result: null, error: null };
        pendingDialog = job;
        void Promise.resolve().then(() => (showDialog ?? dialog)(kind, { directory, name, title: kind === 'save' ? 'Save map as' : 'Open map' })).then((picked) => {
          if (picked && !isMap(picked)) throw new HttpError(400, 'Maps are .mhproject files');
          if (picked) allowed.add(key(picked));
          job.result = { path: picked };
        }).catch((error) => { job.error = error; });
        sendJson(res, { dialog: job.id });
        return true;
      }
      if (route[0] === 'file') {
        const path = await check(url.searchParams.get('path'));
        if (method === 'GET') {
          await sendFile(res, path);
          // Opening an autosave does not put it in the recent list.
          if (!path.toLowerCase().startsWith(autosaveDir.toLowerCase() + sep)) await remember(path);
          return true;
        }
        if (method === 'PUT') {
          await mkdir(dirname(path), { recursive: true });
          await writeWhole(path, await readBody(req));
          await remember(path);
          sendJson(res, { ok: true, ...(await info(path)) });
          return true;
        }
      }
      if (route[0] === 'recent') {
        if (method === 'GET') {
          const list = await readRecent();
          sendJson(res, await Promise.all(list.map(async (path) => ({ path, name: basename(path), ...((await info(path)) ?? { size: 0, modified: 0, missing: true }) }))));
          return true;
        }
        if (method === 'DELETE') {
          const path = url.searchParams.get('path') ?? '';
          await writeRecent((await readRecent()).filter((p) => key(p) !== key(path)));
          sendJson(res, { ok: true });
          return true;
        }
      }
      if (route[0] === 'reveal' && method === 'POST') {
        const path = await check(url.searchParams.get('path'));
        if (process.platform === 'win32') execFile('explorer.exe', [`/select,${path}`], { windowsHide: false }, () => {});
        sendJson(res, { ok: true });
        return true;
      }
      if (route[0] === 'autosave') {
        const forPath = url.searchParams.get('for');
        const name = url.searchParams.get('name') ?? '';
        if (forPath) await check(forPath);
        const file = autosavePath(forPath, name);
        if (method === 'GET') {
          // The autosave of a file, if there is one newer than the file itself.
          const saved = await info(file);
          const original = forPath ? await info(forPath) : null;
          sendJson(res, saved && (!original || saved.modified > original.modified) ? { autosave: file, ...saved } : null);
          return true;
        }
        if (method === 'PUT') {
          await mkdir(autosaveDir, { recursive: true });
          await writeWhole(file, await readBody(req));
          await writeWhole(file.replace(/\.mhproject$/i, '.json'), JSON.stringify({ for: forPath ? resolve(forPath) : null, name }));
          sendJson(res, { ok: true, autosave: file, ...(await info(file)) });
          return true;
        }
        if (method === 'DELETE') {
          await rm(file, { force: true });
          await rm(file.replace(/\.mhproject$/i, '.json'), { force: true });
          sendJson(res, { ok: true });
          return true;
        }
      }
      if (route[0] === 'autosaves' && method === 'GET') {
        sendJson(res, await autosaves());
        return true;
      }
      return false;
    },
  };
}

/** Write a file so that a crash part-way never leaves it half written. */
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
