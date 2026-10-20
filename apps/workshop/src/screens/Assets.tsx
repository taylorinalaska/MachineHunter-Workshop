/** Asset browser: every texture, sprite, picture and sound in the user's DATA.ARC. */
import { LEVEL_IDS, bitmapToRgba, decodeBmp, spriteSide } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { playRaw } from '../game/audio.ts';
import { LEVEL_TITLES, SPRITE_STAGE } from '../game/gamedata.ts';
import { useGame } from '../state/app.ts';
import { TileCanvas, formatBytes } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

type Tab = 'textures' | 'sprites' | 'pictures' | 'sounds' | 'files';

function Textures() {
  const game = useGame();
  const [level, setLevel] = useState('MARS');
  const tiles = game.level(level).tiles;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVEL_IDS.map((id) => (
            <option key={id} value={id}>
              {LEVEL_TITLES[id] ?? id} ({id})
            </option>
          ))}
        </select>
        <span className="dim">{tiles.length} tiles of 64×64, shown with the level's own palette at full brightness</span>
      </div>
      <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, 72px)' }}>
        {tiles.map((tile, i) => (
          <div className="tile" key={`${level}${i}`} title={`Tile ${i}`}>
            <TileCanvas game={game} level={level} tile={tile} />
            <span className="badge">{i}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SpriteFrame({ container, frame, level }: { container: string; frame: number; level: string }) {
  const game = useGame();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const image = game.frameImage(container, frame, level);
    // Frames are 64, 32 or 16 pixels square; each is shown at its own size on a 64-pixel stage.
    canvas.width = canvas.height = SPRITE_STAGE;
    if (image) canvas.getContext('2d')!.drawImage(image, (SPRITE_STAGE - image.width) / 2, (SPRITE_STAGE - image.height) / 2);
    canvas.title = `Frame ${frame}${image ? ` (${image.width} px)` : ''}`;
  }, [game, container, frame, level]);
  return <canvas ref={ref} />;
}

function Sprites() {
  const game = useGame();
  const containers = useMemo(() => game.archive.withExtension('.B').map((e) => e.name), [game]);
  const [name, setName] = useState('DROID2.B');
  const [limit, setLimit] = useState(120);
  const frames = game.sprites(name);
  const level = game.levelUsing(name);
  const users = game.levels.filter((l) => [...game.level(l.id).slots.values()].includes(name)).map((l) => l.id);
  useEffect(() => setLimit(120), [name]);
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
      <div className="list scroll" style={{ width: 190, maxHeight: 'calc(100vh - 210px)' }}>
        {containers.map((c) => (
          <div key={c} className={`item ${c === name ? 'selected' : ''}`} onClick={() => setName(c)}>
            <span className="mono">{c}</span>
          </div>
        ))}
      </div>
      <div className="grow">
        <p className="dim" style={{ marginBottom: 10 }}>
          {frames.length} frames · {[...new Set(frames.map((f) => spriteSide(f.scale)))].sort((a, b) => b - a).join(' / ')} px · palette of {level}
          {users.length ? ` · loaded by ${users.length === game.levels.length ? 'every level' : users.join(', ')}` : ' · not loaded by any level'}
        </p>
        <div className="frame-strip" style={{ gridTemplateColumns: 'repeat(auto-fill, 68px)' }}>
          {frames.slice(0, limit).map((_, i) => (
            <SpriteFrame key={`${name}${i}`} container={name} frame={i} level={level} />
          ))}
        </div>
        {frames.length > limit && (
          <button className="small" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 240)}>
            Show more ({frames.length - limit} left)
          </button>
        )}
      </div>
    </div>
  );
}

function Picture({ name }: { name: string }) {
  const game = useGame();
  const ref = useRef<HTMLCanvasElement>(null);
  const bitmap = useMemo(() => decodeBmp(game.archive.read(name)), [game, name]);
  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.putImageData(new ImageData(bitmapToRgba(bitmap) as Uint8ClampedArray<ArrayBuffer>, bitmap.width, bitmap.height), 0, 0);
  }, [bitmap]);
  return (
    <div className="card" style={{ padding: 10 }}>
      <canvas ref={ref} className="pixel" style={{ width: '100%', display: 'block', borderRadius: 4 }} />
      <div className="row" style={{ marginTop: 6 }}>
        <span className="mono">{name}</span>
        <span className="faint right">
          {bitmap.width}×{bitmap.height}
        </span>
      </div>
    </div>
  );
}

function Pictures() {
  const game = useGame();
  const names = useMemo(() => game.archive.withExtension('.BMP').map((e) => e.name), [game]);
  return (
    <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
      {names.map((n) => (
        <Picture key={n} name={n} />
      ))}
    </div>
  );
}

function Sounds() {
  const game = useGame();
  const [search, setSearch] = useState('');
  const effectIds = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const s of game.sounds) map.set(s.sample.toUpperCase(), [...(map.get(s.sample.toUpperCase()) ?? []), s.id]);
    return map;
  }, [game]);
  const list = useMemo(() => game.archive.withExtension('.RAW').filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())), [game, search]);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Search sounds…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        <span className="dim">{list.length} samples · 22 kHz mono 8-bit</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 6 }}>
        {list.map((e) => {
          const ids = effectIds.get(e.name.toUpperCase()) ?? [];
          return (
            <button key={e.id} style={{ justifyContent: 'flex-start' }} onClick={() => playRaw(game.archive.read(e))} title={ids.length ? `Sound effect ${ids.join(', ')}` : 'Not referenced by the effect table'}>
              <Icon name="sound" size={15} />
              <span className="mono grow" style={{ textAlign: 'left' }}>
                {e.name.replace(/\.RAW$/i, '')}
              </span>
              <span className="faint">{(game.archive.read(e).length / 22050).toFixed(1)}s</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Files() {
  const game = useGame();
  const [search, setSearch] = useState('');
  const list = game.archive.entries.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <>
      <input placeholder="Filter DATA.ARC…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260, marginBottom: 12 }} />
      <table className="data" style={{ maxWidth: 560 }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Stored</th>
          </tr>
        </thead>
        <tbody>
          {list.slice(0, 700).map((e) => (
            <tr key={e.id}>
              <td className="mono faint">{e.id}</td>
              <td className="mono">{e.name}</td>
              <td className="faint">{formatBytes(e.storedSize)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Assets() {
  const [tab, setTab] = useState<Tab>('textures');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'textures', label: 'Terrain tiles' },
    { id: 'sprites', label: 'Sprites' },
    { id: 'pictures', label: 'Pictures' },
    { id: 'sounds', label: 'Sounds' },
    { id: 'files', label: 'Archive' },
  ];
  return (
    <div className="page">
      <header>
        <h1>Game assets</h1>
        <p>Decoded live from your DATA.ARC. Nothing here is copied out of the archive or stored by the Workshop.</p>
      </header>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'textures' && <Textures />}
      {tab === 'sprites' && <Sprites />}
      {tab === 'pictures' && <Pictures />}
      {tab === 'sounds' && <Sounds />}
      {tab === 'files' && <Files />}
    </div>
  );
}
