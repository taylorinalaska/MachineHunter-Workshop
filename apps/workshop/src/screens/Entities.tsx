/** Entity Lab: every placeable thing in the game, with its sprites, animation, stats and behavior. */
import type { AnimationSource } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, type EntityCategory, type EntityInfo, type GameData, LEVEL_TITLES, SPRITE_STAGE, bestiary } from '../game/gamedata.ts';
import { useApp, useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { AnimatedSprite, type Layer, MODE_NAMES, drawFrame } from '../ui/animation.tsx';
import { EntityThumb, NumberInput } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';

function StillFrame({ game, container, frame, level }: { game: GameData; container: string; frame: number; level: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext('2d')!;
    g.clearRect(0, 0, SPRITE_STAGE, SPRITE_STAGE);
    drawFrame(g, game.frameImage(container, frame, level));
  }, [game, container, frame, level]);
  return <canvas ref={ref} width={SPRITE_STAGE} height={SPRITE_STAGE} />;
}

/** A hand-made animation over any run of frames, for containers the game animates from code. */
const manualSource = (from: number, to: number, tick: number): AnimationSource => ({ va: 0, slot: -1, mode: 2, reversed: false, startOffset: 0, frameBase: Math.min(from, to), frameSpan: Math.abs(to - from) + 1, tickReload: tick, scale: 0x4000, callback: 0 });

function FrameStrip({ game, container, level, highlight }: { game: GameData; container: string; level: string; highlight: Set<number> }) {
  const frames = game.sprites(container);
  const [limit, setLimit] = useState(96);
  useEffect(() => setLimit(96), [container]);
  return (
    <>
      <div className="frame-strip">
        {frames.slice(0, limit).map((_, i) => (
          <FrameCanvas key={`${container}:${i}:${level}`} game={game} container={container} frame={i} level={level} current={highlight.has(i)} />
        ))}
      </div>
      {frames.length > limit && (
        <button className="small" style={{ marginTop: 8 }} onClick={() => setLimit(limit + 200)}>
          Show more ({frames.length - limit} left)
        </button>
      )}
    </>
  );
}

function FrameCanvas({ game, container, frame, level, current }: { game: GameData; container: string; frame: number; level: string; current: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const image = game.frameImage(container, frame, level);
    // Every frame on the same 64-pixel stage, so the strip shows their true relative sizes.
    canvas.width = canvas.height = SPRITE_STAGE;
    drawFrame(canvas.getContext('2d')!, image);
    canvas.title = `Frame ${frame}${image ? ` · ${image.width}×${image.height}` : ''}`;
  }, [game, container, frame, level]);
  return <canvas ref={ref} className={current ? 'current' : ''} />;
}

const fixed = (value: number, shift: number, digits = 2) => (value / (1 << shift)).toFixed(digits);

