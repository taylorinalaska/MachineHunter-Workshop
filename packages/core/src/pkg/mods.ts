/**
 * Mod packages as the tools see them: the manifest (`mod.json`) with the
 * options a mod declares, and `mods/settings.cfg`, the one text file that
 * says which mods are switched off and what their options are set to.
 *
 *     disabled = some-mod, another-mod
 *
 *     [free-camera]
 *     speed = 16
 *
 * The game reads and writes the same file (runtime/src/sdk/MHOptions.c), so
 * the rules here mirror that code: names compare without case, a value that
 * does not fit its option falls back to the default, and everything the
 * tools do not understand is kept as it was.
 */
import { MOD_FORMAT } from './mhproject.ts';

export type ModOptionType = 'toggle' | 'choice' | 'number' | 'key' | 'action';
export type ModOptionValue = boolean | number | string;

export interface ModOption {
  key: string;
  label: string;
  type: ModOptionType;
  /** The menu page it is listed under; the mod's name when not given. */
  section: string;
  help: string;
  /** A boolean for a toggle, one of `choices` for a choice, a number, or a key name. Unused for an action. */
  default: ModOptionValue;
  choices: string[];
  min: number;
  max: number;
  step: number;
  /** Takes effect the next time the game starts. */
  restart: boolean;
  /** False for a switch that only exists while the game runs: it is never written to the file. */
  saved: boolean;
  /** Left out of in-game menus; still configurable here. */
  hidden: boolean;
  /** Key options of the mod with the same group never share a key; empty for none. */
  unique: string;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  options: ModOption[];
}

export const MOD_ID_PATTERN = /^[A-Za-z0-9._-]{1,95}$/;
const OPTION_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const OPTION_TYPES: ModOptionType[] = ['toggle', 'choice', 'number', 'key', 'action'];
export const MAX_OPTION_CHOICES = 16;

/** Key names the game understands, besides single letters and digits, F1-F12 and NUMPAD0-9. */
export const KEY_NAMES = [
  'NONE', 'BACKSPACE', 'TAB', 'ENTER', 'SHIFT', 'CTRL', 'ALT', 'ESC', 'SPACE', 'PAGEUP', 'PAGEDOWN', 'END', 'HOME',
  'LEFT', 'UP', 'RIGHT', 'DOWN', 'INSERT', 'DELETE', 'NUMPAD_MULTIPLY', 'NUMPAD_PLUS', 'NUMPAD_MINUS', 'NUMPAD_DIVIDE',
  'SEMICOLON', 'PLUS', 'COMMA', 'MINUS', 'PERIOD', 'SLASH', 'TILDE', 'LBRACKET', 'BACKSLASH', 'RBRACKET', 'QUOTE',
] as const;

/** Whether the game understands a key name: every name it reads, aliases such as RETURN included. */
export function isKeyName(name: string): boolean {
  return keyCode(name) >= 0;
}

/** Virtual-key codes of the named keys, as the game has them (runtime/src/sdk/MHOptions.c). */
const KEY_CODES: Record<string, number> = {
  NONE: 0, OFF: 0, BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, RETURN: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12, ESC: 0x1b, ESCAPE: 0x1b,
  SPACE: 0x20, PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, INSERT: 0x2d, DELETE: 0x2e,
  NUMPAD_MULTIPLY: 0x6a, NUMPAD_PLUS: 0x6b, NUMPAD_MINUS: 0x6d, NUMPAD_DIVIDE: 0x6f, SEMICOLON: 0xba, PLUS: 0xbb, COMMA: 0xbc, LESS: 0xbc,
  MINUS: 0xbd, PERIOD: 0xbe, GREATER: 0xbe, SLASH: 0xbf, TILDE: 0xc0, LBRACKET: 0xdb, BACKSLASH: 0xdc, RBRACKET: 0xdd, QUOTE: 0xde,
};

