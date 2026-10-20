/**
 * The custom enemy editor: a retail entity type made over for one map, with
 * its own name, numbers and look. See `CustomType` in @mh/core.
 */
import { CUSTOM_HEALTH_MAX, CUSTOM_PERCENT_MAX, CUSTOM_PERCENT_MIN, type CustomAnimation, type CustomType, type SpriteFrame, decodeSprites, encodeSprites, slugify } from '@mh/core';
import { useMemo, useRef, useState } from 'react';
import type { EntityCategory, EntityInfo, GameData, SlotLooks } from '../game/gamedata.ts';
import { type Recolor, type TypeAnimation, animationOf, framesToSheet, recolorFrames, retimed, sheetToFrames, slotSharers, typeAnimations, typeSlot } from '../game/looks.ts';
import { AnimatedSprite, MODE_NAMES } from '../ui/animation.tsx';
import { bestiary } from '../game/gamedata.ts';
import { useApp, useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { CanvasImage, Dialog, Field, NumberInput } from '../ui/common.tsx';

/** Kinds of entity that fight and can be made over. */
const CUSTOMISABLE: ReadonlySet<EntityCategory> = new Set(['robot', 'creature', 'human', 'vehicle', 'turret', 'boss']);

/** Whether a type can be customized: something that fights, with health of its own, other than the player. */
export function canCustomize(info: EntityInfo | undefined): boolean {
  return !!info && info.type > 1 && CUSTOMISABLE.has(info.category) && !!info.descriptor?.maxHealth;
}

export function newCustomType(info: EntityInfo): CustomType {
  return { type: info.type, name: `Custom ${info.name}`, health: null, speed: 100, fireRate: 100, damage: 100, sprite: null, look: null };
}

const NO_RECOLOR: Recolor = { hue: 0, saturation: 100, brightness: 100 };

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <div className="row grow">
        <input type="range" className="grow" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="dim" style={{ minWidth: 48, textAlign: 'right' }}>
          {value}
          {unit}
        </span>
      </div>
    </Field>
  );
}

let previewId = 1;

/** The runtime's sprite arena is bounded; this keeps a replacement file a sensible size. */
const MAX_EXTRA_FRAMES = 64;

const MODES: { mode: number; label: string }[] = [
  { mode: 1, label: 'Hold one frame' },
  { mode: 2, label: 'Loop' },
  { mode: 3, label: 'Back and forth' },
];

