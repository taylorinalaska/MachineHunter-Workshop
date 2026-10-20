import { LEVEL_IDS, type LevelId, SINGLE_PLAYER_LEVEL_COUNT } from '@mh/core';
import { useEffect, useState } from 'react';
import { fileName, launchGame, newProject, openAutosave, openMapFile, openRetailLevel } from '../actions.ts';
import { type Autosave, type RecentFile, api } from '../game/api.ts';
import { LEVEL_TITLES, bestiary } from '../game/gamedata.ts';
import { useApp, useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { Dialog, Field, NumberInput, TileCanvas, formatBytes } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

/** Campaign order, for listing levels the way players know them. */
const CAMPAIGN_ORDER: LevelId[] = [...bestiary.campaign.map((c) => c.level as LevelId), 'BOSS3MAP'];

export function NewMapDialog({ onClose }: { onClose: () => void }) {
  const game = useGame();
  const [name, setName] = useState('My first map');
  const [baseLevel, setBaseLevel] = useState<LevelId>('MARS');
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const tiles = game.level(baseLevel).tiles;
  return (
    <Dialog
      title="New map"
      width={620}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!name.trim()}
            onClick={() => {
              newProject({ name, baseLevel, width, height });
              onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Name">
        <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Theme">
        <select value={baseLevel} onChange={(e) => setBaseLevel(e.target.value as LevelId)}>
          {CAMPAIGN_ORDER.map((id) => (
            <option key={id} value={id}>
              {LEVEL_TITLES[id] ?? id} ({id})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Size">
        <div className="row">
          <NumberInput value={width} min={4} max={128} onChange={setWidth} />
          <span className="dim">×</span>
          <NumberInput value={height} min={4} max={128} onChange={setHeight} />
          <span className="dim">cells</span>
        </div>
      </Field>
      <p className="hint" style={{ margin: '10px 0 8px' }}>
        Textures, enemies and music come from the theme.
      </p>
      <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(36px, 1fr))' }}>
        {tiles.slice(0, 48).map((tile, i) => (
          <div className="tile" key={i}>
            <TileCanvas game={game} level={baseLevel} tile={tile} />
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function OpenLevelDialog({ onClose }: { onClose: () => void }) {
  const game = useGame();
  const levels = [...CAMPAIGN_ORDER, ...LEVEL_IDS.slice(SINGLE_PLAYER_LEVEL_COUNT)];
  return (
    <Dialog title="Open a retail level" width={760} onClose={onClose}>
      <p className="hint" style={{ marginBottom: 12 }}>
        Opens a copy. The game files are never changed.
      </p>
      <div className="level-grid">
        {levels.map((id, i) => {
          const map = game.levelRecord(id);
          return (
            <button
              key={id}
              className="level-card"
              onClick={() => {
                openRetailLevel(id);
                onClose();
              }}
            >
              <b>{i < 16 ? `${i + 1}. ` : ''}{LEVEL_TITLES[id] ?? id}</b>
              <small>
                {id} · {map.sprites.length} sprite sets
              </small>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

export function Home() {
  const status = useApp((s) => s.status);
  const go = useApp((s) => s.go);
  const project = useEditor((s) => s.project);
  const [dialog, setDialog] = useState<'new' | 'open' | null>(null);
  const [recent, setRecent] = useState<RecentFile[] | null>(null);
  const [autosaves, setAutosaves] = useState<Autosave[]>([]);
  const toast = useApp((s) => s.toast);
  const refresh = () => {
    void api.recent().then(setRecent, () => setRecent([]));
    void api.autosaves().then(setAutosaves, () => setAutosaves([]));
  };
  useEffect(refresh, []);

  const forget = async (path: string) => {
    try {
      await api.forgetRecent(path);
    } catch (error) {
      toast(`Could not change the list: ${(error as Error).message}`, 'error');
    }
    refresh();
  };
  const discard = async (a: Autosave) => {
    if (!window.confirm(`Delete the autosave of ${a.for ? fileName(a.for) : `"${a.name}"`}? This cannot be undone.`)) return;
    try {
      await api.deleteAutosave(a.for ? { for: a.for } : { name: a.name });
    } catch (error) {
      toast(`Could not delete the autosave: ${(error as Error).message}`, 'error');
    }
    refresh();
  };
  // Autosaves worth offering: of maps never saved, or newer than their file.
  const recoverable = autosaves.filter((a) => !a.for || !recent?.some((r) => r.path.toLowerCase() === a.for!.toLowerCase() && !r.missing && r.modified >= a.modified));

  const ready = status?.game.executable && status.game.runtime && status.game.movies;
  return (
    <div className="page">
      <header>
        <h1>Machine Hunter Workshop</h1>
        <p>Build maps, study the game's creatures and machines, and package mods for the 1997 PC release of Machine Hunter.</p>
      </header>

      <div className="hero">
        <div className="card start">
          <h2>Start building</h2>
          <p>Make a map and play it in the game.</p>
          <div className="row wrap">
            <button className="primary" onClick={() => setDialog('new')}>
              <Icon name="plus" /> New map
            </button>
            <button onClick={() => void openMapFile()}>
              <Icon name="folder" /> Open a map file…
            </button>
            <button onClick={() => setDialog('open')}>
              <Icon name="layers" /> Open a retail level
            </button>
            {project && (
              <button onClick={() => go('build')}>
                <Icon name="build" /> Continue "{project.name}"
              </button>
            )}
          </div>
        </div>
        <div className="card">
          <h3>Your game</h3>
          <div className="field">
            <span>Game data</span>
            <span className={status?.game.archive ? 'pill ok' : 'pill bad'}>{status?.game.archive ? 'DATA.ARC found' : 'missing'}</span>
          </div>
          <div className="field">
            <span>Executable</span>
            <span className={status?.game.executable ? 'pill ok' : 'pill bad'}>{status?.game.executable ? 'patched MACHHUNT.EXE' : 'missing'}</span>
          </div>
          <div className="field">
            <span>Mod runtime</span>
            <span className={status?.game.runtime ? 'pill ok' : 'pill warn'}>{status?.game.runtime ? 'MHRuntime.dll' : 'not built'}</span>
          </div>
          <div className="field">
            <span>Title movies</span>
            <span className={status?.game.movies ? 'pill ok' : 'pill bad'}>{status?.game.movies ? 'found' : 'missing'}</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={!ready} onClick={() => void launchGame()}>
              <Icon name="play" /> Run the game
            </button>
            <button className="ghost" onClick={() => go('mods')}>
              Manage mods
            </button>
          </div>
        </div>
      </div>

      {recoverable.length > 0 && (
        <div className="card">
          <h3>Autosaves</h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            Unsaved changes, kept for you.
          </p>
          <div className="list">
            {recoverable.map((a) => (
              <div key={a.autosave} className="item" onClick={() => void openAutosave(a)} title={a.autosave}>
                <Icon name="undo" />
                <span className="grow">
                  {a.for ? fileName(a.for).replace(/\.mhproject$/i, '') : a.name}
                  <br />
                  <small className="faint">{a.for ?? 'never saved to a file'}</small>
                </span>
                <span className="faint">{new Date(a.modified).toLocaleString()}</span>
                <button
                  className="small icon ghost"
                  title="Delete this autosave"
                  onClick={(e) => {
                    e.stopPropagation();
                    void discard(a);
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>Recent maps</h3>
        {recent === null && <div className="empty">Loading…</div>}
        {recent?.length === 0 && <div className="empty">Maps you open or save appear here. Use Open a map file… to pick one anywhere on your computer.</div>}
        <div className="list">
          {recent?.map((r) => (
            <div key={r.path} className={`item ${r.missing ? 'disabled' : ''}`} onClick={() => !r.missing && void openMapFile(r.path)} title={r.path}>
              <Icon name="build" />
              <span className="grow">
                {r.name.replace(/\.mhproject$/i, '')}
                <br />
                <small className="faint">{r.missing ? `Missing: ${r.path}` : r.path}</small>
              </span>
              {!r.missing && <span className="faint">{formatBytes(r.size)}</span>}
              {!r.missing && <span className="faint">{new Date(r.modified).toLocaleString()}</span>}
              {!r.missing && (
                <button
                  className="small icon ghost"
                  title="Show in folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.reveal(r.path).catch((error) => toast(`Could not open the folder: ${(error as Error).message}`, 'error'));
                  }}
                >
                  <Icon name="folder" size={14} />
                </button>
              )}
              <button
                className="small icon ghost"
                title="Remove from this list (the file stays on disk)"
                onClick={(e) => {
                  e.stopPropagation();
                  void forget(r.path);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {dialog === 'new' && <NewMapDialog onClose={() => setDialog(null)} />}
      {dialog === 'open' && <OpenLevelDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
