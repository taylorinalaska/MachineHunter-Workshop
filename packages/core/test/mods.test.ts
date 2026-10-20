/** Mod manifests and mods/settings.cfg, as the Workshop reads and writes them. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModManifest, disabledMods, forgetMod, isKeyName, optionText, optionValue, readModSetting, setModDisabled, writeModSetting, keyCode, modOptionValues, setModOption } from '../src/index.ts';

const modsFolder = join(import.meta.dirname, '..', '..', '..', 'mods');

describe('mod manifests', () => {
  it('accepts every mod that ships with the Workshop, with nothing to report', () => {
    const folders = readdirSync(modsFolder, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(folders.length).toBeGreaterThanOrEqual(5);
    for (const folder of folders) {
      const json = JSON.parse(readFileSync(join(modsFolder, folder.name, 'mod.json'), 'utf8'));
      const { manifest, problems } = checkModManifest(json, folder.name);
      expect(problems, folder.name).toEqual([]);
      expect(manifest?.id).toBe(folder.name);
      // A label has to fit a row of the in-game menu beside its value.
      for (const option of manifest!.options) expect(option.label.length, `${folder.name}.${option.key}`).toBeLessThanOrEqual(26);
    }
  });

  it('refuses what the game refuses and skips what it skips', () => {
    expect(checkModManifest({ format: 'mhmod-1', id: 'a', name: 'A' }, 'b').manifest).toBeNull();
    expect(checkModManifest({ format: 'other', id: 'a', name: 'A' }, 'a').manifest).toBeNull();
    expect(checkModManifest({ format: 'mhmod-1', id: 'bad id', name: 'A' }).manifest).toBeNull();

    const { manifest, problems } = checkModManifest({
      format: 'mhmod-1',
      id: 'demo',
      name: 'Demo',
      homepage: 'kept by nobody, refused by nobody',
      options: [
        { key: 'speed', type: 'choice', choices: ['Slow', 'Fast'], default: 'fast' },
        { key: 'count', type: 'number', min: 10, max: 2, default: 99 },
        { key: 'go', type: 'action', label: 'Go' },
        { key: 'open', type: 'key', default: 'f3' },
        { key: 'no type' },
        { key: 'speed', type: 'toggle' },
        { key: 'empty', type: 'choice', choices: [] },
      ],
    });
    expect(manifest!.options.map((o) => o.key)).toEqual(['speed', 'count', 'go', 'open']);
    expect(manifest!.options[0]).toMatchObject({ default: 'Fast', section: 'Demo', label: 'speed', saved: true });
    expect(manifest!.options[1]).toMatchObject({ min: 2, max: 10, default: 10 });
    expect(manifest!.options[3].default).toBe('F3');
    expect(problems.length).toBe(3);
  });

  it('knows the key names the game knows', () => {
    for (const name of ['F3', 'f12', 'UP', 'A', '7', 'NUMPAD5', 'none', '0x72', 'LBRACKET']) expect(isKeyName(name), name).toBe(true);
    for (const name of ['F13', 'WINDOWS', '', 'AB']) expect(isKeyName(name), name).toBe(false);
  });
});

describe('mods/settings.cfg', () => {
  const EOL = String.fromCharCode(13, 10);
  const file = ['# my notes', 'disabled = old-mod, Other', '', '[free-camera]', 'speed = 16', '; keep me', 'zoom=Close', '', '[hd-rendering]', 'resolution = 400x300', ''].join('\r\n');

  it('reads values without caring about case or spacing', () => {
    expect(disabledMods(file)).toEqual(['old-mod', 'Other']);
    expect(readModSetting(file, 'Free-Camera', 'ZOOM')).toBe('Close');
    expect(readModSetting(file, 'hd-rendering', 'speed')).toBeUndefined();
    expect(readModSetting(file, 'missing', 'speed')).toBeUndefined();
  });

  it('changes one value and leaves the rest of the file alone', () => {
    const changed = writeModSetting(file, 'free-camera', 'zoom', 'Far');
    expect(changed).toBe(file.replace('zoom=Close', 'zoom = Far'));
    // A new key goes at the end of its section, a new section at the end of the file.
    expect(writeModSetting(file, 'free-camera', 'up', 'W')).toBe(file.replace('zoom=Close\r\n', 'zoom=Close\r\nup = W\r\n'));
    const added = writeModSetting(file, 'mod-menu', 'dim', '60');
    expect(added.endsWith('\r\n\r\n[mod-menu]\r\ndim = 60\r\n')).toBe(true);
    expect(added.startsWith(file.trimEnd())).toBe(true);
    // Removing the last value of a section removes the section too, unless it holds a note.
    expect(writeModSetting(file, 'hd-rendering', 'resolution', undefined)).toBe(file.slice(0, file.indexOf('zoom=Close') + 10) + EOL);
    const noted = writeModSetting(writeModSetting(file, 'free-camera', 'speed', undefined), 'free-camera', 'zoom', undefined);
    expect(noted).toContain(['[free-camera]', '; keep me'].join(EOL));
    const three = ['[a]', 'x = 1', '', '[b]', 'y = 2', '', '[c]', 'z = 3', ''].join(EOL);
    expect(writeModSetting(three, 'b', 'y', undefined)).toBe(['[a]', 'x = 1', '', '[c]', 'z = 3', ''].join(EOL));
    expect(writeModSetting(three, 'a', 'x', undefined)).toBe(['[b]', 'y = 2', '', '[c]', 'z = 3', ''].join(EOL));
  });

  it('starts a file from nothing', () => {
    const made = writeModSetting('', 'free-camera', 'speed', '8');
    expect(made.startsWith('# Machine Hunter mod settings')).toBe(true);
    expect(readModSetting(made, 'free-camera', 'speed')).toBe('8');
    const off = setModDisabled('', 'dev-tools', true);
    expect(disabledMods(off)).toEqual(['dev-tools']);
    expect(readModSetting(writeModSetting(off, 'dev-tools', 'hud', 'on'), 'dev-tools', 'hud')).toBe('on');
  });

  it('switches mods off and on', () => {
    expect(disabledMods(setModDisabled(file, 'free-camera', true))).toEqual(['old-mod', 'Other', 'free-camera']);
    expect(disabledMods(setModDisabled(file, 'OTHER', false))).toEqual(['old-mod']);
    expect(setModDisabled(setModDisabled(file, 'old-mod', false), 'other', false)).not.toContain('disabled');
    // The line has to sit above the first section to belong to none.
    const sectionsOnly = '[a]\nk = v\n';
    const off = setModDisabled(sectionsOnly, 'a', true);
    expect(off.startsWith('disabled = a\n\n[a]\n')).toBe(true);
    expect(readModSetting(off, 'a', 'k')).toBe('v');
    expect(readModSetting(off, 'a', 'disabled')).toBeUndefined();
  });

  it('forgets a removed mod', () => {
    const forgotten = forgetMod(setModDisabled(file, 'free-camera', true), 'free-camera');
    expect(forgotten).not.toContain('free-camera');
    expect(forgotten).not.toContain('keep me');
    expect(readModSetting(forgotten, 'hd-rendering', 'resolution')).toBe('400x300');
    expect(disabledMods(forgotten)).toEqual(['old-mod', 'Other']);
  });

  it('turns stored text into option values and back', () => {
    const { manifest } = checkModManifest({
      format: 'mhmod-1',
      id: 'demo',
      name: 'Demo',
      options: [
        { key: 'on', type: 'toggle', default: true },
        { key: 'size', type: 'choice', choices: ['Small', 'Large'], default: 'Small' },
        { key: 'count', type: 'number', min: 1, max: 9, default: 4 },
        { key: 'open', type: 'key', default: 'F3' },
        { key: 'live', type: 'toggle', default: false, saved: false },
      ],
    });
    const [on, size, count, open, live] = manifest!.options;
    expect(optionValue(on, 'off')).toBe(false);
    expect(optionValue(on, 'nonsense')).toBe(true);
    expect(optionValue(size, 'large')).toBe('Large');
    expect(optionValue(size, 'Huge')).toBe('Small');
    expect(optionValue(count, '40')).toBe(9);
    expect(optionValue(count, undefined)).toBe(4);
    expect(optionValue(open, 'up')).toBe('UP');
    // A switch that is not saved always starts from its default.
    expect(optionValue(live, 'on')).toBe(false);
    expect(optionText(on, false)).toBe('off');
    expect(optionText(count, 12)).toBe('9');
    expect(optionText(size, 'Large')).toBe('Large');
  });
});

describe('options in a "unique" group', () => {
  const manifest = checkModManifest({
    format: 'mhmod-1',
    id: 'keys',
    name: 'Keys',
    options: [
      { key: 'forward', type: 'key', unique: 'controls', default: 'UP' },
      { key: 'fire', type: 'key', unique: 'controls', default: 'CTRL' },
      { key: 'pause', type: 'key', unique: 'controls', default: 'ENTER' },
      { key: 'other', type: 'key', default: 'UP' },
    ],
  }).manifest!;

  it('compare keys by code, not by name', () => {
    expect(keyCode('ENTER')).toBe(keyCode('return'));
    expect(keyCode('0x0D')).toBe(13);
    expect(keyCode('NUMPAD8')).toBe(0x68);
    expect(keyCode('F3')).toBe(0x72);
    expect(keyCode('[')).toBe(0xdb);
    expect(keyCode('BOGUS')).toBe(-1);
  });

  it('move a key chosen for a second option: the first is left with none', () => {
    const text = setModOption('', manifest, 'fire', 'UP');
    const values = modOptionValues(text, manifest);
    expect(values.get('fire')).toBe('UP');
    expect(values.get('forward')).toBe('NONE');
    // Options outside the group are not touched.
    expect(values.get('other')).toBe('UP');
    // The same key under another name counts too.
    const again = modOptionValues(setModOption(text, manifest, 'forward', 'RETURN'), manifest);
    expect(again.get('forward')).toBe('RETURN');
    expect(again.get('pause')).toBe('NONE');
  });

  it('settle a file that gives two of them one key on the first declared', () => {
    const text = '[keys]\npause = CTRL\n';
    const values = modOptionValues(text, manifest);
    expect(values.get('fire')).toBe('CTRL');
    expect(values.get('pause')).toBe('NONE');
    // A later change writes the settlement down, as the game does when it loads the file.
    const written = setModOption(text, manifest, 'forward', 'W');
    expect(readModSetting(written, 'keys', 'pause')).toBe('NONE');
  });
});