/** The type's animations, each of which can be pointed at other frames, retimed and played another way. */
function AnimationsEditor({ game, level, container, frameCount, animations, changes, onChange }: { game: GameData; level: string; container: string; frameCount: number; animations: TypeAnimation[]; changes: CustomAnimation[]; onChange: (list: CustomAnimation[]) => void }) {
  const [picked, setPicked] = useState(0);
  const current = animations[Math.min(picked, animations.length - 1)];
  const change = changes.find((c) => c.record === current.source.va);
  const value = change ?? animationOf(current.source);
  const set = (patch: Partial<CustomAnimation>) => {
    const next = { ...value, ...patch };
    next.span = Math.max(1, Math.min(next.span, frameCount - next.base));
    next.start = Math.min(next.start, next.span - 1);
    const rest = changes.filter((c) => c.record !== current.source.va);
    const same = JSON.stringify(next) === JSON.stringify(animationOf(current.source));
    onChange(same ? rest : [...rest, next]);
  };
  const source = retimed(current.source, change);
  const layers = useMemo(() => [{ label: current.label, container, source, frame: source.frameBase }], [current.label, container, source]);
  const outside = value.base + value.span > frameCount;
  return (
    <div className="section" style={{ marginTop: 14 }}>
      <h3>Animations</h3>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div className="anim-list">
          {animations.map((a, i) => {
            const c = changes.find((x) => x.record === a.source.va);
            const s = retimed(a.source, c);
            return (
              <button key={a.source.va} className={`anim-row ${i === picked ? 'active' : ''}`} onClick={() => setPicked(i)}>
                <span className="grow">{a.label}</span>
                <small className="faint">
                  {s.frameSpan} frame{s.frameSpan === 1 ? '' : 's'} · {MODE_NAMES[s.mode] ?? `mode ${s.mode}`}
                </small>
                {c && <span className="pill ok">changed</span>}
              </button>
            );
          })}
        </div>
        <div className="custom-preview">
          <AnimatedSprite game={game} layers={layers} level={level} playing cycle={source.mode >= 4} size={128} />
        </div>
        <div className="grow">
          <Field label="First frame">
            <NumberInput value={value.base} min={0} max={frameCount - 1} onChange={(base) => set({ base })} />
          </Field>
          <Field label="Frames">
            <NumberInput value={value.span} min={1} max={Math.max(1, frameCount - value.base)} onChange={(span) => set({ span })} />
          </Field>
          <Field label="Starts on">
            <NumberInput value={value.start} min={0} max={value.span - 1} onChange={(start) => set({ start })} />
          </Field>
          <Field label="Speed">
            <div className="row">
              <NumberInput value={value.ticks} min={1} max={60} onChange={(ticks) => set({ ticks })} />
              <span className="dim">updates a frame ({(30 / value.ticks).toFixed(1)} frames a second)</span>
            </div>
          </Field>
          <Field label="Plays">
            {current.modeLocked ? (
              <span className="dim">once, then the game takes over ({MODE_NAMES[value.mode]})</span>
            ) : (
              <select value={value.mode} onChange={(e) => set({ mode: Number(e.target.value) })}>
                {MODES.map((m) => (
                  <option key={m.mode} value={m.mode}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={value.reversed} onChange={(e) => set({ reversed: e.target.checked })} /> Backwards
          </label>
          {change && (
            <button className="small ghost" style={{ marginTop: 6 }} onClick={() => onChange(changes.filter((c) => c.record !== current.source.va))}>
              Undo changes to this animation
            </button>
          )}
          {outside && (
            <p className="hint warn-text">
              Only {frameCount} frames exist. Add extra frames or pick others.
            </p>
          )}
        </div>
      </div>
      {current.modeLocked && (
        <p className="hint" style={{ marginTop: 8 }}>
          This one always plays once.
        </p>
      )}
    </div>
  );
}

export function CustomTypeDialog({ initial, onClose }: { initial: CustomType; onClose: () => void }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const toast = useApp((s) => s.toast);
  const info = game.entity(initial.type)!;
  const level = project.baseLevel;
  const palette = game.level(level).palette;
  const slot = typeSlot(game, initial.type, level);
  const retailFrames = useMemo(() => (slot ? game.sprites(slot.container) : []), [game, slot?.container]);
  const existing = project.customTypes.some((t) => t.type === initial.type);
  const form = info.form ? bestiary.forms.find((f) => f.form === info.form) : undefined;

  const [draft, setDraft] = useState<CustomType>(() => ({ ...initial }));
  const [lookMode, setLookMode] = useState<'retail' | 'recolor' | 'imported'>(initial.look?.kind ?? 'retail');
  const [recolor, setRecolor] = useState<Recolor>(initial.look?.kind === 'recolor' ? initial.look : NO_RECOLOR);
  /** Frames imported from a picture in this session, or decoded from the saved look. */
  const [imported, setImported] = useState<SpriteFrame[] | null>(() => (initial.look?.kind === 'imported' && initial.sprite ? decodeSprites(initial.sprite.data) : null));
  const [importedFile, setImportedFile] = useState(initial.look?.kind === 'imported' ? initial.look.file : '');
  const fileInput = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<CustomType>) => setDraft((d) => ({ ...d, ...patch }));
  /** Frames added after the retail ones, for animations of their own. */
  const [extra, setExtra] = useState(() => (initial.sprite && retailFrames.length ? Math.max(0, decodeSprites(initial.sprite.data).length - retailFrames.length) : 0));

  // The retail frames plus the extra ones, which start as copies of the last retail frame for painting over.
  const baseFrames = useMemo(() => (extra && retailFrames.length ? [...retailFrames, ...Array.from({ length: extra }, () => retailFrames[retailFrames.length - 1])] : retailFrames), [retailFrames, extra]);
  const frames: SpriteFrame[] | null = useMemo(() => {
    if (!slot) return null;
    if (lookMode === 'retail') return extra ? baseFrames : null;
    if (lookMode === 'imported') return imported ? baseFrames.map((f, i) => imported[i] ?? f) : null;
    return recolorFrames(baseFrames, palette, recolor);
  }, [slot, lookMode, imported, baseFrames, palette, recolor, extra]);
  const frameCount = baseFrames.length;

  const looks: SlotLooks | undefined = useMemo(() => (slot && frames ? { key: `preview-${previewId++}`, slots: new Map([[slot.slot, frames]]) } : undefined), [slot, frames]);
  const preview = useMemo(() => game.entityImage(initial.type, level, looks), [game, initial.type, level, looks]);
  const animations = useMemo(() => typeAnimations(game, initial.type, level), [game, initial.type, level]);
  const badAnimation = (draft.animations ?? []).some((a) => a.base + a.span > frameCount);
  const sharers = slot ? slotSharers(game, slot.slot, initial.type).filter((e) => game.entityAvailableIn(e.type, level)) : [];
  const otherSlotUser = slot ? project.customTypes.find((t) => t.type !== initial.type && t.sprite?.slot === slot.slot) : undefined;

  const exportSheet = () => {
    const canvas = framesToSheet(frames ?? retailFrames, palette);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slugify(draft.name || info.name)}-frames.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  };

  const importSheet = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImported(await sheetToFrames(file, baseFrames, palette));
      setImportedFile(file.name);
      setLookMode('imported');
    } catch (error) {
      toast(`Could not use that picture: ${(error as Error).message}`, 'error');
    }
  };

  const save = () => {
    const look = lookMode === 'recolor' ? ({ kind: 'recolor', ...recolor } as const) : lookMode === 'imported' && imported ? ({ kind: 'imported', file: importedFile } as const) : null;
    const sprite = slot && frames && (look || extra) ? { slot: slot.slot, data: encodeSprites(frames, 'auto') } : null;
    const result: CustomType = { ...draft, name: draft.name.trim() || `Custom ${info.name}`, look, sprite, animations: draft.animations?.length ? draft.animations : undefined };
    edit((p) => {
      const at = p.customTypes.findIndex((t) => t.type === result.type);
      if (at >= 0) p.customTypes[at] = result;
      else p.customTypes.push(result);
    });
    onClose();
  };

  const remove = () => {
    if (!window.confirm(`Remove "${initial.name}"? Every ${info.name} in the map goes back to normal.`)) return;
    edit((p) => void (p.customTypes = p.customTypes.filter((t) => t.type !== initial.type)));
    onClose();
  };

  const percent = (label: string, key: 'speed' | 'fireRate' | 'damage', retail: string) => (
    <Field label={label}>
      <div className="row">
        <NumberInput value={draft[key]} min={CUSTOM_PERCENT_MIN} max={CUSTOM_PERCENT_MAX} step={5} onChange={(v) => change({ [key]: v } as Partial<CustomType>)} />
        <span className="dim">% {retail ? `(a ${info.name}: ${retail})` : `of a normal ${info.name}`}</span>
      </div>
    </Field>
  );

  return (
    <Dialog
      title={existing ? initial.name : `New enemy from ${info.name}`}
      width={880}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <button className="danger" style={{ marginRight: 'auto' }} onClick={remove}>
              Remove
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={(!!otherSlotUser && (lookMode !== 'retail' || extra > 0)) || badAnimation} title={badAnimation ? 'An animation uses frames the sprite file does not have' : undefined} onClick={save}>
            {existing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <div style={{ textAlign: 'center' }}>
          <div className="custom-preview">
            <CanvasImage source={preview} size={128} />
          </div>
          <small className="faint">
            {info.name} · type {info.type}
          </small>
        </div>
        <div className="grow">
          <Field label="Name">
            <input value={draft.name} maxLength={40} onChange={(e) => change({ name: e.target.value })} />
          </Field>
          <Field label="Health">
            <div className="row">
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={draft.health === null} onChange={(e) => change({ health: e.target.checked ? null : Math.min(CUSTOM_HEALTH_MAX, info.descriptor?.maxHealth ?? 100) })} />
                as the {info.name} ({info.descriptor?.maxHealth})
              </label>
              {draft.health !== null && <NumberInput value={draft.health} min={1} max={CUSTOM_HEALTH_MAX} onChange={(health) => change({ health })} />}
            </div>
          </Field>
          {form && (
            <>
              {percent('Speed', 'speed', '')}
              {percent('Fire rate', 'fireRate', `a shot every ${form.fireInterval.join('/')} updates`)}
              {percent('Damage', 'damage', `${form.projectiles.filter((p) => p.powerLevel > 0).map((p) => p.damage).join('/')} a hit`)}
            </>
          )}
        </div>
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <h3>Look</h3>
        {!slot ? (
          <p className="hint">No sprites of its own in this theme.</p>
        ) : (
          <>
            <div className="tabs">
              <button className={lookMode === 'retail' ? 'active' : ''} onClick={() => setLookMode('retail')}>
                Unchanged
              </button>
              <button className={lookMode === 'recolor' ? 'active' : ''} onClick={() => setLookMode('recolor')}>
                Recolor
              </button>
              <button className={lookMode === 'imported' ? 'active' : ''} disabled={!imported} onClick={() => setLookMode('imported')} title={imported ? importedFile : 'Import a painted sheet first'}>
                Painted
              </button>
            </div>
            {lookMode === 'recolor' && (
              <>
                <Slider label="Hue" value={recolor.hue} min={-180} max={180} unit="°" onChange={(hue) => setRecolor({ ...recolor, hue })} />
                <Slider label="Saturation" value={recolor.saturation} min={0} max={250} unit="%" onChange={(saturation) => setRecolor({ ...recolor, saturation })} />
                <Slider label="Brightness" value={recolor.brightness} min={40} max={180} unit="%" onChange={(brightness) => setRecolor({ ...recolor, brightness })} />
              </>
            )}
            {lookMode === 'imported' && <p className="hint">Frames painted in {importedFile || 'a picture'}.</p>}
            <div className="row wrap" style={{ marginTop: 8 }}>
              <button onClick={exportSheet} title="Save every frame as one picture to paint over">
                Export frames as PNG
              </button>
              <button onClick={() => fileInput.current?.click()} title="Load the painted picture back in">
                Import painted frames…
              </button>
              <input ref={fileInput} type="file" accept="image/png,image/*" hidden onChange={(e) => void importSheet(e.target.files?.[0])} />
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {retailFrames.length} frames. Keep the exported layout.
            </p>
            {sharers.length > 0 && <p className="hint warn-text">Also changes the look of {sharers.map((e) => e.name).join(', ')}.</p>}
            {otherSlotUser && lookMode !== 'retail' && <p className="hint warn-text">"{otherSlotUser.name}" already changes these sprites.</p>}
            <Field label="Extra frames">
              <div className="row">
                <NumberInput value={extra} min={0} max={MAX_EXTRA_FRAMES} onChange={setExtra} />
                <span className="dim">copies of the last frame, to paint over</span>
              </div>
            </Field>
            {frames && <FrameStrip frames={frames} game={game} level={level} />}
          </>
        )}
      </div>

      {slot && animations.length > 0 && (
        <AnimationsEditor
          game={game}
          level={level}
          container={(looks && game.lookContainer(looks, slot.slot)) ?? slot.container}
          frameCount={frameCount}
          animations={animations}
          changes={draft.animations ?? []}
          onChange={(list) => change({ animations: list })}
        />
      )}
    </Dialog>
  );
}

/** The first frames of a look, small. */
function FrameStrip({ frames, game, level }: { frames: SpriteFrame[]; game: GameData; level: string }) {
  const url = useMemo(() => framesToSheet(frames.slice(0, 32), game.level(level).palette).toDataURL(), [frames, game, level]);
  return (
    <div className="frame-strip">
      <img src={url} className="pixel" alt="" draggable={false} />
    </div>
  );
}