/** The virtual-key code of a key name ("ENTER" and "RETURN" are both 13), or -1 when it is not one. */
export function keyCode(name: string): number {
  const upper = name.trim().toUpperCase();
  if (upper in KEY_CODES) return KEY_CODES[upper];
  if (/^[A-Z0-9]$/.test(upper)) return upper.charCodeAt(0);
  const punctuation: Record<string, number> = { '[': 0xdb, ']': 0xdd, '+': 0xbb, '-': 0xbd, ',': 0xbc, '.': 0xbe, '/': 0xbf };
  if (upper in punctuation) return punctuation[upper];
  let m = /^F([1-9]|1[0-2])$/.exec(upper);
  if (m) return 0x6f + Number(m[1]);
  m = /^NUMPAD([0-9])$/.exec(upper);
  if (m) return 0x60 + Number(m[1]);
  m = /^0X([0-9A-F]{2})$/.exec(upper);
  return m ? parseInt(m[1], 16) : -1;
}

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');
const whole = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback);
const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function checkOption(raw: unknown, modName: string, problems: string[]): ModOption | null {
  if (typeof raw !== 'object' || raw === null) {
    problems.push('An entry in "options" is not an object.');
    return null;
  }
  const o = raw as Record<string, unknown>;
  const key = text(o.key, 64);
  if (!OPTION_KEY_PATTERN.test(key)) {
    problems.push(`An option has no usable "key" (${JSON.stringify(o.key ?? null)}). Keys use letters, digits, ".", "_" and "-".`);
    return null;
  }
  const type = o.type as ModOptionType;
  if (!OPTION_TYPES.includes(type)) {
    problems.push(`Option "${key}" has an unknown type ${JSON.stringify(o.type ?? null)}. Use toggle, choice, number, key or action.`);
    return null;
  }
  const choices = Array.isArray(o.choices) ? o.choices.filter((c): c is string => typeof c === 'string').map((c) => c.slice(0, 24)) : [];
  if (type === 'choice' && (choices.length === 0 || choices.length > MAX_OPTION_CHOICES)) {
    problems.push(`Option "${key}" needs between 1 and ${MAX_OPTION_CHOICES} "choices".`);
    return null;
  }
  let min = whole(o.min, 0);
  let max = whole(o.max, 100);
  if (min > max) [min, max] = [max, min];
  const step = Math.max(1, whole(o.step, 1));

  let fallback: ModOptionValue = false;
  if (type === 'toggle') fallback = o.default === true || o.default === 1 || (typeof o.default === 'string' && ['on', 'true'].includes(o.default.toLowerCase()));
  else if (type === 'choice') {
    const named = typeof o.default === 'string' ? choices.find((c) => sameText(c, o.default as string)) : choices[whole(o.default, 0)];
    fallback = named ?? choices[0];
    if (o.default !== undefined && named === undefined) problems.push(`Option "${key}": the default ${JSON.stringify(o.default)} is not one of its choices.`);
  } else if (type === 'number') fallback = Math.max(min, Math.min(max, whole(o.default, min)));
  else if (type === 'key') {
    fallback = typeof o.default === 'string' && isKeyName(o.default) ? o.default.trim().toUpperCase() : 'NONE';
    if (typeof o.default === 'string' && !isKeyName(o.default)) problems.push(`Option "${key}": "${o.default}" is not a key name.`);
  }

  return {
    key,
    label: text(o.label, 40) || key,
    type,
    section: text(o.section, 24) || modName,
    help: text(o.help, 400),
    default: fallback,
    choices,
    min,
    max,
    step,
    restart: o.restart === true,
    saved: o.saved !== false,
    hidden: o.hidden === true,
    unique: type === 'key' ? text(o.unique, 24) : '',
  };
}

/**
 * Check a parsed `mod.json` the way the game does. `folder` is the name of
 * the folder it came from, which must equal the id. A manifest the game
 * would refuse gives `manifest: null`; an option it would skip is reported
 * in `problems` and left out.
 */
export function checkModManifest(json: unknown, folder?: string): { manifest: ModManifest | null; problems: string[] } {
  const problems: string[] = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { manifest: null, problems: ['mod.json is not a JSON object.'] };
  const m = json as Record<string, unknown>;
  if (m.format !== MOD_FORMAT) problems.push(`"format" must be "${MOD_FORMAT}".`);
  if (typeof m.id !== 'string' || !MOD_ID_PATTERN.test(m.id)) problems.push('"id" is missing or uses characters other than letters, digits, ".", "_" and "-".');
  else if (folder !== undefined && m.id !== folder) problems.push(`"id" is "${m.id}" but the folder is "${folder}"; they must be the same.`);
  if (typeof m.name !== 'string' || !m.name) problems.push('"name" is missing.');
  if (problems.length) return { manifest: null, problems };

  const name = (m.name as string).slice(0, 128);
  const options: ModOption[] = [];
  if (m.options !== undefined && !Array.isArray(m.options)) problems.push('"options" must be a list.');
  for (const raw of Array.isArray(m.options) ? m.options : []) {
    const option = checkOption(raw, name, problems);
    if (!option) continue;
    if (options.some((o) => o.key === option.key)) problems.push(`Option "${option.key}" is declared twice; the first one is used.`);
    else options.push(option);
  }
  return {
    manifest: { id: m.id as string, name, version: text(m.version, 64) || '0.1.0', author: text(m.author, 128), description: text(m.description, 1024), options },
    problems,
  };
}

