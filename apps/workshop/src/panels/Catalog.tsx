/** Left-hand panel of the builder: what the active tool places, and its options. */
import { type CellDefinition, MAX_TILES, PATH_BACK_AND_FORTH, PATH_LOOP, PATH_ONCE, PATH_ZONE, ProjectComposer, RETAIL_MAX_TILES, type RampDirection } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RAMP_DIRECTIONS, createModel, fillLight, importProp, pathFollowers, removePath } from '../editor/ops.ts';
import { PROP_CATEGORIES, type PropCategory, type PropThumbs, classifyProp, geometryKey, sharedPropThumbs, usePropThumb } from '../editor/prop-thumbs.ts';
import { imagesToTiles, removeCustomTile } from '../editor/textures.ts';
import { CATEGORY_LABELS, type EntityBase, type EntityCategory, type EntityInfo } from '../game/gamedata.ts';
import { INTERACTIVE_TABS, TOOLS } from '../screens/Build.tsx';
import { useApp, useGame } from '../state/app.ts';
import { type TriggerPick, useEditor } from '../state/editor.ts';
import { EntityThumb, Field, NumberInput, TileCanvas } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';
import { projectLooks, typeName } from '../game/looks.ts';
import { CustomTypeDialog, canCustomize, newCustomType } from './CustomType.tsx';
import { CustomEffectDialog, particleName } from './CustomEffect.tsx';
import { LockSelect } from './LockSelect.tsx';
import { doorsWithLock, freeSwitchChannel, triggerName } from '../editor/doors.ts';
import { describeAction, ensureTrigger, padCount, removeTrigger, triggerChannels } from '../editor/triggers.ts';
import { CUSTOM_EFFECT_TYPE, type CustomEffect, type CustomType, type DoorStyle, KEY_COUNT, type Trigger, type TriggerFaces } from '@mh/core';
import { WalkButton } from './WalkButton.tsx';
import { useChecks } from './Inspector.tsx';

/* ------------------------------------------------------------ materials */