function Details({ info }: { info: EntityInfo }) {
  const game = useGame();
  const go = useApp((s) => s.go);
  const setBrush = useEditor((s) => s.setBrush);
  const setTool = useEditor((s) => s.setTool);
  const hasProject = useEditor((s) => !!s.project);
  const projectLevel = useEditor((s) => s.project?.baseLevel);
  const [playing, setPlaying] = useState(true);
  const [state, setState] = useState<'idle' | 'move'>('idle');
  /** A single record or frame range picked from the lists below, shown instead of the assembled entity. */
  const [picked, setPicked] = useState<{ container: string; source: AnimationSource; label: string } | null>(null);
  const [range, setRange] = useState({ from: 0, to: 7, tick: 4 });

  // Show the entity with a level that actually loads its sprites.
  const level = useMemo(() => (info.sprite ? game.levelUsing(info.sprite, projectLevel ?? info.maps[0]?.level) : (projectLevel ?? 'MARS')), [game, info, projectLevel]);
  const form = info.form ? bestiary.forms.find((f) => f.form === info.form) : null;
  const d = info.descriptor;

  const assembled = useMemo<Layer[]>(() => game.entityLayers(info.type, level).map((l, i) => ({ ...l, label: i === 0 ? 'Body' : 'Upper part' })), [game, info, level]);
  // Every animation record the executable holds for the sprite files this entity is drawn from.
  const containers = useMemo(() => [...new Set([...assembled.map((l) => l.container), ...(info.sprite ? [info.sprite] : [])].map((c) => c.toUpperCase()))], [assembled, info]);
  const records = useMemo(() => containers.map((c) => ({ container: c, frames: game.sprites(c).length, list: game.animationsFor(c) })), [game, containers]);

  const layers = useMemo<Layer[]>(() => {
    if (picked) return [{ label: picked.label, container: picked.container, source: picked.source, frame: picked.source.frameBase }];
    const idle = assembled;
    if (state === 'idle' || !info.form) return idle;
    const moving = game.formAnimations[info.form - 1];
    return idle.map((l, i) => {
      const source = i === 0 ? moving?.moveBody : moving?.moveTurret;
      return source && l.source ? { ...l, source: { ...source, slot: l.source.slot }, frame: source.frameBase } : l;
    });
  }, [game, info, assembled, state, picked]);

  // The per-form records of the ten controllable bodies carry no sprite slot; they play on the form's own file.
  const formRecords = useMemo(() => {
    if (!info.form || !assembled.length) return [];
    const f = game.formAnimations[info.form - 1];
    const body = assembled[0].container.toUpperCase();
    const upper = (assembled[1] ?? assembled[0]).container.toUpperCase();
    return [
      { name: 'Standing, body', container: body, source: f?.idleBody },
      { name: 'Moving, body', container: body, source: f?.moveBody },
      { name: 'Moving, upper part', container: upper, source: f?.moveTurret },
      { name: 'Firing, upper part', container: upper, source: f?.firing },
      { name: 'Dying, upper part', container: upper, source: f?.dying },
    ].filter((r): r is { name: string; container: string; source: AnimationSource } => !!r.source && r.source.mode !== 0 && r.source.frameBase + Math.max(1, r.source.frameSpan) <= game.sprites(r.container).length);
  }, [game, info, assembled]);

  const highlight = useMemo(() => {
    const set = new Set<number>();
    for (const l of layers) {
      if (!l.source) set.add(l.frame);
      else for (let i = 0; i < Math.max(1, l.source.frameSpan); i++) set.add(l.source.frameBase + i);
    }
    return set;
  }, [layers]);
  const container = picked?.container ?? assembled[0]?.container ?? info.sprite;

  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start', gap: 24, marginBottom: 22 }}>
        <div>
          <div className="stage" style={{ width: 288, height: 288 }}>
            {layers.length ? <AnimatedSprite game={game} layers={layers} level={level} playing={playing} cycle={!!picked} /> : <span className="faint">No sprite of its own</span>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="small" onClick={() => setPlaying(!playing)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            {picked ? (
              <button className="small" onClick={() => setPicked(null)} title="Show the entity as it stands in the game again">
                Back to the whole entity
              </button>
            ) : (
              info.form && (
                <div className="segmented">
                  <button className={state === 'idle' ? 'active' : ''} onClick={() => setState('idle')}>
                    Standing
                  </button>
                  <button className={state === 'move' ? 'active' : ''} onClick={() => setState('move')}>
                    Moving
                  </button>
                </div>
              )
            )}
            <span className="faint right">palette: {level}</span>
          </div>
          {picked && <p className="hint" style={{ marginTop: 6, maxWidth: 288 }}>Playing {picked.label}.</p>}
        </div>
        <div className="grow">
          <div className="row">
            <h1>{info.name}</h1>
            <span className="pill">{CATEGORY_LABELS[info.category]}</span>
          </div>
          <p className="dim" style={{ margin: '4px 0 14px' }}>
            Map type {info.type}
            {form?.model ? ` · ${form.maker} ${form.model}` : ''}
            {info.nameSource ? ` · name from ${info.nameSource.replace(/-/g, ' ')}` : ''}
          </p>
          <div className="stat-grid">
            {d?.maxHealth ? (
              <div className="stat">
                <b>{d.maxHealth}</b>
                <span>Health</span>
              </div>
            ) : null}
            {d?.radius ? (
              <div className="stat">
                <b>{fixed(d.radius, 8)}</b>
                <span>Collision radius (cells)</span>
              </div>
            ) : null}
            {form && (
              <>
                <div className="stat">
                  <b>{form.forwardSpeedCap}</b>
                  <span>Top speed (engine units)</span>
                </div>
                <div className="stat">
                  <b>{form.linearAcceleration}</b>
                  <span>Acceleration (engine units)</span>
                </div>
                <div className="stat">
                  <b>{form.fireInterval.join(' / ')}</b>
                  <span>Updates between shots (power 1/2/3)</span>
                </div>
              </>
            )}
            <div className="stat">
              <b>{info.placements}</b>
              <span>Placed in retail levels</span>
            </div>
          </div>
          {hasProject && (
            <button
              style={{ marginTop: 14 }}
              onClick={() => {
                setBrush({ entityType: info.type, entityBehavior: info.behaviors[0]?.selector ?? 0, entityWeapon: 0 });
                setTool('entity');
                go('build');
              }}
            >
              <Icon name="entity" /> Place in my map
            </button>
          )}
        </div>
      </div>

      {form && form.form > 1 && (
        <section className="section">
          <h3>Weapon: {form.weapon}</h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            {form.robotClass} · {form.brain} brain · built for {form.role.toLowerCase()}. Damage is per projectile before difficulty scaling (the player deals ×{bestiary.difficulty.playerDamage.join(' / ×')} and takes ×{bestiary.difficulty.incomingDamage.join(' / ×')} from easiest to hardest).
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Power level</th>
                <th>Damage</th>
                <th>Projectile speed (engine units)</th>
                <th>Fire delay</th>
                <th>Energy per shot</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {form.projectiles
                .filter((p) => p.variant === 'normal')
                .map((p) => (
                  <tr key={p.powerLevel}>
                    <td>{p.powerLevel}</td>
                    <td>{p.damage}</td>
                    <td>{p.speed}</td>
                    <td>{form.fireInterval[p.powerLevel - 1]} updates</td>
                    <td>{form.energyCost[p.powerLevel - 1]}</td>
                    <td className="dim">{p.behavior === 'ricochet' ? 'bounces off walls' : ''}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {info.pickup && (
        <section className="section">
          <h3>When collected</h3>
          <p>{info.pickup.operation}</p>
          <p className="hint" style={{ marginTop: 6 }}>
            {info.pickup.eligibility && `Can be picked up while: ${info.pickup.eligibility}. `}
            {info.pickup.limit && `Limit: ${info.pickup.limit}. `}
            {info.pickup.accessChannel ? `Opens doors keyed to access channel ${info.pickup.accessChannel}.` : ''}
          </p>
        </section>
      )}

      {info.emitter && (
        <section className="section">
          <h3>Effect</h3>
          <p>{info.emitter.effects}</p>
          <p className="hint" style={{ marginTop: 6 }}>{info.emitter.cadence}</p>
        </section>
      )}

      {info.behaviors.length > 0 && (
        <section className="section">
          <h3>Placement behaviors</h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            Each placed copy carries a behavior number (0–31) that selects how it moves and fights. These are the values the retail levels use.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Behavior</th>
                <th>Used</th>
                <th>With a path</th>
                <th>What the code does</th>
              </tr>
            </thead>
            <tbody>
              {info.behaviors.map((b) => (
                <tr key={b.selector}>
                  <td>{b.selector}</td>
                  <td>{b.placements}×</td>
                  <td>{b.pathLinked}×</td>
                  <td className="dim">{b.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {layers.some((l) => l.source) && (
        <section className="section">
          <h3>{picked ? 'Playing now' : 'Starting animation'}</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Layer</th>
                <th>Sprites</th>
                <th>Frames</th>
                <th>Playback</th>
                <th>Frame time</th>
                <th>Scale</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l, i) => (
                <tr key={i}>
                  <td>{l.label}</td>
                  <td className="mono">{l.container}</td>
                  <td>{l.source ? `${l.source.frameBase}–${l.source.frameBase + Math.max(1, l.source.frameSpan) - 1}` : l.frame}</td>
                  <td>{l.source ? (MODE_NAMES[l.source.mode] ?? `mode ${l.source.mode}`) : 'still'}</td>
                  <td>{l.source ? `${l.source.tickReload} updates` : '—'}</td>
                  <td>{l.source?.scale ? `×${fixed(l.source.scale, 14)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {records.map(({ container: name, frames, list }) => (
        <section className="section" key={name}>
          <h3>
            Animations in {name} ({list.length + formRecords.filter((r) => r.container === name).length})
          </h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            Every animation record in the game's executable that draws from this sprite file: standing, moving, attacking, dying, whatever the code switches to. Click one to play it. The executable does not say which state uses which record, so they are listed by frame number.
          </p>
          {(list.length > 0 || formRecords.some((r) => r.container === name)) && (
            <div className="anim-list">
              {formRecords
                .filter((r) => r.container === name)
                .map((r) => (
                  <button key={r.source.va} className={`anim-row ${picked?.source.va === r.source.va ? 'selected' : ''}`} onClick={() => setPicked({ container: name, source: r.source, label: `"${r.name}" (frames ${r.source.frameBase}–${r.source.frameBase + Math.max(1, r.source.frameSpan) - 1} of ${name})` })} title={`Per-form record at ${hex(r.source.va)}`}>
                    <StillFrame game={game} container={name} frame={r.source.frameBase + Math.max(0, r.source.startOffset)} level={level} />
                    <span>
                      {r.name}
                      <small>
                        frames {r.source.frameBase}–{r.source.frameBase + Math.max(1, r.source.frameSpan) - 1} · {MODE_NAMES[r.source.mode] ?? `mode ${r.source.mode}`} · {r.source.tickReload} updates
                      </small>
                    </span>
                  </button>
                ))}
              {list.map((a) => {
                const label = `frames ${a.frameBase}–${a.frameBase + a.frameSpan - 1} of ${name}`;
                return (
                  <button key={a.va} className={`anim-row ${picked?.source.va === a.va ? 'selected' : ''}`} onClick={() => setPicked({ container: name, source: a, label })} title={`Record at ${hex(a.va)}${a.callback ? `, calls ${hex(a.callback)} when it ends` : ''}`}>
                    <StillFrame game={game} container={name} frame={a.frameBase + Math.max(0, a.startOffset)} level={level} />
                    <span>
                      {a.frameSpan > 1 ? `Frames ${a.frameBase}–${a.frameBase + a.frameSpan - 1}` : `Frame ${a.frameBase + Math.max(0, a.startOffset)}`}
                      <small>
                        {MODE_NAMES[a.mode] ?? `mode ${a.mode}`}
                        {a.reversed ? ', reversed' : ''} · {a.tickReload} updates · ×{fixed(a.scale, 14)}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {!list.length && !formRecords.some((r) => r.container === name) && <p className="hint">No records name this file; the game picks its frames in code. Use the frame player below.</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <span className="dim">Play frames</span>
            <NumberInput value={Math.min(range.from, frames - 1)} min={0} max={Math.max(0, frames - 1)} width={62} onChange={(from) => setRange({ ...range, from })} />
            <span className="dim">to</span>
            <NumberInput value={Math.min(range.to, frames - 1)} min={0} max={Math.max(0, frames - 1)} width={62} onChange={(to) => setRange({ ...range, to })} />
            <span className="dim">holding each for</span>
            <NumberInput value={range.tick} min={1} max={60} width={54} onChange={(tick) => setRange({ ...range, tick })} />
            <span className="dim">updates</span>
            <button
              className="small"
              disabled={!frames}
              onClick={() => {
                const from = Math.min(range.from, frames - 1);
                const to = Math.min(range.to, frames - 1);
                setPicked({ container: name, source: manualSource(from, to, range.tick), label: `frames ${Math.min(from, to)}–${Math.max(from, to)} of ${name}` });
              }}
            >
              Play
            </button>
          </div>
        </section>
      ))}

      {info.maps.length > 0 && (
        <section className="section">
          <h3>Where it appears</h3>
          <div className="row wrap">
            {info.maps.map((m) => (
              <span key={m.level} className="pill" title={m.level}>
                {LEVEL_TITLES[m.level] ?? m.level} × {m.count}
              </span>
            ))}
          </div>
        </section>
      )}

      {d && (
        <section className="section">
          <h3>Engine record</h3>
          <p className="hint mono">
            descriptor {hex(d.va)} · flags {hex(d.flags)} · init {hex(d.initFn)} · update {hex(d.updateFn)} · aux {hex(d.auxBlock)} · facing policy {hex(info.facingPolicy & 0xffff, 4)}
          </p>
        </section>
      )}

      {container && (
        <section className="section">
          <h3>
            All frames in {container} ({game.sprites(container).length})
          </h3>
          <FrameStrip game={game} container={container} level={level} highlight={highlight} />
        </section>
      )}
    </>
  );
}

const hex = (n: number, width = 8) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

const TABS: (EntityCategory | 'all')[] = ['all', 'robot', 'creature', 'human', 'vehicle', 'turret', 'boss', 'pickup', 'objective', 'effect', 'marker', 'decor', 'player'];

export function Entities() {
  const game = useGame();
  const [category, setCategory] = useState<EntityCategory | 'all'>('robot');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(3);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return game.entities.filter((e) => (q ? e.name.toLowerCase().includes(q) || String(e.type) === q || (e.sprite ?? '').toLowerCase().includes(q) : category === 'all' || e.category === category));
  }, [game, category, search]);
  const info = game.entity(selected);
  return (
    <div className="split">
      <aside>
        <header>
          <h2>Entity Lab</h2>
          <input style={{ width: '100%', margin: '10px 0 8px' }} placeholder="Search by name, type or sprite…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="tabs" style={{ marginBottom: 0 }}>
            {TABS.map((c) => (
              <button key={c} className={category === c && !search ? 'active' : ''} onClick={() => setCategory(c)}>
                {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </header>
        <div className="content">
          <div className="entity-list">
            {list.map((e) => (
              <button key={e.type} className={`entity-row ${selected === e.type ? 'selected' : ''}`} onClick={() => setSelected(e.type)}>
                <EntityThumb game={game} type={e.type} level={e.sprite ? game.levelUsing(e.sprite, e.maps[0]?.level) : 'MARS'} />
                <span className="name">
                  {e.name}
                  <br />
                  <small>
                    type {e.type}
                    {e.descriptor?.maxHealth ? ` · ${e.descriptor.maxHealth} HP` : ''}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main className="scroll">{info ? <Details key={info.type} info={info} /> : <div className="empty">Pick an entity.</div>}</main>
    </div>
  );
}
