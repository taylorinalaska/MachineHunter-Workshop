/** Thin client for the Workshop's local file API (server/api.mjs). */

export interface GameStatus {
  root: string;
  game: { archive: boolean; executable: boolean; runtime: boolean; movies: boolean; lua: boolean };
  retailExecutable: boolean;
}

/** A map file in the recent list: anywhere on disk, picked in the Open or Save As dialog. */
export interface RecentFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  /** The file is no longer there. */
  missing?: boolean;
}

/** The autosave copy of a map: `for` is the file it belongs to, or null for a map never saved. */
export interface Autosave {
  autosave: string;
  for: string | null;
  name: string;
  size: number;
  modified: number;
}

/** Which autosave: the one of a file, or of a map not saved yet (by its name). */
export type AutosaveTarget = { for: string } | { name: string };
const target = (t: AutosaveTarget) => ('for' in t ? `for=${encode(t.for)}` : `name=${encode(t.name)}`);

/** A folder under game/mods as it is on disk. `manifest` is the parsed mod.json, not yet checked. */
export interface InstalledMod {
  id: string;
  manifest: unknown;
  manifestError: string | null;
  maps: { file: string; size: number }[];
  hasNative: boolean;
  hasScript: boolean;
  /** Game files the mod replaces (assets/archive) and its own sounds (assets/audio). */
  archive: string[];
  audio: string[];
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`/api/${path}`, { ...init, headers: { 'X-MH-Workshop': '1', ...(init.headers ?? {}) } });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return response;
}

const bytes = async (path: string) => new Uint8Array(await (await request(path)).arrayBuffer());
const json = async <T>(path: string, init?: RequestInit) => (await (await request(path, init)).json()) as T;
const encode = encodeURIComponent;

/** Poll while the native dialog is open, keeping each HTTP request short. */
async function pickFile(path: string): Promise<string | null> {
  const { dialog } = await json<{ dialog: string }>(path, { method: 'POST' });
  for (;;) {
    const result = await json<{ pending?: boolean; path?: string | null }>(`dialog/${encode(dialog)}`);
    if (!result.pending) return result.path ?? null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export const api = {
  status: () => json<GameStatus>('status'),
  archive: () => bytes('game/archive'),
  retailExe: () => bytes('game/retail-exe'),
  log: async () => (await json<{ text: string }>('game/log')).text,
  /** game/mods/settings.cfg: which mods are off and what their options are set to. */
  modSettings: async () => (await json<{ text: string }>('mod-settings')).text,
  saveModSettings: (text: string) => json('mod-settings', { method: 'PUT', body: text }),
  /** Start the game; with `map`, go straight into that installed map instead of the menus. */
  launch: (map?: { mod: string; file: string }) => json(map ? `game/launch?mod=${encode(map.mod)}&map=${encode(map.file)}` : 'game/launch', { method: 'POST' }),

  /** The Windows Open dialog; the picked path, or null when canceled. */
  pickOpen: async () => pickFile('dialog/open'),
  /** The Windows Save As dialog, starting at `path` (or in the last folder with `name`); null when canceled. */
  pickSave: async (start: { path?: string | null; name?: string }) =>
    pickFile(`dialog/save?${start.path ? `path=${encode(start.path)}` : `name=${encode(start.name ?? '')}`}`),
  /** A map file picked in one of the dialogs (or in the recent list). */
  readFile: (path: string) => bytes(`file?path=${encode(path)}`),
  writeFile: (path: string, data: Uint8Array) => json<{ size: number; modified: number }>(`file?path=${encode(path)}`, { method: 'PUT', body: data as BodyInit }),
  recent: () => json<RecentFile[]>('recent'),
  forgetRecent: (path: string) => json(`recent?path=${encode(path)}`, { method: 'DELETE' }),
  /** Open Explorer with the file selected. */
  reveal: (path: string) => json(`reveal?path=${encode(path)}`, { method: 'POST' }),
  /** The autosave of a file when it is newer than the file, else null. */
  autosaveOf: (path: string) => json<Autosave | null>(`autosave?for=${encode(path)}`),
  writeAutosave: (t: AutosaveTarget, data: Uint8Array) => json<{ modified: number }>(`autosave?${target(t)}`, { method: 'PUT', body: data as BodyInit }),
  deleteAutosave: (t: AutosaveTarget) => json(`autosave?${target(t)}`, { method: 'DELETE' }),
  autosaves: () => json<Autosave[]>('autosaves'),

  mods: () => json<InstalledMod[]>('mods'),
  /** Delete a mod's whole folder. */
  removeMod: (id: string) => json(`mods/${encode(id)}`, { method: 'DELETE' }),
  readModFile: (id: string, path: string) => bytes(`mods/${encode(id)}/file?path=${encode(path)}`),
  writeModFile: (id: string, path: string, data: Uint8Array | string) => json(`mods/${encode(id)}/file?path=${encode(path)}`, { method: 'PUT', body: data as BodyInit }),
  deleteModFile: (id: string, path: string) => json(`mods/${encode(id)}/file?path=${encode(path)}`, { method: 'DELETE' }),
};