/** Adds pictures to the map's tile bank and shows how much room is left. */
function TextureBank() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const editLibrary = useEditor((s) => s.editLibrary);
  const toast = useApp((s) => s.toast);
  const { stats } = useChecks();
  useEditor((s) => s.libraryRevision);
  const input = useRef<HTMLInputElement>(null);
  const [dither, setDither] = useState(false);
  const [busy, setBusy] = useState(false);

  // Cut tiles for ramp sides and split floors are made when the map is built; they need slots too.
  const used = Math.max(project.tiles.length, stats?.tiles ?? 0);
  const custom = project.tiles.length - project.baseTileCount;
  const free = MAX_TILES - used;

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const imported = await imagesToTiles([...files], game.level(project.baseLevel).palette, dither);
      const tiles = imported.flatMap((i) => i.tiles);
      if (tiles.length > free) {
        toast(`Those pictures make ${tiles.length} tiles but only ${free} slots are free.`, 'error');
        return;
      }
      const first = project.tiles.length;
      editLibrary((p) => void p.tiles.push(...tiles));
      setBrush({ floorTile: first });
      toast(tiles.length === 1 ? `Added "${imported[0].name}" as tile ${first}.` : `Added ${tiles.length} tiles (${first}–${first + tiles.length - 1}).`, 'success');
    } catch (error) {
      toast(`Could not read that picture: ${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const removable = [brush.floorTile, brush.wallTile].find((t) => t >= project.baseTileCount && t < project.tiles.length);
  const remove = (index: number) => {
    if (!window.confirm(`Remove custom tile ${index}? Faces that use it go back to tile 0.`)) return;
    editLibrary((p) => removeCustomTile(p, index));
    const clamp = (t: number) => (t === index ? 0 : t > index ? t - 1 : t);
    setBrush({ floorTile: clamp(brush.floorTile), wallTile: clamp(brush.wallTile) });
  };

  return (
    <div className="texture-bank">
      <div className="row">
        <button className="small" disabled={busy || free <= 0} onClick={() => input.current?.click()} title="Any picture. Sheets in multiples of 64×64 are cut into tiles.">
          <Icon name="import" size={14} /> {busy ? 'Converting…' : 'Import…'}
        </button>
        <label className="check" title="Better for photos, worse for pixel art">
          <input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} /> Dither
        </label>
        {removable !== undefined && (
          <button className="small icon danger right" onClick={() => remove(removable)} title={`Remove custom tile ${removable}`}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files)} />
      <div className="slots" title={`The original game holds ${RETAIL_MAX_TILES}; the Workshop runtime holds ${MAX_TILES}.`}>
        <span className="bar">
          <i className={used > MAX_TILES * 0.92 ? 'bad' : ''} style={{ width: `${Math.min(100, (used / MAX_TILES) * 100)}%` }} />
          <b style={{ left: `${(RETAIL_MAX_TILES / MAX_TILES) * 100}%` }} />
        </span>
        <span>
          {used} / {MAX_TILES} tiles{custom > 0 ? ` · ${custom} imported` : ''}
        </span>
      </div>
      {used > RETAIL_MAX_TILES && <p className="hint warn-text">Over {RETAIL_MAX_TILES} tiles: needs the Workshop runtime.</p>}
    </div>
  );
}

function Materials({ show, floorLabel = 'Floor', wallLabel = 'Wall' }: { show: 'both' | 'floor' | 'wall'; floorLabel?: string; wallLabel?: string }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const tool = useEditor((s) => s.tool);
  useEditor((s) => s.libraryRevision);
  const [target, setTarget] = useState<'floor' | 'wall'>(show === 'wall' ? 'wall' : 'floor');
  useEffect(() => {
    if (show !== 'both') setTarget(show);
    else if (tool === 'wall') setTarget('wall');
  }, [show, tool]);
  const level = project.baseLevel;
  const pick = (tile: number) => setBrush(target === 'floor' ? { floorTile: tile } : { wallTile: tile });
  return (
    <>
      <div className="swatches">
        {show !== 'wall' && (
          <div className={`swatch ${target === 'floor' ? 'active' : ''}`} onClick={() => setTarget('floor')}>
            <TileCanvas game={game} level={level} tile={project.tiles[brush.floorTile]} />
            <div>
              {floorLabel}
              <small>tile {brush.floorTile}</small>
            </div>
          </div>
        )}
        {show !== 'floor' && (
          <div className={`swatch ${target === 'wall' ? 'active alt' : ''}`} onClick={() => setTarget('wall')}>
            <TileCanvas game={game} level={level} tile={project.tiles[brush.wallTile]} />
            <div>
              {wallLabel}
              <small>tile {brush.wallTile}</small>
            </div>
          </div>
        )}
      </div>
      <TextureBank />
      <div className="tile-grid">
        {project.tiles.map((tile, i) => (
          <button key={i} className={`tile ${brush.floorTile === i ? 'selected' : ''} ${brush.wallTile === i ? 'selected alt' : ''}`} onClick={() => pick(i)} title={i >= project.baseTileCount ? `Tile ${i} (imported)` : `Tile ${i}`}>
            <TileCanvas game={game} level={level} tile={tile} />
            {i >= project.baseTileCount && <span className="badge">new</span>}
          </button>
        ))}
      </div>
    </>
  );
}

const WALL_HEIGHTS = [
  { value: 0.25, label: '¼' },
  { value: 0.5, label: '½' },
  { value: 1, label: 'Full' },
];

function WallOptions({ seeThrough = false }: { seeThrough?: boolean }) {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <>
      <Field label="Wall height">
        <div className="segmented">
          {WALL_HEIGHTS.map((h) => (
            <button key={h.value} className={brush.wallHeight === h.value ? 'active' : ''} onClick={() => setBrush({ wallHeight: h.value })}>
              {h.label}
            </button>
          ))}
        </div>
      </Field>
      {seeThrough && (
        <label className="check" style={{ margin: '2px 0 8px' }} title="Color 0 of the tile is transparent: glass, grilles">
          <input type="checkbox" checked={brush.wallSeeThrough} onChange={(e) => setBrush({ wallSeeThrough: e.target.checked })} /> See-through
        </label>
      )}
    </>
  );
}

function FloorOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <>
      <label className="check" title="Color 0 of the tile is transparent: grilles, grates">
        <input type="checkbox" checked={brush.floorSeeThrough} onChange={(e) => setBrush({ floorSeeThrough: e.target.checked })} /> See-through
      </label>
      <Field label="Tile turn">
        <div className="row">
          <div className="segmented">
            {[0, 1, 2, 3].map((t) => (
              <button key={t} className={brush.floorTurn === t ? 'active' : ''} onClick={() => setBrush({ floorTurn: t as 0 | 1 | 2 | 3 })}>
                {t * 90}°
              </button>
            ))}
          </div>
        </div>
      </Field>
    </>
  );
}

const BLOCK_HEIGHTS = [
  { value: 0.25, label: '¼' },
  { value: 0.5, label: '½' },
  { value: 0.75, label: '¾' },
  { value: 1, label: 'Full' },
];

function BlockOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <>
      <Field label="Height">
        <div className="segmented">
          {BLOCK_HEIGHTS.map((h) => (
            <button key={h.value} className={brush.blockHeight === h.value ? 'active' : ''} onClick={() => setBrush({ blockHeight: h.value })}>
              {h.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Width">
        <div className="segmented">
          {BLOCK_HEIGHTS.map((w) => (
            <button key={w.value} className={(brush.blockPillar ? brush.blockWidth : 1) === w.value ? 'active' : ''} onClick={() => setBrush({ blockPillar: w.value < 1, blockWidth: w.value })}>
              {w.label}
            </button>
          ))}
        </div>
      </Field>
    </>
  );
}

function RampOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const labels: Record<RampDirection, string> = { east: 'East →', south: 'South ↓', west: 'West ←', north: 'North ↑' };
  return (
    <>
      <Field label="Rises">
        <div className="row">
          <select value={brush.rampDirection} onChange={(e) => setBrush({ rampDirection: e.target.value as RampDirection })}>
            {RAMP_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {labels[d]}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <label className="check" style={{ margin: '4px 0 10px' }}>
        <input type="checkbox" checked={brush.rampSides} onChange={(e) => setBrush({ rampSides: e.target.checked })} />
        Closed sides
      </label>
    </>
  );
}

/* ------------------------------------------------------------- entities */

const ENTITY_TABS: EntityCategory[] = ['player', 'robot', 'creature', 'human', 'vehicle', 'turret', 'boss', 'pickup', 'objective', 'effect', 'marker', 'decor'];

interface EntityRow {
  e: EntityInfo;
  available: boolean;
  /** The scenery cell it stands on in the retail level, when this row places both. */
  base: EntityBase | null;
  /** True for the plain row of an entity that also has a with-base row. */
  bare: boolean;
}

/** The map's own effects: click to place, double-click or Edit to change. */
function EffectsList({ designing }: { designing: (effect: CustomEffect | 'new') => void }) {
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <div className="section custom-list" style={{ marginBottom: 10 }}>
      <h3>
        Your effects
        <button className="small right" onClick={() => designing('new')}>
          <Icon name="plus" size={13} /> New effect
        </button>
      </h3>
      <div className="entity-list">
        {project.effects.map((f) => (
          <button key={f.id} className={`entity-row ${brush.effect === f.id ? 'selected' : ''}`} onClick={() => setBrush({ effect: f.id, entityType: CUSTOM_EFFECT_TYPE })} onDoubleClick={() => designing(f)} title="Double-click to edit">
            <Icon name="spark" size={22} />
            <span className="name">
              {f.name}
              <br />
              <small>{f.particles.map((p) => particleName(p.fx)).join(' + ')}</small>
            </span>
            <span className="small ghost edit-link" role="button" onClick={(ev) => (ev.stopPropagation(), designing(f))}>
              Edit
            </span>
          </button>
        ))}
      </div>
      {!project.effects.length && <div className="empty">None yet.</div>}
    </div>
  );
}

function EntityPalette() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const [category, setCategory] = useState<EntityCategory | 'all' | 'custom'>('robot');
  const [choosingBase, setChoosingBase] = useState(false);
  const [search, setSearch] = useState('');
  const [customizing, setCustomizing] = useState<CustomType | null>(null);
  const [designing, setDesigning] = useState<CustomEffect | 'new' | null>(null);
  useEditor((s) => s.revision);
  const looks = projectLooks(project);
  const level = project.baseLevel;
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows: EntityRow[] = [];
    const matching = game.entities
      .filter((e) => (q ? e.name.toLowerCase().includes(q) || typeName(game, project, e.type).toLowerCase().includes(q) || String(e.type) === q : category === 'all' || e.category === category))
      .map((e) => ({ e, available: game.entityAvailableIn(e.type, level) }))
      .sort((a, b) => Number(b.available) - Number(a.available) || a.e.type - b.e.type);
    for (const { e, available } of matching) {
      const base = available ? game.entityBase(e.type, level) : null;
      // The complete assembly comes first; the bare sprite stays available for building freely.
      if (base) rows.push({ e, available, base, bare: false });
      rows.push({ e, available, base: null, bare: !!base });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, category, search, level, project.customTypes.length]);
  // What a new custom enemy can start from: anything that fights and is drawn in this theme.
  const bases = useMemo(() => game.entities.filter((e) => canCustomize(e) && game.entityAvailableIn(e.type, level) && !project.customTypes.some((t) => t.type === e.type)), [game, level, project.customTypes]);
  const customCount = project.customTypes.length + project.effects.length;
  const selected = game.entity(brush.entityType);
  const selectedCustom = project.customTypes.find((t) => t.type === brush.entityType);
  const pick = (e: EntityInfo, withBase = false) => setBrush({ entityType: e.type, entityBehavior: e.behaviors[0]?.selector ?? 0, entityWeapon: 0, entityWithBase: withBase, effect: null });
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="grow" placeholder="Search entities…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!search && (
        <div className="tabs">
          <button className={`custom-tab ${category === 'custom' ? 'active' : ''}`} onClick={() => setCategory('custom')} title="Your own enemies and effects">
            <Icon name="plus" size={12} /> Custom{customCount ? ` ${customCount}` : ''}
          </button>
          {ENTITY_TABS.map((c) => (
            <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      )}
      {designing && <CustomEffectDialog initial={designing === 'new' ? null : designing} onClose={() => setDesigning(null)} />}
      {category === 'custom' && !search ? (
        <>
          <div className="section custom-list" style={{ marginBottom: 10 }}>
            <h3>
              Enemies
              <button className="small right" onClick={() => setChoosingBase(!choosingBase)} disabled={!bases.length}>
                <Icon name="plus" size={13} /> New enemy
              </button>
            </h3>
            {choosingBase && (
              <>
                <div className="dim" style={{ margin: '2px 0 6px' }}>
                  Start from:
                </div>
                <div className="entity-list" style={{ marginBottom: 10 }}>
                  {bases.map((e) => (
                    <button
                      key={e.type}
                      className="entity-row"
                      onClick={() => {
                        setChoosingBase(false);
                        pick(e);
                        setCustomizing(newCustomType(e));
                      }}
                    >
                      <EntityThumb game={game} type={e.type} level={level} looks={looks} />
                      <span className="name">
                        {e.name}
                        <br />
                        <small>{e.descriptor?.maxHealth} HP</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="entity-list">
              {project.customTypes.map((t) => {
                const e = game.entity(t.type);
                if (!e) return null;
                return (
                  <button key={t.type} className={`entity-row ${brush.effect === null && brush.entityType === t.type ? 'selected' : ''}`} onClick={() => pick(e)} onDoubleClick={() => setCustomizing(t)} title="Double-click to edit">
                    <EntityThumb game={game} type={t.type} level={level} looks={looks} />
                    <span className="name">
                      {t.name}
                      <br />
                      <small>
                        {e.name} · {t.health ?? e.descriptor?.maxHealth} HP
                      </small>
                    </span>
                    <span className="small ghost edit-link" role="button" onClick={(ev) => (ev.stopPropagation(), setCustomizing(t))}>
                      Edit
                    </span>
                  </button>
                );
              })}
            </div>
            {!project.customTypes.length && !choosingBase && <div className="empty">None yet.</div>}
          </div>
          <EffectsList designing={setDesigning} />
        </>
      ) : (
        <>
          {category === 'effect' && !search && <EffectsList designing={setDesigning} />}
          {selected && canCustomize(selected) && brush.effect === null && (
            <div className="row" style={{ marginBottom: 10 }}>
              <button className="grow" onClick={() => setCustomizing(selectedCustom ?? newCustomType(selected))}>
                {selectedCustom ? `Edit "${selectedCustom.name}"…` : `Customize ${selected.name}…`}
              </button>
            </div>
          )}
      <div className="entity-list">
        {list.map(({ e, available, base, bare }) => {
          const withBase = !!base;
          const isSelected = brush.effect === null && brush.entityType === e.type && (!(base || bare) || brush.entityWithBase === withBase);
          return (
            <button
              key={`${e.type}${withBase ? '+' : ''}`}
              className={`entity-row ${isSelected ? 'selected' : ''} ${available ? '' : 'unavailable'}`}
              onClick={() => pick(e, withBase)}
              title={
                !available
                  ? `${e.name}: its sprites (${e.sprite}) are not loaded by the ${level} theme, so it would be invisible or wrong in game`
                  : withBase
                    ? `${e.name} together with the piece of scenery it stands on in ${level} (cell ${base!.definitionId})`
                    : bare
                      ? `${e.name} by itself, for standing on something of your own`
                      : e.name
              }
            >
              <EntityThumb game={game} type={e.type} level={level} looks={looks} />
              <span className="name">
                {typeName(game, project, e.type)}
                {withBase ? ' + stand' : bare ? ' alone' : ''}
                <br />
                <small>
                  type {e.type}
                  {e.descriptor?.maxHealth ? ` · ${e.descriptor.maxHealth} HP` : ''}
                </small>
              </span>
              {!available && <span className="pill warn">other theme</span>}
              {withBase && <span className="pill ok">complete</span>}
            </button>
          );
        })}
        {!list.length && <div className="empty">Nothing matches.</div>}
      </div>
        </>
      )}
      {customizing && <CustomTypeDialog initial={customizing} onClose={() => setCustomizing(null)} />}
      {category !== 'custom' && brush.effect === null && selected && selected.behaviors.length > 1 && (
        <div className="section" style={{ marginTop: 12 }}>
          <h3>Placed as</h3>
          <Field label="Behavior">
            <select value={brush.entityBehavior} onChange={(e) => setBrush({ entityBehavior: Number(e.target.value) })}>
              {selected.behaviors.map((b) => (
                <option key={b.selector} value={b.selector}>
                  {b.selector} · used {b.placements}×
                </option>
              ))}
            </select>
          </Field>
          {selected.category === 'robot' && (
            <Field label="Weapon level">
              <select value={brush.entityWeapon} onChange={(e) => setBrush({ entityWeapon: Number(e.target.value) })}>
                <option value={0}>1</option>
                <option value={1}>2</option>
                <option value={2}>3</option>
              </select>
            </Field>
          )}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- doors */

function DoorOptions() {
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  useEditor((s) => s.revision);
  return (
    <>
      <Field label="Opens">
        <LockSelect project={project} value={brush.doorLock} onChange={(doorLock) => setBrush({ doorLock })} />
      </Field>
      <Field label="Opens by">
        <select value={brush.doorStyle} onChange={(e) => setBrush({ doorStyle: e.target.value as DoorStyle })}>
          <option value="rise">Rising</option>
          <option value="slide">Sliding</option>
          <option value="sink">Sinking</option>
        </select>
      </Field>
      <Field label="Walk through">
        <select value={brush.doorFacing} onChange={(e) => setBrush({ doorFacing: e.target.value as 'ns' | 'ew' })}>
          <option value="ns">North–south</option>
          <option value="ew">East–west</option>
        </select>
      </Field>
      {brush.doorLock >= 1 && brush.doorLock <= KEY_COUNT && <p className="hint">Key {brush.doorLock} is in Entities → Pickups.</p>}
      <Materials show="wall" wallLabel="Door" />
    </>
  );
}

/* ----------------------------------------------------------- breakables */

/** How tough a breakable is: retail levels use 1 up to 60. */
const TOUGHNESS = [
  { value: 1, label: 'One shot' },
  { value: 10, label: 'Weak' },
  { value: 30, label: 'Normal' },
  { value: 60, label: 'Tough' },
];

/** The destruction effects known by sight; the rest go by number. */
const EFFECT_NAMES: Record<number, string> = { 8: 'Rubble', 26: 'Big explosion (hurts)' };

function EffectSelect({ value, onChange }: { value: number; onChange: (effect: number) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: 32 }, (_, i) => i)
        .sort((a, b) => Number(!(a in EFFECT_NAMES)) - Number(!(b in EFFECT_NAMES)) || a - b)
        .map((i) => (
          <option key={i} value={i}>
            {EFFECT_NAMES[i] ?? `Effect ${i}`}
          </option>
        ))}
    </select>
  );
}

function BreakableOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <>
      <Field label="Toughness">
        <select value={brush.breakToughness} onChange={(e) => setBrush({ breakToughness: Number(e.target.value) })}>
          {TOUGHNESS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
          {!TOUGHNESS.some((t) => t.value === brush.breakToughness) && <option value={brush.breakToughness}>{brush.breakToughness}</option>}
        </select>
      </Field>
      <Field label="Effect">
        <EffectSelect value={brush.breakEffect} onChange={(breakEffect) => setBrush({ breakEffect })} />
      </Field>
      <Field label="Becomes">
        <select value={brush.breakResult} onChange={(e) => setBrush({ breakResult: e.target.value as 'floor' | 'broken' })}>
          <option value="broken">Broken version</option>
          <option value="floor">Rubble floor</option>
        </select>
      </Field>
      {brush.breakResult === 'broken' ? <Materials show="wall" wallLabel="Broken" /> : <Materials show="floor" floorLabel="Rubble" />}
    </>
  );
}

/* ------------------------------------------------------------- triggers */

const PICKS: { pick: TriggerPick; label: string; icon: string }[] = [
  { pick: 'break', label: 'Break', icon: 'erase' },
  { pick: 'retexture', label: 'Retexture', icon: 'paint' },
  { pick: 'effect', label: 'Effect', icon: 'spark' },
  { pick: 'reveal', label: 'Reveal', icon: 'entity' },
];

function TriggerOptions() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const channel = useEditor((s) => s.trigger);
  const pick = useEditor((s) => s.triggerPick);
  const setTrigger = useEditor((s) => s.setTrigger);
  const setTriggerPick = useEditor((s) => s.setTriggerPick);
  const edit = useEditor((s) => s.edit);
  const brush = useEditor((s) => s.brush);
  useEditor((s) => s.revision);
  const channels = triggerChannels(project);
  const trigger = channel !== null ? project.triggers.find((t) => t.channel === channel) : undefined;
  const level = project.baseLevel;

  // The open trigger may have gone (undo, deleted): fall back to the first.
  useEffect(() => {
    if (channel !== null && !channels.includes(channel)) setTrigger(channels[0] ?? null);
    else if (channel === null && channels.length) setTrigger(channels[0]);
  }, [channel, channels.join(), setTrigger]);

  const create = () => {
    const free = freeSwitchChannel(project);
    if (free === null) return useApp.getState().toast('The game has room for 26 triggers.', 'error');
    edit((p) => void ensureTrigger(p, free));
    setTrigger(free);
  };
  const change = (mutate: (t: Trigger) => void) => edit((p) => mutate(ensureTrigger(p, channel!)));
  const doors = channel !== null ? doorsWithLock(project, channel) : 0;

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="grow" value={channel ?? ''} onChange={(e) => setTrigger(Number(e.target.value))} disabled={!channels.length}>
          {!channels.length && <option value="">No triggers</option>}
          {channels.map((c) => (
            <option key={c} value={c}>
              {triggerName(project, c)}
            </option>
          ))}
        </select>
        <button className="small" onClick={create} title="New trigger">
          <Icon name="plus" size={13} /> New
        </button>
      </div>
      {channel !== null && (
        <>
          <Field label="Name">
            <input value={trigger?.name ?? triggerName(project, channel)} maxLength={32} onChange={(e) => change((t) => void (t.name = e.target.value))} />
          </Field>
          <label className="check" style={{ margin: '2px 0 8px' }}>
            <input type="checkbox" checked={trigger?.once ?? false} onChange={(e) => change((t) => void (t.once = e.target.checked))} /> Only once
          </label>
          <div className="trigger-summary">
            <span className={pick === 'pads' ? 'active' : ''} role="button" onClick={() => setTriggerPick('pads')}>
              <Icon name="marker" size={13} /> {padCount(project, channel)} pad{padCount(project, channel) === 1 ? '' : 's'}
            </span>
            <span>
              <Icon name="door" size={13} /> {doors} door{doors === 1 ? '' : 's'}
            </span>
          </div>
          <h3 className="section-title" style={{ marginTop: 12 }}>
            Actions
          </h3>
          <div className="action-list">
            {(trigger?.actions ?? []).map((a, i) => (
              <div key={i} className="action-row">
                <span className="grow">{describeAction(project, game, a)}</span>
                {a.kind === 'retexture' && (
                  <>
                    <select value={a.faces} onChange={(e) => change((t) => void ((t.actions[i] as typeof a).faces = e.target.value as TriggerFaces))} title="Which faces">
                      <option value="walls">Walls</option>
                      <option value="floor">Floor</option>
                      <option value="all">All</option>
                    </select>
                    <button className="tile small-tile" title="Use the chosen texture" onClick={() => change((t) => void ((t.actions[i] as typeof a).tile = brush.wallTile))}>
                      <TileCanvas game={game} level={level} tile={project.tiles[a.tile & 0x3fff]} />
                    </button>
                  </>
                )}
                {a.kind === 'effect' && (
                  <select value={a.effect} onChange={(e) => change((t) => void ((t.actions[i] as typeof a).effect = Number(e.target.value)))}>
                    {project.effects.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
                <button className="small ghost icon" title="Remove" onClick={() => change((t) => void t.actions.splice(i, 1))}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            {!trigger?.actions.length && <div className="empty">None yet</div>}
          </div>
          <div className="add-actions">
            {PICKS.map((p) => (
              <button key={p.pick} className={`small ${pick === p.pick ? 'primary' : ''}`} onClick={() => setTriggerPick(pick === p.pick ? 'pads' : p.pick)} title={`Add: click the map`}>
                <Icon name={p.icon} size={13} /> {p.label}
              </button>
            ))}
          </div>
          {pick !== 'pads' && <p className="hint" style={{ marginTop: 6 }}>Click the map. Esc cancels.</p>}
          {pick === 'retexture' && <Materials show="wall" wallLabel="New texture" />}
          <button
            className="small danger"
            style={{ marginTop: 12 }}
            onClick={() => {
              if (!window.confirm(`Delete "${triggerName(project, channel)}", its pads and its actions? Its doors will open on touch.`)) return;
              edit((p) => removeTrigger(p, channel));
              setTrigger(null);
            }}
          >
            <Icon name="trash" size={14} /> Delete trigger
          </button>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- hazard */

function HazardOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <Field label="Damage">
      <NumberInput value={brush.hazardDamage} min={1} max={254} onChange={(hazardDamage) => setBrush({ hazardDamage })} />
    </Field>
  );
}

/* ----------------------------------------------------------- interactive */

function InteractivePanel() {
  const tab = useEditor((s) => s.brush.interactive);
  const setBrush = useEditor((s) => s.setBrush);
  return (
    <>
      <div className="tabs">
        {INTERACTIVE_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setBrush({ interactive: t.id })} title={t.key ? `${t.label} (${t.key})` : t.label}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'doors' && <DoorOptions />}
      {tab === 'breakables' && <BreakableOptions />}
      {tab === 'triggers' && <TriggerOptions />}
      {tab === 'hazard' && <HazardOptions />}
    </>
  );
}

/* ---------------------------------------------------------------- props */

function PropThumb({ thumbs, def, selected, onClick, title, badge }: { thumbs: PropThumbs; def: CellDefinition; selected: boolean; onClick: () => void; title: string; badge?: string }) {
  const url = usePropThumb(thumbs, def);
  return (
    <button className={`prop ${selected ? 'selected' : ''}`} onClick={onClick} title={title}>
      {url && <img src={url} alt="" draggable={false} />}
      {badge && <span className="badge">{badge}</span>}
    </button>
  );
}

interface PropEntry {
  id: number;
  def: CellDefinition;
  category: PropCategory;
  height: number;
  /** How many cells of the retail level use this shape. */
  uses: number;
}

function PropLibrary() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const editLibrary = useEditor((s) => s.editLibrary);
  const setEditingModel = useEditor((s) => s.setEditingModel);
  const libraryRevision = useEditor((s) => s.libraryRevision);
  const [source, setSource] = useState<'retail' | 'project' | 'models'>(project.models.length ? 'models' : 'retail');
  const [category, setCategory] = useState<PropCategory>('block');
  const level = project.baseLevel;

  // Props built in the Workshop are compiled the way the map compiler does it, so their thumbnails show baked textures.
  const composer = useMemo(
    () => (project.models.length ? new ProjectComposer(project, { preview: true, opaqueZeroIndex: game.level(level).opaqueZeroIndex }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, libraryRevision, game, level],
  );
  const definitions = composer?.definitions ?? project.definitions;
  const thumbs = sharedPropThumbs(level, game.level(level).palette, composer?.tiles ?? project.tiles);

  // Distinct shapes of the theme level's own cells, most used first.
  const retail = useMemo(() => {
    const map = game.levelMap(level);
    const uses = new Uint32Array(map.definitions.length);
    for (const g of map.groups) for (const l of g.layers) for (const word of l.cells) uses[word & 0x7ff]++;
    const byShape = new Map<string, PropEntry>();
    map.definitions.forEach((def, id) => {
      if (!id || !def.commands.length) return;
      const key = geometryKey(def);
      const existing = byShape.get(key);
      if (existing) existing.uses += uses[id];
      else byShape.set(key, { id, def, uses: uses[id], ...classifyProp(def) });
    });
    return [...byShape.values()].sort((a, b) => b.uses - a.uses || a.id - b.id);
  }, [game, level]);

  const modelIds = new Set(project.models.map((m) => m.definitionId));
  const mine = definitions.map((def, id) => ({ id, def, uses: 0, ...classifyProp(def) })).filter((e) => e.id > 0 && e.def.commands.length && !modelIds.has(e.id));

  const all = source === 'project' ? mine : retail;
  const counts: Record<PropCategory, number> = { floor: 0, wall: 0, block: 0, ramp: 0, special: 0 };
  for (const e of all) counts[e.category]++;
  const list = all.filter((e) => e.category === category);

  const pickRetail = (id: number, def: CellDefinition) => {
    const existing = project.definitionSources.indexOf(`${level} #${id}`);
    if (existing > 0) return setBrush({ prop: existing });
    let added = 0;
    editLibrary((p) => void (added = importProp(p, level, id, def)));
    setBrush({ prop: added });
  };

  const newModel = () => {
    let id = -1;
    let definition = 0;
    editLibrary((p) => {
      const model = createModel(p, brush.wallTile);
      id = model.id;
      definition = model.definitionId;
    });
    setBrush({ prop: definition });
    setEditingModel(id);
  };

  return (
    <>
      <button className="new-prop" onClick={newModel}>
        <Icon name="cube" size={16} /> New prop
      </button>
      <Field label="Place">
        <div className="segmented">
          <button className={brush.propMode === 'over' ? 'active' : ''} onClick={() => setBrush({ propMode: 'over' })} title="Stand it on what is already in the cell">
            On top
          </button>
          <button className={brush.propMode === 'replace' ? 'active' : ''} onClick={() => setBrush({ propMode: 'replace' })} title="Replace everything in the cell, floor included">
            Replace
          </button>
        </div>
      </Field>
      <div className="tabs" style={{ marginTop: 6 }}>
        <button className={`custom-tab ${source === 'models' ? 'active' : ''}`} onClick={() => setSource('models')}>
          Custom{project.models.length ? <small>{project.models.length}</small> : null}
        </button>
        <button className={source === 'retail' ? 'active' : ''} onClick={() => setSource('retail')}>
          {level} <small>{retail.length}</small>
        </button>
        <button className={source === 'project' ? 'active' : ''} onClick={() => setSource('project')}>
          In this map <small>{mine.length}</small>
        </button>
      </div>

      {source === 'models' ? (
        <>
          <div className="prop-grid">
            <button className="prop add" onClick={newModel} title="Build a new prop">
              <Icon name="plus" size={22} />
            </button>
            {project.models.map((m) => (
              <div key={m.id} style={{ position: 'relative' }}>
                <PropThumb thumbs={thumbs} def={definitions[m.definitionId]} selected={brush.prop === m.definitionId} title={`${m.name} · ${definitions[m.definitionId].commands.length} faces`} onClick={() => setBrush({ prop: m.definitionId })} />
                <span className="prop" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'none', border: 0 }}>
                  <span className="edit" style={{ pointerEvents: 'auto' }} role="button" onClick={() => setEditingModel(m.id)}>
                    Edit
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="tabs">
            {PROP_CATEGORIES.map((c) => (
              <button key={c.id} className={category === c.id ? 'active' : ''} disabled={!counts[c.id]} onClick={() => setCategory(c.id)} title={c.hint}>
                {c.label} <small>{counts[c.id]}</small>
              </button>
            ))}
          </div>
          <div className="prop-grid">
            {list.slice(0, 400).map(({ id, def, height, uses }) => (
              <PropThumb
                key={`${source}${id}`}
                thumbs={thumbs}
                def={def}
                selected={source === 'project' ? brush.prop === id : project.definitionSources[brush.prop] === `${level} #${id}`}
                title={`${source === 'project' ? (project.definitionSources[id] ?? `Prop ${id}`) : `${level} cell ${id}`}${height > 0.03 ? ` · ${height.toFixed(2)} cells tall` : ''}${uses ? ` · used ${uses}× in ${level}` : ''}`}
                badge={source === 'retail' && uses > 1 ? `${uses}×` : undefined}
                onClick={() => (source === 'project' ? setBrush({ prop: id }) : pickRetail(id, def))}
              />
            ))}
          </div>
          {!list.length && <div className="empty">None.</div>}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- paths */

const PATH_MODES = [
  { value: PATH_BACK_AND_FORTH, label: 'Back and forth' },
  { value: PATH_LOOP, label: 'Loop' },
  // Retail mode 0. Tried in the game with a robot, a person and a tank: none of them moves, so it is
  // only listed for paths that already use it (retail maps opened for editing).
  { value: PATH_ONCE, label: 'Stay at the first point' },
  { value: PATH_ZONE, label: 'Wander in a zone' },
];

/** The four things the engine does with a path, whatever raw mode number a retail map used. */
const pathMode = (word0: number): number => (word0 === PATH_ONCE || word0 === PATH_BACK_AND_FORTH || word0 === PATH_ZONE ? word0 : PATH_LOOP);

function PathOptions() {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const group = useEditor((s) => s.group);
  const selectedPath = useEditor((s) => s.selectedPath);
  const setSelectedPath = useEditor((s) => s.setSelectedPath);
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const edit = useEditor((s) => s.edit);
  const setActive = useEditor((s) => s.setActive);
  useEditor((s) => s.revision);
  const path = project.paths.find((p) => p.id === selectedPath) ?? null;
  const followers = path ? pathFollowers(project, path.id) : [];
  const here = project.paths.filter((p) => p.group === group);
  const mode = path ? pathMode(path.word0) : brush.pathMode;

  const setMode = (next: number) => {
    setBrush({ pathMode: next });
    if (!path) return;
    edit((p) => {
      const target = p.paths.find((x) => x.id === path.id)!;
      // A zone is three corner points, a route any number of stops: one cannot become the other.
      if ((next === PATH_ZONE) !== (pathMode(target.word0) === PATH_ZONE)) target.points = [];
      target.word0 = next;
      // Followers switch to the behavior that goes with the new kind of path.
      for (const e of pathFollowers(p, target.id)) {
        const habit = game.pathBehavior(e.type, next === PATH_ZONE ? 'zone' : 'route');
        if (habit) e.behavior = habit.behavior;
      }
    });
  };

  return (
    <>
      <Field label="Type">
        <select value={mode} onChange={(e) => setMode(Number(e.target.value))}>
          {PATH_MODES.filter((m) => m.value !== PATH_ONCE || mode === PATH_ONCE).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      {path ? (
        <div className="section">
          <h3>
            Path {path.id}
            <button className="small ghost" onClick={() => setSelectedPath(null)} title="Stop editing this path (Esc)">
              Done
            </button>
          </h3>
          <p className="hint" style={{ marginBottom: 8 }}>
            {mode === PATH_ZONE ? (path.points.length === 3 ? 'Drag to move the zone.' : 'Drag a rectangle for the zone.') : `${path.points.length} point${path.points.length === 1 ? '' : 's'}`}
          </p>
          {path.points.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <WalkButton pathId={path.id} />
            </div>
          )}
          {followers.map((e) => (
            <div key={e.id} className="overlay-row">
              <EntityThumb game={game} type={e.type} level={project.baseLevel} size={26} />
              <span className="grow">
                {game.entity(e.type)?.name ?? `Type ${e.type}`}
              </span>
              <button className="small ghost icon" title="Take it off this path" onClick={() => edit((p) => void (pathFollowers(p, path.id).find((x) => x.id === e.id)!.pathId = null))}>
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          {!followers.length && <p className="hint">No followers. Shift+click an entity to add one.</p>}
          <button
            className="small danger"
            style={{ marginTop: 8 }}
            onClick={() => {
              edit((p) => removePath(p, path.id));
              setSelectedPath(null);
            }}
          >
            <Icon name="trash" size={14} /> Delete path
          </button>
        </div>
      ) : (
        <p className="hint" style={{ marginBottom: 10 }}>
          Click an entity to start.
        </p>
      )}
      {here.length > 0 && (
        <div className="section">
          <h3>Paths</h3>
          <div className="entity-list">
            {here.map((p) => {
              const who = pathFollowers(project, p.id);
              return (
                <button
                  key={p.id}
                  className={`entity-row ${p.id === selectedPath ? 'selected' : ''}`}
                  style={{ gridTemplateColumns: '1fr auto' }}
                  onClick={() => {
                    setActive(p.group, Math.max(0, p.layer));
                    setSelectedPath(p.id);
                  }}
                >
                  <span className="name">
                    Path {p.id} · {PATH_MODES.find((m) => m.value === pathMode(p.word0))!.label.toLowerCase()}
                    <br />
                    <small>
                      {p.points.length} points · layer {p.layer + 1} · {who.length ? who.map((e) => game.entity(e.type)?.name ?? e.type).join(', ') : 'no followers'}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- light */

function LightOptions() {
  const brush = useEditor((s) => s.brush);
  const setBrush = useEditor((s) => s.setBrush);
  const edit = useEditor((s) => s.edit);
  const group = useEditor((s) => s.group);
  const layer = useEditor((s) => s.layer);
  return (
    <>
      <Field label="Brightness">
        <div className="row">
          <input className="grow" type="range" min={0} max={31} value={brush.lightLevel} title="0 black · 22 true color · 31 overlit" onChange={(e) => setBrush({ lightLevel: Number(e.target.value) })} />
          <span className="mono" style={{ width: 22, textAlign: 'right' }}>
            {brush.lightLevel}
          </span>
        </div>
      </Field>
      <Field label="Size">
        <div className="row">
          <input className="grow" type="range" min={1} max={10} step={0.5} value={brush.lightRadius} onChange={(e) => setBrush({ lightRadius: Number(e.target.value) })} />
          <span className="mono" style={{ width: 22, textAlign: 'right' }}>
            {brush.lightRadius}
          </span>
        </div>
      </Field>
      <button onClick={() => edit((p) => fillLight(p.groups[group].layers[layer], brush.lightLevel))} title="Set the whole layer to this brightness">
        Fill layer
      </button>
    </>
  );
}

/* --------------------------------------------------------------- panel */

export function Catalog() {
  const tool = useEditor((s) => s.tool);
  const tab = useEditor((s) => s.brush.interactive);
  const base = TOOLS.find((t) => t.id === tool)!;
  const info = tool === 'interactive' ? { ...base, mods: INTERACTIVE_TABS.find((t) => t.id === tab)?.mods } : base;
  return (
    <div className="catalog">
      <header>
        <div className="row">
          <Icon name={info.icon} />
          <h2>{info.label}</h2>
          <span className="kbd right">{info.key}</span>
        </div>
        {info.mods && (
          <div className="mods">
            {info.mods.map(([key, what]) => (
              <span key={key}>
                <span className="kbd">{key}</span> {what}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="content">
        {tool === 'room' && (
          <>
            <WallOptions />
            <FloorOptions />
            <Materials show="both" />
          </>
        )}
        {tool === 'floor' && (
          <>
            <FloorOptions />
            <Materials show="floor" />
          </>
        )}
        {tool === 'wall' && (
          <>
            <WallOptions seeThrough />
            <Materials show="wall" />
          </>
        )}
        {tool === 'block' && (
          <>
            <BlockOptions />
            <Materials show="both" floorLabel="Top" wallLabel="Sides" />
          </>
        )}
        {tool === 'ramp' && (
          <>
            <RampOptions />
            <Materials show="both" floorLabel="Slope" wallLabel="Sides" />
          </>
        )}
        {tool === 'paint' && (
          <>
            <Materials show="both" floorLabel="Flat" wallLabel="Upright" />
          </>
        )}
        {tool === 'entity' && <EntityPalette />}
        {tool === 'path' && <PathOptions />}
        {tool === 'prop' && <PropLibrary />}
        {tool === 'light' && <LightOptions />}
        {tool === 'interactive' && <InteractivePanel />}
      </div>
    </div>
  );
}
