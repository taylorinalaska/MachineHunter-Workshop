/**
 * The effect designer: an effect made for the map from the game's own
 * particles, spawned together at a chosen rate and spread. See `CustomEffect`
 * in @mh/core; the runtime spawns them through the engine's effect routine.
 */
import { type CustomEffect, EFFECT_ID_COUNT, MAX_EFFECT_PARTICLES, allocateId } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type EffectKind, UPDATES_PER_SECOND, readEffectKind } from '../editor/effects.ts';
import type { GameData } from '../game/gamedata.ts';
import { useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { Dialog, Field } from '../ui/common.tsx';

/** The particles the retail emitters use, by name; the rest of the table is offered by number. */
export const NAMED_PARTICLES: Record<number, string> = {
  0x7d: 'Smoke puff',
  0xa7: 'Fire flash',
  0x94: 'Bubble',
  0x67: 'Steam puff',
  0xbc: 'Steam jet',
  0xb6: 'Teleporter orb',
  0xb5: 'Teleporter ring',
};

export const particleName = (fx: number): string => NAMED_PARTICLES[fx] ?? `Particle ${fx}`;

/** Starting points for a new effect. */
const PRESETS: { name: string; every: number; particles: CustomEffect['particles'] }[] = [
  { name: 'Smoke', every: 4, particles: [{ fx: 0x7d, spread: 32 }] },
  { name: 'Fire', every: 4, particles: [{ fx: 0xa7, spread: 32 }, { fx: 0x7d, spread: 32 }] },
  { name: 'Bubbles', every: 16, particles: [{ fx: 0x94, spread: 48 }] },
  { name: 'Steam', every: 16, particles: [{ fx: 0x67, spread: 0 }] },
];

export function newCustomEffect(): Omit<CustomEffect, 'id'> {
  const p = PRESETS[0];
  return { name: 'My effect', every: p.every, particles: p.particles.map((x) => ({ ...x })) };
}

/** Every entry of the engine's effect table that has something to draw in this theme. */
function useParticleKinds(game: GameData, level: string): EffectKind[] {
  return useMemo(() => {
    const out: EffectKind[] = [];
    for (let id = 1; id < EFFECT_ID_COUNT; id++) {
      const kind = readEffectKind(game.exe, id);
      if (kind && game.level(level).slots.has(kind.slot)) out.push(kind);
    }
    return out.sort((a, b) => Number(b.id in NAMED_PARTICLES) - Number(a.id in NAMED_PARTICLES) || a.id - b.id);
  }, [game, level]);
}

function frameOf(game: GameData, level: string, kind: EffectKind, frame = kind.frameBase): HTMLCanvasElement | null {
  const container = game.level(level).slots.get(kind.slot);
  return container ? game.frameImage(container, frame, level) : null;
}

function ParticleThumb({ game, level, kind }: { game: GameData; level: string; kind: EffectKind }) {
  const url = useMemo(() => frameOf(game, level, kind)?.toDataURL() ?? '', [game, level, kind]);
  return url ? <img className="pixel particle-thumb" src={url} alt="" draggable={false} /> : <span className="particle-thumb" />;
}

/** A live view of the effect from above, as the game simulates it (see editor/effects.ts). */
function EffectPreview({ game, level, effect, kinds }: { game: GameData; level: string; effect: Omit<CustomEffect, 'id'>; kinds: Map<number, EffectKind> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    // 1 cell = 64 pixels; rising shows as moving up the picture.
    const scale = 64 / 256;
    let particles: { kind: EffectKind; x: number; y: number; rise: number; fade: number; age: number; size: number }[] = [];
    let tick = 0;
    let carry = 0;
    let last = performance.now();
    let handle = 0;
    const step = () => {
      tick++;
      if (tick % Math.max(1, effect.every) === 0) {
        for (const p of effect.particles) {
          const kind = kinds.get(p.fx);
          if (!kind || particles.length > 400) continue;
          const r = () => (p.spread ? Math.floor(Math.random() * p.spread * 2) - p.spread : 0);
          particles.push({ kind, x: r(), y: r(), rise: kind.z, fade: kind.fadeStart, age: 0, size: kind.scale });
        }
      }
      for (const p of particles) {
        const m = p.kind.motion;
        p.age++;
        p.rise += m.rise ?? 0;
        if (m.jitter) {
          p.x += (Math.random() * 2 - 1) * m.jitter;
          p.y += (Math.random() * 2 - 1) * m.jitter;
        }
        p.size += p.kind.growth;
        p.fade -= m.fade;
      }
      particles = particles.filter((p) => p.fade > 0);
    };
    const draw = (now: number) => {
      carry += Math.min(0.25, (now - last) / 1000) * UPDATES_PER_SECOND;
      last = now;
      while (carry >= 1) {
        carry -= 1;
        step();
      }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#14181e';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        const k = p.kind;
        const s = Math.floor(p.age / k.tick);
        const frame = k.mode === 2 ? k.frameBase + (s % k.frameSpan) : k.frameBase + Math.min(k.frameSpan - 1, k.mode === 1 ? 0 : s);
        const image = frameOf(game, level, k, frame);
        if (!image) continue;
        const side = Math.max(2, image.width * Math.max(0.05, p.size));
        g.globalAlpha = Math.max(0, Math.min(1, (p.fade >> 3) / 15 + 0.08));
        g.drawImage(image, canvas.width / 2 + p.x * scale - side / 2, canvas.height * 0.7 + (p.y - p.rise) * scale - side / 2, side, side);
      }
      g.globalAlpha = 1;
      handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [game, level, effect, kinds]);
  return <canvas ref={ref} width={256} height={256} className="effect-preview" />;
}

export function CustomEffectDialog({ initial, onClose }: { initial: CustomEffect | null; onClose: () => void }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const setBrush = useEditor((s) => s.setBrush);
  const level = project.baseLevel;
  const all = useParticleKinds(game, level);
  const kinds = useMemo(() => new Map(all.map((k) => [k.id, k])), [all]);
  const [draft, setDraft] = useState<Omit<CustomEffect, 'id'>>(() => (initial ? { name: initial.name, every: initial.every, particles: initial.particles.map((p) => ({ ...p })) } : newCustomEffect()));
  const [picking, setPicking] = useState<number | null>(null);
  const perSecond = UPDATES_PER_SECOND / draft.every;

  const setParticle = (i: number, patch: Partial<CustomEffect['particles'][number]>) => setDraft((d) => ({ ...d, particles: d.particles.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const save = () => {
    const name = draft.name.trim() || 'My effect';
    let id = initial?.id ?? -1;
    edit((p) => {
      if (initial) Object.assign(p.effects.find((e) => e.id === initial.id)!, { ...draft, name });
      else {
        id = allocateId(p);
        p.effects.push({ id, ...draft, name });
      }
    });
    setBrush({ effect: id });
    onClose();
  };

  const remove = () => {
    if (!initial) return;
    const placed = project.groups.flatMap((g) => g.layers.flatMap((l) => l.entities.filter((e) => e.effect === initial.id))).length;
    if (!window.confirm(`Delete "${initial.name}"${placed ? ` and the ${placed} placed in the map` : ''}?`)) return;
    edit((p) => {
      p.effects = p.effects.filter((e) => e.id !== initial.id);
      for (const g of p.groups) for (const l of g.layers) l.entities = l.entities.filter((e) => e.effect !== initial.id);
    });
    setBrush({ effect: null });
    onClose();
  };

  return (
    <Dialog
      title={initial ? `Effect: ${initial.name}` : 'New effect'}
      width={760}
      onClose={onClose}
      footer={
        <>
          {initial && (
            <button className="danger" style={{ marginRight: 'auto' }} onClick={remove}>
              Delete
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!draft.particles.length} onClick={save}>
            {initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div>
          <EffectPreview game={game} level={level} effect={draft} kinds={kinds} />
          {!initial && (
            <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
              {PRESETS.map((p) => (
                <button key={p.name} className="small" onClick={() => setDraft((d) => ({ ...d, every: p.every, particles: p.particles.map((x) => ({ ...x })) }))}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grow">
          <Field label="Name">
            <input value={draft.name} maxLength={40} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="How often">
            <div className="row grow">
              <input type="range" className="grow" min={1} max={60} value={61 - draft.every} onChange={(e) => setDraft({ ...draft, every: 61 - Number(e.target.value) })} />
              <span className="dim" style={{ minWidth: 92, textAlign: 'right' }}>
                {perSecond >= 1 ? `${perSecond.toFixed(perSecond < 10 ? 1 : 0)} a second` : `every ${(1 / perSecond).toFixed(1)} s`}
              </span>
            </div>
          </Field>
          <h3 style={{ marginTop: 12 }}>Particles</h3>
          {draft.particles.map((p, i) => {
            const kind = kinds.get(p.fx);
            return (
              <div key={i} className="particle-row">
                <button className="particle-pick" onClick={() => setPicking(i)} title="Choose another particle">
                  {kind && <ParticleThumb game={game} level={level} kind={kind} />}
                  <span>{particleName(p.fx)}</span>
                </button>
                <span className="dim">spread</span>
                <input type="range" min={0} max={256} step={8} value={p.spread} onChange={(e) => setParticle(i, { spread: Number(e.target.value) })} />
                <span className="dim" style={{ minWidth: 60 }}>{(p.spread / 256).toFixed(2)} cells</span>
                <button className="small icon ghost" title="Remove this particle" disabled={draft.particles.length < 2} onClick={() => setDraft({ ...draft, particles: draft.particles.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            );
          })}
          {draft.particles.length < MAX_EFFECT_PARTICLES && (
            <button className="small" style={{ marginTop: 6 }} onClick={() => setDraft({ ...draft, particles: [...draft.particles, { fx: 0x7d, spread: 0 }] })}>
              Add a particle
            </button>
          )}
        </div>
      </div>
      {picking !== null && (
        <div className="section" style={{ marginTop: 12 }}>
          <h3>Choose a particle</h3>
          <div className="particle-grid">
            {all.map((k) => (
              <button
                key={k.id}
                className={`particle-cell ${draft.particles[picking]?.fx === k.id ? 'active' : ''}`}
                title={`${particleName(k.id)} · ${k.frameSpan} frame${k.frameSpan === 1 ? '' : 's'}`}
                onClick={() => {
                  setParticle(picking, { fx: k.id });
                  setPicking(null);
                }}
              >
                <ParticleThumb game={game} level={level} kind={k} />
                <small>{NAMED_PARTICLES[k.id] ?? k.id}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