/* ------------------------------------------------------------ settings.cfg */

const eolOf = (source: string): string => (source.includes('\n') && !source.includes('\r\n') ? '\n' : '\r\n');
const sectionOf = (line: string): string | null => /^\s*\[(.+)\]\s*$/.exec(line)?.[1] ?? null;

function keyOf(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return null;
  const at = trimmed.indexOf('=');
  if (at <= 0) return null;
  return { key: trimmed.slice(0, at).trim(), value: trimmed.slice(at + 1).trim() };
}

/** The lines of `[section]`, or of the part before any section when `section` is null: [first, end). */
function sectionRange(lines: string[], section: string | null): [number, number] | null {
  let start = section === null ? 0 : -1;
  for (let i = 0; i < lines.length; i++) {
    const name = sectionOf(lines[i]);
    if (name === null) continue;
    if (start >= 0) return [start, i];
    if (section !== null && sameText(name, section)) start = i + 1;
  }
  return start >= 0 ? [start, lines.length] : null;
}

/** The text stored for one key; `mod` null reads the lines before any section. */
export function readModSetting(source: string, mod: string | null, key: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const range = sectionRange(lines, mod);
  if (!range) return undefined;
  for (let i = range[0]; i < range[1]; i++) {
    const entry = keyOf(lines[i]);
    if (entry && sameText(entry.key, key)) return entry.value;
  }
  return undefined;
}

const HEADER = ["# Machine Hunter mod settings. The Workshop's Mods page edits this file;", '# the game updates it when an option is changed in the Mod Menu.'];

/** Set one key, or remove it with `value` undefined, leaving every other line as it was. */
export function writeModSetting(source: string, mod: string | null, key: string, value: string | undefined): string {
  const eol = eolOf(source);
  const lines = source.length ? source.split(/\r?\n/) : [];
  const range = sectionRange(lines, mod);
  const line = `${key} = ${value}`;
  if (range) {
    for (let i = range[0]; i < range[1]; i++) {
      const entry = keyOf(lines[i]);
      if (!entry || !sameText(entry.key, key)) continue;
      if (value === undefined) {
        lines.splice(i, 1);
        // A section with nothing left in it goes too, along with the blank lines around it.
        const rest = sectionRange(lines, mod)!;
        if (mod !== null && !lines.slice(rest[0], rest[1]).some((l) => l.trim())) {
          let from = rest[0] - 1;
          while (from > 0 && !lines[from - 1].trim()) from--;
          const after = lines.slice(rest[1]);
          lines.splice(from, lines.length - from, ...(after.length ? (from > 0 ? ['', ...after] : after) : ['']));
        }
      } else lines[i] = line;
      return lines.join(eol);
    }
    if (value === undefined) return source;
    // After the last line of the section that says something.
    let at = range[0];
    for (let i = range[0]; i < range[1]; i++) if (lines[i].trim()) at = i + 1;
    lines.splice(at, 0, line);
    return lines.join(eol);
  }
  if (value === undefined) return source;
  if (!lines.length) lines.push(...HEADER);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('', `[${mod}]`, line, '');
  return lines.join(eol);
}

/** Mods switched off: the `disabled` line at the top of the file. */
export function disabledMods(source: string): string[] {
  return (readModSetting(source, null, 'disabled') ?? '').split(/[\s,]+/).filter(Boolean);
}

