/**
 * Mods screen: the mods in the game's mods folder as a list. Selecting one
 * shows what it is and lets you configure it; each can be switched off
 * without removing it, and mods can be added from a .zip or a folder.
 *
 * Nothing here is special-cased: the options shown for a mod are the ones it
 * declares in its mod.json, and they are stored in game/mods/settings.cfg,
 * the file the game itself reads.
 */
import { type ModManifest, type ModOption, type ModOptionValue, checkModManifest, disabledMods, forgetMod, modOptionValues, readModSetting, setModDisabled, setModOption, writeModSetting } from '@mh/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { launchGame } from '../actions.ts';
import { type InstalledMod, api } from '../game/api.ts';
import { type ModPackage, readFolder, readModPackage, readZip } from '../game/modfiles.ts';
import { useApp } from '../state/app.ts';
import { Dialog, NumberInput, formatBytes } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

interface ModEntry extends InstalledMod {
  info: ModManifest | null;
  problems: string[];
  enabled: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a mod is made of, in a few words. */
function contents(mod: { hasNative: boolean; hasScript: boolean; maps: number; archive: number; audio: number }): string[] {
  const out: string[] = [];
  if (mod.hasNative) out.push('native code');
  if (mod.hasScript) out.push('Lua script');
  if (mod.maps) out.push(plural(mod.maps, 'map'));
  if (mod.archive) out.push(`replaces ${plural(mod.archive, 'game file')}`);
  if (mod.audio) out.push(plural(mod.audio, 'sound'));
  return out;
}

/** The game's name for a key the browser reports, or null when the game has none for it. */
function keyNameOf(event: KeyboardEvent): string | null {
  const code = event.code;
  const named: Record<string, string> = {
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Space: 'SPACE', Enter: 'ENTER', NumpadEnter: 'ENTER', Tab: 'TAB',
    Backspace: 'BACKSPACE', Insert: 'INSERT', Home: 'HOME', End: 'END', PageUp: 'PAGEUP', PageDown: 'PAGEDOWN',
    ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL', AltLeft: 'ALT', AltRight: 'ALT',
    Minus: 'MINUS', Equal: 'PLUS', BracketLeft: 'LBRACKET', BracketRight: 'RBRACKET', Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH',
    Semicolon: 'SEMICOLON', Quote: 'QUOTE', Backslash: 'BACKSLASH', Backquote: 'TILDE',
    NumpadAdd: 'NUMPAD_PLUS', NumpadSubtract: 'NUMPAD_MINUS', NumpadMultiply: 'NUMPAD_MULTIPLY', NumpadDivide: 'NUMPAD_DIVIDE',
  };
  if (named[code]) return named[code];
  let match = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  if (match) return match[1];
  match = /^F([1-9]|1[0-2])$/.exec(code);
  if (match) return `F${match[1]}`;
  match = /^Numpad([0-9])$/.exec(code);
  if (match) return `NUMPAD${match[1]}`;
  return null;
}

/** A button that shows a key and, once clicked, takes the next key pressed. */
function KeyPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        const name = e.code === 'Delete' ? 'NONE' : keyNameOf(e);
        if (!name) return;
        onChange(name);
      }
      setListening(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, onChange]);
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className={listening ? 'active' : ''} style={{ minWidth: 96 }} onClick={() => setListening(!listening)} onBlur={() => setListening(false)} title="Click, then press the key to use. Esc cancels.">
        {listening ? 'Press a key…' : value === 'NONE' ? 'No key' : <span className="kbd">{value}</span>}
      </button>
      {value !== 'NONE' && !listening && (
        <button className="small icon ghost" title="Use no key" onClick={() => onChange('NONE')}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

function OptionRow({ option, value, onChange }: { option: ModOption; value: ModOptionValue; onChange: (value: ModOptionValue) => void }) {
  const changed = value !== option.default;
  return (
    <div className="mod-option">
      <div className="label">
        <span>{option.label}</span>
        {option.restart && (
          <span className="pill" title="Takes effect the next time the game starts">
            next launch
          </span>
        )}
        {changed && (
          <button className="small ghost" title={`Back to the default (${option.type === 'toggle' ? (option.default ? 'on' : 'off') : option.default})`} onClick={() => onChange(option.default)}>
            reset
          </button>
        )}
        {option.help && <small>{option.help}</small>}
      </div>
      <div className="control">
        {option.type === 'toggle' && (
          <label className="switch">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <i />
          </label>
        )}
        {option.type === 'choice' && (
          <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {option.choices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        {option.type === 'number' && <NumberInput value={Number(value)} min={option.min} max={option.max} step={option.step} onChange={onChange} />}
        {option.type === 'key' && <KeyPicker value={String(value)} onChange={onChange} />}
      </div>
    </div>
  );
}

function ModDetails({ mod, settings, luaMissing, onEdit, onRemove, onRemoveMap }: { mod: ModEntry; settings: string; luaMissing: boolean; onEdit: (edit: (text: string) => string) => void; onRemove: () => void; onRemoveMap: (file: string) => void }) {
  const info = mod.info;
  // Options that live in the file. Actions and switches that reset every launch exist only while the game runs.
  const stored = info?.options.filter((o) => o.type !== 'action' && o.saved) ?? [];
  const live = info?.options.filter((o) => o.type === 'action' || !o.saved) ?? [];
  const sections = [...new Set(stored.map((o) => o.section))];
  const made = contents({ hasNative: mod.hasNative, hasScript: mod.hasScript, maps: mod.maps.length, archive: mod.archive.length, audio: mod.audio.length });
  const anyChanged = stored.some((o) => readModSetting(settings, mod.id, o.key) !== undefined);
  // What the game will use: options that share a key in a "unique" group are settled as it settles them.
  const values = info ? modOptionValues(settings, info) : new Map();

  return (
    <div className="mod-details">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h2>{info?.name ?? mod.id}</h2>
          <p className="dim">
            {info ? `Version ${info.version}` : 'Not a usable mod'}
            {info?.author ? ` · by ${info.author}` : ''} · <code>game/mods/{mod.id}</code>
          </p>
        </div>
        <button className="ghost danger" onClick={onRemove} title="Delete this mod's folder from the game">
          <Icon name="trash" /> Remove
        </button>
      </div>

      {info?.description && <p style={{ margin: '10px 0', maxWidth: '70ch' }}>{info.description}</p>}
      {made.length > 0 && (
        <div className="row wrap" style={{ margin: '8px 0' }}>
          {made.map((m) => (
            <span className="pill" key={m}>
              {m}
            </span>
          ))}
        </div>
      )}

      {!info && (
        <div className="card" style={{ borderColor: 'var(--red)', margin: '12px 0' }}>
          <b>The game ignores this folder.</b>
          <p className="dim">{mod.manifestError ?? mod.problems.join(' ')}</p>
        </div>
      )}
      {info && mod.problems.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--yellow)', margin: '12px 0' }}>
          <b>Parts of its mod.json are skipped.</b>
          {mod.problems.map((p) => (
            <p className="dim" key={p}>
              {p}
            </p>
          ))}
        </div>
      )}
      {mod.hasNative && (
        <p className="hint" style={{ margin: '8px 0' }}>
          Native code runs inside the game with full access to your PC. Only keep mods like this from people you trust.
        </p>
      )}
      {mod.hasScript && luaMissing && (
        <div className="card" style={{ borderColor: 'var(--yellow)', margin: '12px 0' }}>
          <b>Its script will not run.</b>
          <p className="dim">
            Lua mods need the 32-bit Lua 5.4 library as <code>game/lua54.dll</code>, which is missing.
          </p>
        </div>
      )}

      {info && (
        <>
          <div className="row" style={{ margin: '18px 0 6px' }}>
            <h3 className="grow">Settings</h3>
            {anyChanged && (
              <button className="small ghost" onClick={() => onEdit((text) => stored.reduce((t, o) => writeModSetting(t, mod.id, o.key, undefined), text))}>
                Reset all to defaults
              </button>
            )}
          </div>
          {stored.length === 0 && <p className="dim">This mod has nothing to set up.</p>}
          {sections.map((section) => (
            <div key={section} className="mod-section">
              {(sections.length > 1 || section !== info.name) && <h4>{section}</h4>}
              {stored
                .filter((o) => o.section === section)
                .map((o) => (
                  <OptionRow key={o.key} option={o} value={values.get(o.key) ?? o.default} onChange={(value) => onEdit((text) => setModOption(text, info, o.key, value))} />
                ))}
            </div>
          ))}
          {live.length > 0 && (
            <p className="hint" style={{ marginTop: 10 }}>
              Used while playing, from the Mod Menu: {live.map((o) => o.label).join(', ')}.
            </p>
          )}
        </>
      )}

      {mod.maps.length > 0 && (
        <>
          <h3 style={{ margin: '18px 0 6px' }}>Maps</h3>
          {mod.maps.map((map) => (
            <div className="row" key={map.file} style={{ padding: '3px 0' }}>
              <Icon name="build" size={14} />
              <span className="grow">{map.file.replace(/\.mhproject$/i, '')}</span>
              <span className="faint">{formatBytes(map.size)}</span>
              <button className="small icon ghost danger" title="Remove this map from the game" onClick={() => onRemoveMap(map.file)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </>
      )}
      {(mod.archive.length > 0 || mod.audio.length > 0) && (
        <>
          <h3 style={{ margin: '18px 0 6px' }}>Files</h3>
          {mod.archive.length > 0 && <p className="dim">Replaces: {mod.archive.join(', ')}</p>}
          {mod.audio.length > 0 && <p className="dim">Sounds: {mod.audio.join(', ')}</p>}
        </>
      )}
    </div>
  );
}

/** Pick a .zip or a folder, see what is in it, then install it. */
function AddMod({ installed, onClose, onInstalled }: { installed: ModEntry[]; onClose: () => void; onInstalled: (id: string) => void }) {
  const toast = useApp((s) => s.toast);
  const [pack, setPack] = useState<ModPackage | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const open = async (read: () => Promise<Map<string, Uint8Array>>) => {
    setError('');
    setPack(null);
    try {
      setPack(readModPackage(await read()));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const install = async () => {
    if (!pack) return;
    const id = pack.manifest.id;
    try {
      let done = 0;
      // A newer version may have dropped its code; do not leave the old one behind.
      const previous = installed.find((m) => m.id === id);
      if (previous?.hasNative && !pack.hasNative) await api.deleteModFile(id, 'mod.dll');
      if (previous?.hasScript && !pack.hasScript) await api.deleteModFile(id, 'main.lua');
      // Nor game files the old version replaced and the new one no longer does.
      for (const [folder, names] of [['assets/archive', previous?.archive ?? []], ['assets/audio', previous?.audio ?? []]] as const) {
        for (const name of names) if (!pack.files.has(`${folder}/${name}`)) await api.deleteModFile(id, `${folder}/${name}`);
      }
      for (const [path, data] of pack.files) {
        setProgress(`Copying ${++done} of ${pack.files.size}…`);
        await api.writeModFile(id, path, data);
      }
      toast(`Installed ${pack.manifest.name}.`, 'success');
      onInstalled(id);
    } catch (e) {
      setProgress(null);
      setError(`The mod could not be installed: ${(e as Error).message}`);
    }
  };

  const replaces = pack && installed.find((m) => m.id === pack.manifest.id);
  const made = pack ? contents({ hasNative: pack.hasNative, hasScript: pack.hasScript, maps: pack.maps, archive: pack.archive, audio: pack.audio }) : [];
  return (
    <Dialog
      title="Add a mod"
      width={560}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!pack || progress !== null} onClick={() => void install()}>
            {progress ?? (replaces ? 'Replace the installed copy' : 'Install')}
          </button>
        </>
      }
    >
      <p className="dim">
        A mod is a folder with a <code>mod.json</code> in it, usually shared as a .zip. Installing copies it into <code>game/mods</code>.
      </p>
      <div className="row" style={{ margin: '14px 0' }}>
        <button onClick={() => zipInput.current?.click()}>
          <Icon name="import" /> Choose a .zip…
        </button>
        <button onClick={() => folderInput.current?.click()}>
          <Icon name="folder" /> Choose a folder…
        </button>
        <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => e.target.files?.[0] && void open(async () => readZip(new Uint8Array(await e.target.files![0].arrayBuffer())))} />
        <input ref={folderInput} type="file" hidden onChange={(e) => e.target.files?.length && void open(() => readFolder(e.target.files!))} {...({ webkitdirectory: '' } as object)} />
      </div>
      {error && (
        <p className="card" style={{ borderColor: 'var(--red)' }}>
          {error}
        </p>
      )}
      {pack && (
        <div className="card">
          <div className="row">
            <b className="grow">{pack.manifest.name}</b>
            <span className="pill">{pack.manifest.version}</span>
          </div>
          <p className="dim" style={{ margin: '2px 0 8px' }}>
            <code>{pack.manifest.id}</code>
            {pack.manifest.author ? ` · by ${pack.manifest.author}` : ''} · {plural(pack.files.size, 'file')}, {formatBytes(pack.bytes)}
          </p>
          {pack.manifest.description && <p style={{ marginBottom: 8 }}>{pack.manifest.description}</p>}
          <div className="row wrap">
            {made.map((m) => (
              <span className="pill" key={m}>
                {m}
              </span>
            ))}
            {pack.manifest.options.length > 0 && <span className="pill">{plural(pack.manifest.options.length, 'option')}</span>}
          </div>
          {pack.problems.map((p) => (
            <p key={p} className="hint" style={{ marginTop: 8, color: 'var(--yellow)' }}>
              {p}
            </p>
          ))}
          {replaces && (
            <p className="hint" style={{ marginTop: 8 }}>
              {replaces.info?.name ?? replaces.id} {replaces.info?.version ?? ''} is already installed; its files will be overwritten. Your settings for it are kept.
            </p>
          )}
          {pack.hasNative && (
            <p className="hint" style={{ marginTop: 8, color: 'var(--yellow)' }}>
              This mod contains native code (mod.dll). It runs inside the game with full access to your PC, so install it only if you trust where it came from.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function Mods() {
  const status = useApp((s) => s.status);
  const toast = useApp((s) => s.toast);
  const [installed, setInstalled] = useState<InstalledMod[] | null>(null);
  const [settings, setSettings] = useState('');
  const [log, setLog] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [mods, text, lastLog] = await Promise.all([api.mods(), api.modSettings(), api.log()]);
      setInstalled(mods);
      setSettings(text);
      setLog(lastLog);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mods = useMemo<ModEntry[]>(() => {
    const off = disabledMods(settings).map((id) => id.toLowerCase());
    return (installed ?? [])
      .map((mod) => {
        const { manifest, problems } = mod.manifest === null ? { manifest: null, problems: [] } : checkModManifest(mod.manifest, mod.id);
        return { ...mod, info: manifest, problems, enabled: !off.includes(mod.id.toLowerCase()) };
      })
      .sort((a, b) => (a.info?.name ?? a.id).localeCompare(b.info?.name ?? b.id));
  }, [installed, settings]);

  const current = mods.find((m) => m.id === selected) ?? mods[0] ?? null;

  /**
   * Change the settings file. The game rewrites it when an option is changed
   * in the Mod Menu, so each edit is applied to the file as it is on disk
   * now, never to the copy this page loaded, and edits run one at a time.
   */
  const writes = useRef(Promise.resolve());
  const editSettings = (edit: (text: string) => string): Promise<void> => {
    writes.current = writes.current.then(async () => {
      try {
        const next = edit(await api.modSettings());
        setSettings(next);
        await api.saveModSettings(next);
      } catch (error) {
        toast(`The settings could not be saved: ${(error as Error).message}`, 'error');
        await refresh();
      }
    });
    return writes.current;
  };

  const remove = async (mod: ModEntry) => {
    const name = mod.info?.name ?? mod.id;
    const maps = mod.maps.length ? `, including the ${plural(mod.maps.length, 'map')} installed in it` : '';
    if (!window.confirm(`Remove ${name}?\n\nThis deletes the folder game/mods/${mod.id}${maps}. To keep it but stop it loading, switch it off instead.`)) return;
    try {
      await api.removeMod(mod.id);
      await editSettings((text) => forgetMod(text, mod.id));
      toast(`Removed ${name}.`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
    setSelected(null);
    await refresh();
  };

  const removeMap = async (mod: ModEntry, file: string) => {
    if (!window.confirm(`Remove ${file} from the game?`)) return;
    await api.deleteModFile(mod.id, `maps/${file}`);
    await refresh();
  };

  const ready = status?.game.executable && status.game.runtime;
  const active = mods.filter((m) => m.enabled && m.info).length;
  return (
    <div className="page mods-page">
      <header>
        <div className="row">
          <h1>Mods</h1>
          <button className="right" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add a mod…
          </button>
          <button className="primary" disabled={!ready} onClick={() => void launchGame()}>
            <Icon name="play" /> Run the game
          </button>
          <button className="ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <p>
          Every folder in <code>game/mods</code> with a <code>mod.json</code> is a mod. None of them is required: switch any of them off and the rest carry on. Changes here are saved straight away and apply the next time the game starts.
        </p>
      </header>

      {!status?.game.runtime && (
        <div className="card" style={{ borderColor: 'var(--yellow)', marginBottom: 14 }}>
          <b>The mod loader has not been built.</b>
          <p className="dim">
            Run <code>npm run runtime:build</code> in the Workshop folder (needs Visual Studio's C++ tools). Until then the game starts without mods.
          </p>
        </div>
      )}

      <div className="mods-layout">
        <div className="card mods-list">
          <div className="list">
            {mods.map((mod) => (
              <div key={mod.id} className={`item ${current?.id === mod.id ? 'selected' : ''} ${mod.enabled && mod.info ? '' : 'off'}`} onClick={() => setSelected(mod.id)}>
                <label className="switch" title={mod.enabled ? 'On. Click to switch this mod off.' : 'Off. Click to switch this mod on.'} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={mod.enabled} disabled={!mod.info} onChange={(e) => {
                      const off = !e.target.checked;
                      void editSettings((text) => setModDisabled(text, mod.id, off));
                    }} />
                  <i />
                </label>
                <span className="grow name">{mod.info?.name ?? mod.id}</span>
                {!mod.info ? <span className="pill bad">broken</span> : mod.problems.length > 0 ? <span className="pill warn">check</span> : <span className="faint">{mod.info.version}</span>}
              </div>
            ))}
            {installed && mods.length === 0 && <div className="empty">No mods installed yet.</div>}
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            {plural(active, 'mod')} will load{mods.length > active ? `, ${mods.length - active} switched off` : ''}.
          </p>
        </div>
        <div className="card">{current ? <ModDetails mod={current} settings={settings} luaMissing={!status?.game.lua} onEdit={(edit) => void editSettings(edit)} onRemove={() => void remove(current)} onRemoveMap={(file) => void removeMap(current, file)} /> : <div className="empty">Select a mod to see what it does.</div>}</div>
      </div>

      <details className="card" style={{ marginTop: 14 }}>
        <summary>Log of the last run</summary>
        <pre className="mono scroll" style={{ margin: '10px 0 0', maxHeight: 280, whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>
          {log || 'No log yet. The game writes game/logs/mh-runtime.log each time it runs.'}
        </pre>
      </details>

      {adding && (
        <AddMod
          installed={mods}
          onClose={() => setAdding(false)}
          onInstalled={(id) => {
            setAdding(false);
            setSelected(id);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