export function setModDisabled(source: string, mod: string, disabled: boolean): string {
  const current = disabledMods(source).filter((id) => !sameText(id, mod));
  if (disabled) current.push(mod);
  if (!current.length) return writeModSetting(source, null, 'disabled', undefined);
  if (readModSetting(source, null, 'disabled') !== undefined) return writeModSetting(source, null, 'disabled', current.join(', '));
  // A new top-level line has to go above the first section to belong to none.
  const eol = eolOf(source);
  const lines = source.length ? source.split(/\r?\n/) : [...HEADER, ''];
  let at = lines.findIndex((l) => sectionOf(l) !== null);
  if (at < 0) at = lines.length;
  while (at > 0 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `disabled = ${current.join(', ')}`, ...(at < lines.length && lines[at]?.trim() ? [''] : []));
  return lines.join(eol);
}

/** Forget everything stored for a mod: its section and its place in the disabled list. */
export function forgetMod(source: string, mod: string): string {
  const eol = eolOf(source);
  const lines = setModDisabled(source, mod, false).split(/\r?\n/);
  const range = sectionRange(lines, mod);
  if (range) lines.splice(range[0] - 1, range[1] - range[0] + 1);
  return lines.join(eol);
}

/** What an option is set to, given the text stored for it (if any). */
export function optionValue(option: ModOption, stored: string | undefined): ModOptionValue {
  if (stored === undefined || option.type === 'action' || !option.saved) return option.default;
  const value = stored.trim();
  if (option.type === 'toggle') {
    if (['on', '1', 'true', 'yes'].includes(value.toLowerCase())) return true;
    if (['off', '0', 'false', 'no'].includes(value.toLowerCase())) return false;
    return option.default;
  }
  if (option.type === 'choice') return option.choices.find((c) => sameText(c, value)) ?? option.default;
  if (option.type === 'key') return isKeyName(value) ? value.toUpperCase() : option.default;
  return /^[-+]?\d+$/.test(value) ? Math.max(option.min, Math.min(option.max, Number(value))) : option.default;
}

/** The text to store for a value. */
export function optionText(option: ModOption, value: ModOptionValue): string {
  if (option.type === 'toggle') return value ? 'on' : 'off';
  if (option.type === 'number') return String(Math.max(option.min, Math.min(option.max, Math.trunc(Number(value)))));
  return String(value);
}

/* ------------------------------------------------------------ unique groups
 *
 * Key options with the same "unique" group never share a key. These are the
 * game's two rules (runtime/src/sdk/MHOptions.c), so the Mods page shows and
 * writes what the game will use.
 */

const sameGroup = (a: ModOption, b: ModOption) => a !== b && a.type === 'key' && b.type === 'key' && a.unique !== '' && sameText(a.unique, b.unique);

/**
 * What every stored option of `manifest` is set to. A file giving two options
 * of a group one key (written by hand) leaves it on the first declared; the
 * later ones have no key, as the game does when it loads the file.
 */
export function modOptionValues(source: string, manifest: ModManifest): Map<string, ModOptionValue> {
  const values = new Map<string, ModOptionValue>();
  manifest.options.forEach((option, i) => {
    let value = optionValue(option, readModSetting(source, manifest.id, option.key));
    const code = option.type === 'key' ? keyCode(String(value)) : 0;
    if (code > 0 && manifest.options.slice(0, i).some((earlier) => sameGroup(earlier, option) && keyCode(String(values.get(earlier.key))) === code)) value = 'NONE';
    values.set(option.key, value);
  });
  return values;
}

/**
 * Set one option, as the game does: a key another option of its group has
 * moves, and that option is left with no key. A value equal to the default
 * is stored as no line at all.
 */
export function setModOption(source: string, manifest: ModManifest, key: string, value: ModOptionValue): string {
  const option = manifest.options.find((o) => o.key === key);
  if (!option) return source;
  const store = (text: string, o: ModOption, v: ModOptionValue) => writeModSetting(text, manifest.id, o.key, v === o.default ? undefined : optionText(o, v));
  const before = modOptionValues(source, manifest);
  let out = source;
  // Fix the file's own duplicates first, so what it says is what the game uses.
  for (const o of manifest.options) if (o.type === 'key' && o.unique && before.get(o.key) === 'NONE' && optionValue(o, readModSetting(source, manifest.id, o.key)) !== 'NONE') out = store(out, o, 'NONE');
  const code = option.type === 'key' ? keyCode(String(value)) : 0;
  if (code > 0)
    for (const other of manifest.options)
      if (sameGroup(other, option) && keyCode(String(before.get(other.key))) === code) out = store(out, other, 'NONE');
  return store(out, option, value);
}
