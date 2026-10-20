/** Right-hand panel of the builder: areas and layers, the selection, map settings and checks. */
import { type CellBehaviorSpec, DEFAULT_BREAKABLE, type Entity, type Issue, MAX_GROUPS, type MapProject, PATH_BACK_AND_FORTH, PATH_ONCE, PATH_ZONE, allocateId, compileProject, CompileError, createLayer, resizeLayer, validateProject, KEY_COUNT, KEY_PICKUP_TYPES, TEXTURE_MASKED, withLayerConnections } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { givePath } from '../actions.ts';
import { createPath, describeCell, pillarFloor, removeGroup, removeLayer } from '../editor/ops.ts';
import { projectLooks, typeName } from '../game/looks.ts';
import { CustomEffectDialog, particleName } from './CustomEffect.tsx';
import { LockSelect } from './LockSelect.tsx';
import { doorsWithLock, freeSwitchChannel, mapSwitches, switchNumber } from '../editor/doors.ts';
import type { CustomEffect, DoorStyle } from '@mh/core';
import { audioFileToWav, playRaw, playWav, wavSeconds } from '../game/audio.ts';
import { useApp, useGame } from '../state/app.ts';
import { type Selection, useEditor } from '../state/editor.ts';
import { EntityThumb, Field, NumberInput, TileCanvas } from '../ui/common.tsx';
import { WalkButton } from './WalkButton.tsx';
import { Icon } from '../ui/icons.tsx';

/** Characters that can be made friendly: anything that fights, but not the player. */
const FRIEND_CATEGORIES = new Set(['robot', 'creature', 'human', 'vehicle', 'turret', 'boss']);
const canBeFriend = (info: { type: number; category: string } | undefined): boolean => !!info && info.type > 1 && FRIEND_CATEGORIES.has(info.category);

/* ------------------------------------------------------ areas & layers */

function Structure() {
  const project = useEditor((s) => s.project)!;
  const group = useEditor((s) => s.group);
  const layer = useEditor((s) => s.layer);
  const setActive = useEditor((s) => s.setActive);
  const edit = useEditor((s) => s.edit);
  useEditor((s) => s.revision);
  const layers = project.groups[group].layers;
  const active = layers[layer];
  const [size, setSize] = useState({ width: active.width, height: active.height });
  useEffect(() => setSize({ width: active.width, height: active.height }), [active.width, active.height, group, layer]);

  const addStorey = () => {
    edit((p) => {
      const ls = p.groups[group].layers;
      const top = ls[ls.length - 1];
      const next = createLayer(`Layer ${ls.length + 1}`, top.width, top.height);
      next.originX = top.originX;
      next.originY = top.originY;
      ls.push(next);
    });
    setActive(group, layers.length);
  };
  const removeStorey = () => {
    if (layers.length < 2 || !window.confirm(`Delete "${active.name}" and everything on it?`)) return;
    let lost = 0;
    edit((p) => void (lost = removeLayer(p, group, layer)));
    setActive(group, Math.max(0, layer - 1));
    if (lost) useApp.getState().toast(`${lost} teleporter${lost === 1 ? '' : 's'} led onto that layer and ${lost === 1 ? 'was' : 'were'} removed.`, 'info');
  };
  const addArea = () => {
    edit((p) => void p.groups.push({ name: `Area ${p.groups.length + 1}`, layers: [createLayer('Ground', 24, 24)] }));
    setActive(project.groups.length, 0);
  };
  const removeArea = () => {
    if (project.groups.length < 2 || !window.confirm(`Delete "${project.groups[group].name}" and everything in it?`)) return;
    let lost = 0;
    edit((p) => void (lost = removeGroup(p, group)));
    setActive(0, 0);
    if (lost) useApp.getState().toast(`${lost} teleporter${lost === 1 ? '' : 's'} led into that area and ${lost === 1 ? 'was' : 'were'} removed.`, 'info');
  };

  return (
    <div className="block">
      <h3>
        Areas
        <button className="small ghost" disabled={project.groups.length >= MAX_GROUPS} onClick={addArea} title={project.groups.length >= MAX_GROUPS ? 'Three areas at most' : 'Add an area'}>
          <Icon name="plus" size={14} />
        </button>
      </h3>
      <div className="tabs">
        {project.groups.map((g, i) => (
          <button key={i} className={i === group ? 'active' : ''} onClick={() => setActive(i, 0)} title={i === project.initialGroup ? 'Start area' : undefined}>
            {g.name}
            {i === project.initialGroup ? ' ★' : ''}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="grow" value={project.groups[group].name} maxLength={32} onChange={(e) => edit((p) => void (p.groups[group].name = e.target.value))} />
        <button className="small" disabled={project.initialGroup === group} onClick={() => edit((p) => void (p.initialGroup = group))} title="Make this the start area">
          ★ Start
        </button>
        <button className="small icon danger" disabled={project.groups.length < 2} onClick={removeArea} title="Delete this area">
          <Icon name="trash" size={14} />
        </button>
      </div>

      <h3>
        Layers
        <button className="small ghost" onClick={addStorey} title="Add a layer">
          <Icon name="plus" size={14} />
        </button>
      </h3>
      {layers
        .map((l, i) => ({ l, i }))
        .reverse()
        .map(({ l, i }) => (
          <div key={i} className={`layer ${i === layer ? 'active' : ''}`} onClick={() => setActive(group, i)}>
            <span className="index">{i + 1}</span>
            <span className="grow">{l.name}</span>
            <span className="faint">
              {l.width}×{l.height}
            </span>
          </div>
        ))}
      <div style={{ marginTop: 8 }}>
        <Field label="Name">
          <input value={active.name} maxLength={32} onChange={(e) => edit((p) => void (p.groups[group].layers[layer].name = e.target.value))} />
        </Field>
        <Field label="Size">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <NumberInput value={size.width} min={1} max={128} width={50} onChange={(width) => setSize({ ...size, width })} />
            <span className="dim">×</span>
            <NumberInput value={size.height} min={1} max={128} width={50} onChange={(height) => setSize({ ...size, height })} />
            <button className="small" disabled={size.width === active.width && size.height === active.height} onClick={() => edit((p) => resizeLayer(p.groups[group].layers[layer], size.width, size.height))}>
              Resize
            </button>
          </div>
        </Field>
        <button className="small danger" disabled={layers.length < 2} onClick={removeStorey}>
          <Icon name="trash" size={14} /> Delete layer
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ selection */

/** Map type of the ambient sound emitter. */
const AMBIENT_TYPE = 39;

/** What an ambient emitter plays: one of the theme level's sounds, or one added to the map. */
function AmbientSound({ entity, change }: { entity: Entity; change: (patch: Partial<Entity>) => void }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const toast = useApp((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const profiles = game.ambientProfiles(project.baseLevel);
  const profile = profiles.find((p) => p.selector === entity.behavior);
  const custom = entity.sound ? project.sounds.find((s) => s.id === entity.sound!.id) : undefined;
  const value = entity.sound ? `custom:${entity.sound.id}` : `retail:${entity.behavior}`;

  const play = () => {
    if (custom) return playWav(custom.wav);
    if (profile?.sample_name && game.archive.has(profile.sample_name)) return playRaw(game.archive.read(profile.sample_name));
    toast('No preview for this sound.', 'info');
  };

  const add = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const wav = await audioFileToWav(file);
      let id = -1;
      edit((p) => {
        id = allocateId(p);
        p.sounds.push({ id, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), wav });
      });
      change({ sound: { id, delay: Math.max(2, Math.ceil(wavSeconds(wav)) + 2), random: 4 } });
    } catch (error) {
      toast(`Could not read that sound: ${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <Field label="Sound" stack>
        <div className="row">
          <select
            style={{ flex: 1, minWidth: 0, width: 0 }}
            value={value}
            onChange={(e) => {
              const [kind, n] = e.target.value.split(':');
              if (kind === 'add') input.current?.click();
              else if (kind === 'custom') change({ sound: { id: Number(n), delay: entity.sound?.delay ?? 6, random: entity.sound?.random ?? 4 } });
              else change({ sound: undefined, behavior: Number(n) });
            }}
          >
            <optgroup label={`Sounds of ${project.baseLevel}`}>
              {profiles.map((p) => (
                <option key={p.selector} value={`retail:${p.selector}`}>
                  {p.selector} · {p.sample_name ? p.sample_name.replace(/\.RAW$/i, '') : `sound ${p.sound_id}`}
                </option>
              ))}
              {!profile && !entity.sound && <option value={`retail:${entity.behavior}`}>{entity.behavior} · not defined for this level</option>}
            </optgroup>
            <optgroup label="Your own sounds">
              {project.sounds.map((s) => (
                <option key={s.id} value={`custom:${s.id}`}>
                  {s.name} ({wavSeconds(s.wav).toFixed(1)} s)
                </option>
              ))}
              <option value="add:0">{busy ? 'Converting…' : 'Add a sound file…'}</option>
            </optgroup>
          </select>
          <button className="small" onClick={play} title="Listen">
            <Icon name="sound" size={15} /> Play
          </button>
        </div>
      </Field>
      <input ref={input} type="file" accept="audio/*" hidden onChange={(e) => void add(e.target.files)} />
      {entity.sound ? (
        <>
          <Field label="Every">
            <div className="row">
              <NumberInput value={entity.sound.delay} min={0.2} max={600} step={0.5} onChange={(delay) => change({ sound: { ...entity.sound!, delay } })} />
              <span className="dim">seconds, plus up to</span>
              <NumberInput value={entity.sound.random} min={0} max={600} step={0.5} onChange={(random) => change({ sound: { ...entity.sound!, random } })} />
            </div>
          </Field>
        </>
      ) : (
        !profile && <p className="hint warn-text">Not a sound of the {project.baseLevel} theme.</p>
      )}
    </>
  );
}

/** The research notes on behaviors, in plain words (the Entities screen shows them in full). */
const plainNote = (note: string): string => {
  if (note.startsWith('record-aware initializer')) return 'Walks its path if it has one, otherwise fights.';
  if (note.startsWith('shutdown/inactive')) return 'Inactive.';
  if (note.includes('0x00410F20')) return 'Chases the nearest target.';
  if (note.includes('0x00410EA0')) return 'Moves on its own and attacks.';
  if (note.includes('0x00410E10')) return 'Goes for a target in range, otherwise walks to waypoints.';
  return '';
};

const describePath = (word0: number, points: number): string => (word0 === PATH_ZONE ? 'Zone' : `${word0 === PATH_ONCE ? 'Stays put' : word0 === PATH_BACK_AND_FORTH ? 'Back and forth' : 'Loop'}, ${points} points`);

function EntityDetails({ selection }: { selection: Extract<Selection, { kind: 'entity' }> }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const [editingEffect, setEditingEffect] = useState<CustomEffect | null>(null);
  useEditor((s) => s.revision);
  const layer = project.groups[selection.group]?.layers[selection.layer];
  const entity = layer?.entities.find((e) => e.id === selection.id);
  if (!layer || !entity) return <div className="empty">Nothing selected.</div>;
  const info = game.entity(entity.type);
  const change = (patch: Partial<typeof entity>) => edit((p) => Object.assign(p.groups[selection.group].layers[selection.layer].entities.find((e) => e.id === selection.id)!, patch));
  const behavior = info?.behaviors.find((b) => b.selector === entity.behavior);
  const path = entity.pathId !== null ? project.paths.find((p) => p.id === entity.pathId) : undefined;
  // The behavior the retail levels give this type when it has this kind of path.
  const habit = path ? game.pathBehavior(entity.type, path.word0 === PATH_ZONE ? 'zone' : 'route') : null;
  // Retail mode 0 reads like "walk once and stop", but in the game a robot, a person and a tank on
  // one all stand at its first point (scripts/game-test.ps1). The retail levels use it for tanks
  // and people that stay where they are.
  const standsStill = path?.word0 === PATH_ONCE;
  const ambient = entity.type === AMBIENT_TYPE;
  const custom = project.customTypes.find((t) => t.type === entity.type);
  // Following works by walking a route the runtime keeps moving, so a follower gets one, with the behavior that walks it.
  const setFriendly = (friendly: { follow: boolean } | null) =>
    edit((p) => {
      const l = p.groups[selection.group].layers[selection.layer];
      const e = l.entities.find((x) => x.id === selection.id)!;
      if (!friendly) {
        delete e.friendly;
        return;
      }
      e.friendly = friendly;
      if (friendly.follow && e.pathId === null) {
        const route = createPath(p, selection.group, selection.layer, PATH_BACK_AND_FORTH);
        route.points = [{ x: e.x, y: e.y, tail0: 0, tail1: 0 }, { x: e.x, y: e.y, tail0: 0, tail1: 0 }];
        e.pathId = route.id;
        const habit = game.pathBehavior(e.type, 'route');
        if (habit) e.behavior = habit.behavior;
      }
    });
  const placedEffect = entity.effect !== undefined ? project.effects.find((f) => f.id === entity.effect) : undefined;
  if (entity.effect !== undefined) {
    return (
      <>
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="grow">
            <b>{placedEffect?.name ?? 'Missing effect'}</b>
            <div className="dim">{placedEffect ? placedEffect.particles.map((p) => particleName(p.fx)).join(' + ') : 'Deleted'}</div>
          </div>
        </div>
        <Field label="Position">
          <span className="dim">
            {(entity.x / 256).toFixed(2)}, {(entity.y / 256).toFixed(2)}
          </span>
        </Field>
        <div className="row" style={{ marginTop: 8 }}>
          {placedEffect && <button onClick={() => setEditingEffect(placedEffect)}>Edit effect…</button>}
          <button className="ghost" onClick={() => edit((p) => void (p.groups[selection.group].layers[selection.layer].entities = p.groups[selection.group].layers[selection.layer].entities.filter((e) => e.id !== selection.id)))}>
            Remove
          </button>
        </div>
        {editingEffect && <CustomEffectDialog initial={editingEffect} onClose={() => setEditingEffect(null)} />}
      </>
    );
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <EntityThumb game={game} type={entity.type} level={project.baseLevel} size={52} looks={projectLooks(project)} />
        <div className="grow">
          <b>{placedEffect ? placedEffect.name : typeName(game, project, entity.type)}</b>
          <div className="dim">
            {custom ? `Custom ${info?.name ?? 'type'}` : `Type ${entity.type}`}
            {custom?.health ? ` · ${custom.health} HP` : info?.descriptor?.maxHealth ? ` · ${info.descriptor.maxHealth} HP` : ''}
            {info?.descriptor?.radius ? ` · radius ${(info.descriptor.radius / 256).toFixed(2)}` : ''}
          </div>
        </div>
      </div>
      <Field label="Position">
        <div className="row">
          <NumberInput value={Number((entity.x / 256).toFixed(2))} min={0} max={layer.width - 0.01} step={0.25} onChange={(v) => change({ x: Math.round(v * 256) })} />
          <NumberInput value={Number((entity.y / 256).toFixed(2))} min={0} max={layer.height - 0.01} step={0.25} onChange={(v) => change({ y: Math.round(v * 256) })} />
        </div>
      </Field>
      {ambient && <AmbientSound entity={entity} change={change} />}
      {!ambient && info && (info.behaviors.length > 1 || entity.behavior !== 0) && (
        <Field label="Behavior">
          <select value={entity.behavior} onChange={(e) => change({ behavior: Number(e.target.value) })}>
            {[...new Set([...info.behaviors.map((b) => b.selector), entity.behavior])]
              .sort((a, b) => a - b)
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                  {info.behaviors.find((b) => b.selector === s) ? ` · used ${info.behaviors.find((b) => b.selector === s)!.placements}×` : ' · unused in retail'}
                </option>
              ))}
          </select>
        </Field>
      )}
      {!ambient && behavior && plainNote(behavior.note) && <p className="hint">{plainNote(behavior.note)}</p>}
      {!ambient && (
        <Field label="Path">
          {path ? (
            <div className="row">
              <span className="grow dim">{describePath(path.word0, path.points.length)}</span>
              {path.points.length > 0 && <WalkButton pathId={path.id} />}
              <button
                className="small"
                onClick={() => {
                  useEditor.getState().setTool('path');
                  useEditor.getState().setSelectedPath(path.id);
                }}
              >
                Edit
              </button>
              <button className="small ghost icon" title="Remove from path" onClick={() => change({ pathId: null })}>
                <Icon name="close" size={13} />
              </button>
            </div>
          ) : (
            <button className="small" onClick={() => givePath(selection.group, selection.layer, entity.id)} title="Draw a route or a zone">
              <Icon name="path" size={14} /> Add path
            </button>
          )}
        </Field>
      )}
      {path && habit && habit.behavior !== entity.behavior && (
        <p className="hint">
          Usually behavior {habit.behavior} on this path.{' '}
          <button className="small" onClick={() => change({ behavior: habit.behavior })}>
            Use {habit.behavior}
          </button>
        </p>
      )}
      {standsStill && (
        <p className="hint warn-text">
          Won't move on this path. Use Back and forth or Loop.
        </p>
      )}
      {path && !habit && <p className="hint warn-text">May ignore this path.</p>}
      {info?.category === 'robot' && (
        <Field label="Weapon level">
          <select value={entity.weapon} onChange={(e) => change({ weapon: Number(e.target.value) })}>
            <option value={0}>1</option>
            <option value={1}>2</option>
            <option value={2}>3</option>
          </select>
        </Field>
      )}
      {canBeFriend(info) && (
        <div className="friend-box">
          <label className="check" title="Never attacks the player">
            <input type="checkbox" checked={!!entity.friendly} onChange={(e) => setFriendly(e.target.checked ? { follow: entity.friendly?.follow ?? false } : null)} /> Friendly
          </label>
          {entity.friendly && (
            <label className="check">
              <input type="checkbox" checked={entity.friendly.follow} onChange={(e) => setFriendly({ follow: e.target.checked })} /> Follows the player
            </label>
          )}
        </div>
      )}
      <label className="check" style={{ margin: '6px 0' }} title="Appears only when a trigger enables it">
        <input type="checkbox" checked={entity.disabled} onChange={(e) => change({ disabled: e.target.checked })} /> Starts disabled
      </label>
      {info?.pickup && <p className="hint">{info.pickup.operation}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="small danger"
          onClick={() => {
            edit((p) => {
              const l = p.groups[selection.group].layers[selection.layer];
              l.entities = l.entities.filter((e) => e.id !== selection.id);
            });
            select(null);
          }}
        >
          <Icon name="trash" size={14} /> Remove
        </button>
      </div>
    </>
  );
}

function WallDetails({ selection }: { selection: Extract<Selection, { kind: 'wall' }> }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const brush = useEditor((s) => s.brush);
  useEditor((s) => s.revision);
  const wall = project.groups[selection.group]?.layers[selection.layer]?.walls.get(selection.key);
  if (!wall) return <div className="empty">Nothing selected.</div>;
  const change = (patch: Partial<typeof wall>) => edit((p) => Object.assign(p.groups[selection.group].layers[selection.layer].walls.get(selection.key)!, patch));
  const diagonal = wall.x0 !== wall.x1 && wall.y0 !== wall.y1;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="tile" style={{ width: 52 }}>
          <TileCanvas game={game} level={project.baseLevel} tile={wall.tile === null ? undefined : project.tiles[wall.tile & 0x3fff]} />
        </div>
        <div className="grow">
          <b>{diagonal ? 'Diagonal wall' : 'Wall'}</b>
          <div className="dim">
            ({wall.x0}, {wall.y0}) to ({wall.x1}, {wall.y1})
          </div>
        </div>
      </div>
      <Field label="Height">
        <NumberInput value={wall.height} min={0.125} max={4} step={0.125} onChange={(height) => change({ height })} />
      </Field>
      {wall.tile !== null && (
        <label className="check" style={{ margin: '2px 0 6px' }} title="Color 0 of the tile is transparent: glass, grilles">
          <input type="checkbox" checked={(wall.tile & TEXTURE_MASKED) !== 0} onChange={(e) => change({ tile: e.target.checked ? wall.tile! | TEXTURE_MASKED : wall.tile! & ~TEXTURE_MASKED })} /> See-through
        </label>
      )}
      {diagonal && (
        <Field label="Solid side">
          <select value={wall.side} onChange={(e) => change({ side: Number(e.target.value) as 0 | 1 })}>
            <option value={0}>{wall.x1 - wall.x0 === wall.y1 - wall.y0 ? 'North-east half' : 'South-east half'}</option>
            <option value={1}>{wall.x1 - wall.x0 === wall.y1 - wall.y0 ? 'South-west half' : 'North-west half'}</option>
          </select>
        </Field>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="small" onClick={() => change({ tile: brush.wallTile })}>
          Use wall tile {brush.wallTile}
        </button>
        <button
          className="small danger"
          onClick={() => {
            edit((p) => void p.groups[selection.group].layers[selection.layer].walls.delete(selection.key));
            select(null);
          }}
        >
          <Icon name="trash" size={14} /> Remove
        </button>
      </div>
    </>
  );
}

function CellDetails({ selection }: { selection: Extract<Selection, { kind: 'cell' }> }) {
  const game = useGame();
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const focusOn = useEditor((s) => s.focusOn);
  const floorTile = useEditor((s) => s.brush.floorTile);
  const wallTile = useEditor((s) => s.brush.wallTile);
  useEditor((s) => s.revision);
  const layer = project.groups[selection.group]?.layers[selection.layer];
  if (!layer || selection.x >= layer.width || selection.y >= layer.height) return <div className="empty">Nothing selected.</div>;
  const cell = describeCell(layer, selection.x, selection.y);
  const index = selection.y * layer.width + selection.x;
  const stack = layer.overlays.get(index);
  const setBehavior = (b: CellBehaviorSpec | null) =>
    edit((p) => {
      const l = p.groups[selection.group].layers[selection.layer];
      if (b) l.behaviors.set(index, b);
      else l.behaviors.delete(index);
    });
  const s = cell.surface;
  const inheritedFloor = !s && !cell.prop && withLayerConnections(layer, project.groups[selection.group].layers[selection.layer - 1]).surfaces.get(index)?.kind === 'floor';
  const tile = s?.kind === 'floor' || s?.kind === 'ramp' ? s.tile : s?.kind === 'block' ? s.topTile : null;
  const changeBlock = (patch: Partial<Extract<typeof s, { kind: 'block' }>>) => edit((p) => void Object.assign(p.groups[selection.group].layers[selection.layer].surfaces.get(index)!, patch));
  const describe = !s
    ? inheritedFloor ? 'Floor (block top)' : cell.prop
      ? `Prop ${cell.prop}${project.definitionSources[cell.prop] ? ` (${project.definitionSources[cell.prop]})` : ''}`
      : 'Empty'
    : s.kind === 'floor'
      ? 'Floor'
      : s.kind === 'ramp'
        ? `Ramp rising ${s.direction} (${s.half} half)`
        : s.kind === 'split'
          ? 'Split floor'
          : s.kind === 'block'
            ? s.pillar
              ? 'Pillar'
              : 'Block'
            : 'Ramp landing';
  const b = cell.behavior;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="tile" style={{ width: 52 }}>
          <TileCanvas game={game} level={project.baseLevel} tile={tile === null ? undefined : project.tiles[tile & 0x3fff]} />
        </div>
        <div className="grow">
          <b>{describe}</b>
          <div className="dim">
            Cell ({selection.x}, {selection.y}){cell.walls.length ? ` · ${cell.walls.length} wall${cell.walls.length > 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>
      {inheritedFloor && <p className="dim">Walkable top of the full-height block below. Its texture is set on that block.</p>}
      {s?.kind === 'floor' && s.tile !== null && (
        <label className="check" title="Color 0 of the tile is transparent: grilles, grates">
          <input type="checkbox" checked={(s.tile & TEXTURE_MASKED) !== 0} onChange={(e) => edit((p) => {
            const floor = p.groups[selection.group].layers[selection.layer].surfaces.get(index);
            if (floor?.kind === 'floor' && floor.tile !== null) floor.tile = e.target.checked ? floor.tile | TEXTURE_MASKED : floor.tile & ~TEXTURE_MASKED;
          })} /> See-through
        </label>
      )}
      {s?.kind === 'floor' && (
        <Field label="Tile turn">
          <select value={s.turn} onChange={(e) => edit((p) => void ((p.groups[selection.group].layers[selection.layer].surfaces.get(index) as typeof s).turn = Number(e.target.value) as 0 | 1 | 2 | 3))}>
            {[0, 1, 2, 3].map((t) => (
              <option key={t} value={t}>
                {t * 90}°
              </option>
            ))}
          </select>
        </Field>
      )}
      {s?.kind === 'block' && (
        <>
          <Field label="Height">
            <NumberInput value={s.height} min={0.125} max={1} step={0.125} onChange={(height) => changeBlock({ height })} />
          </Field>
          <Field label="Width">
            <div className="segmented">
              {[{ value: 0.25, label: '¼' }, { value: 0.5, label: '½' }, { value: 0.75, label: '¾' }, { value: 1, label: 'Full' }].map((w) => (
                <button key={w.value} className={(s.pillar ? s.width ?? 0.5 : 1) === w.value ? 'active' : ''} onClick={() => changeBlock({ width: w.value, pillar: w.value < 1, floorTile: w.value < 1 ? (pillarFloor(layer, selection.x, selection.y) ?? s.floorTile ?? s.topTile) : null })}>
                  {w.label}
                </button>
              ))}
            </div>
          </Field>
        </>
      )}
      {cell.overlays.length > 0 && (
        <div style={{ margin: '4px 0 10px' }}>
          <div className="dim" style={{ marginBottom: 2 }}>
            Props
          </div>
          {cell.overlays.map((id, i) => (
            <div key={`${id}:${i}`} className="overlay-row">
              <span className="grow">{project.models.find((m) => m.definitionId === id)?.name ?? project.definitionSources[id] ?? `Prop ${id}`}</span>
              <button
                className="small ghost icon"
                title="Remove"
                onClick={() =>
                  edit((p) => {
                    const l = p.groups[selection.group].layers[selection.layer];
                    const o = l.overlays.get(index);
                    if (!o) return;
                    o.props.splice(i, 1);
                    if (!o.props.length) l.overlays.delete(index);
                  })
                }
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <label className="check" style={{ margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={!!stack?.breakable}
              onChange={(e) => edit((p) => void (p.groups[selection.group].layers[selection.layer].overlays.get(index)!.breakable = e.target.checked ? { ...DEFAULT_BREAKABLE } : undefined))}
            />
            Can be shot away
          </label>
          {stack?.breakable && (
            <>
              <Field label="Toughness">
                <NumberInput value={stack.breakable.toughness} min={1} max={255} onChange={(toughness) => edit((p) => void (p.groups[selection.group].layers[selection.layer].overlays.get(index)!.breakable!.toughness = toughness))} />
              </Field>
              <Field label="Effect">
                <NumberInput value={stack.breakable.effect} min={0} max={31} onChange={(effect) => edit((p) => void (p.groups[selection.group].layers[selection.layer].overlays.get(index)!.breakable!.effect = effect))} />
              </Field>
            </>
          )}
        </div>
      )}
      <Field label="Behavior">
        <select
          value={b?.kind ?? 'none'}
          onChange={(e) => {
            const kind = e.target.value;
            if (kind === 'none') setBehavior(null);
            else if (kind === 'exit') setBehavior({ kind: 'exit' });
            else if (kind === 'hazard') setBehavior({ kind: 'hazard', damage: 4 });
            else if (kind === 'breakable') setBehavior({ kind: 'breakable', ...DEFAULT_BREAKABLE, leaves: floorTile });
            else if (kind === 'plain') setBehavior({ kind: 'plain' });
            else if (kind === 'teleporter') setBehavior({ kind: 'teleporter', group: selection.group, layer: selection.layer, x: selection.x, y: selection.y, facing: null });
            else if (kind === 'door') setBehavior({ kind: 'door', lock: 0, tile: wallTile, facing: 'ns', style: useEditor.getState().brush.doorStyle });
            else if (kind === 'switch') {
              const channel = freeSwitchChannel(project);
              if (channel !== null) setBehavior({ kind: 'switch', channel });
            }
          }}
        >
          <option value="none">{cell.prop && !s ? "Prop's own" : 'None'}</option>
          <option value="teleporter">Teleporter</option>
          <option value="exit">Level exit</option>
          <option value="hazard">Damage floor</option>
          <option value="breakable">Breakable</option>
          {(s?.kind === 'floor' || b?.kind === 'door') && <option value="door">Door</option>}
          {(s?.kind === 'floor' || b?.kind === 'switch') && <option value="switch">Trigger pad</option>}
          {cell.prop > 0 && !s && <option value="plain">Nothing</option>}
        </select>
      </Field>
      {b?.kind === 'door' && (
        <>
          <Field label="Opens">
            <LockSelect project={project} value={b.lock} onChange={(lock) => setBehavior({ ...b, lock })} />
          </Field>
          <Field label="Opens by">
            <select value={b.style ?? 'sink'} onChange={(e) => setBehavior({ ...b, style: e.target.value as DoorStyle })}>
              <option value="rise">Rising</option>
              <option value="slide">Sliding</option>
              <option value="sink">Sinking</option>
            </select>
          </Field>
          <Field label="Walk through">
            <select value={b.facing} onChange={(e) => setBehavior({ ...b, facing: e.target.value as 'ns' | 'ew' })}>
              <option value="ns">North–south</option>
              <option value="ew">East–west</option>
            </select>
          </Field>
          <Field label="Panel">
            <div className="row">
              <div className="tile" style={{ width: 32, height: 32 }}>
                <TileCanvas game={game} level={project.baseLevel} tile={project.tiles[b.tile]} />
              </div>
              <button className="small" disabled={b.tile === wallTile} onClick={() => setBehavior({ ...b, tile: wallTile })} >
                Use the wall tile
              </button>
            </div>
          </Field>
          {b.lock >= 1 && b.lock <= KEY_COUNT && !project.groups.some((g) => g.layers.some((l) => l.entities.some((e) => e.type === KEY_PICKUP_TYPES[b.lock - 1]))) && <p className="hint warn-text">This door needs Key {b.lock}, but that key isn't placed in the map.</p>}
          {b.lock > KEY_COUNT && !mapSwitches(project).some((sw) => sw.channel === b.lock) && <p className="hint warn-text">Switch {switchNumber(b.lock)} isn't placed yet.</p>}
        </>
      )}
      {b?.kind === 'switch' && (
        <>
          <Field label="Trigger">
            <LockSelect project={project} value={b.channel} onChange={(channel) => setBehavior({ kind: 'switch', channel })} allowTouch={false} allowKeys={false} />
          </Field>
          <button
            className="small"
            onClick={() => {
              const editor = useEditor.getState();
              editor.setTool('interactive');
              editor.setBrush({ interactive: 'triggers' });
              editor.setTrigger(b.channel);
            }}
          >
            Edit trigger
          </button>
        </>
      )}
      {b?.kind === 'hazard' && (
        <Field label="Damage">
          <NumberInput value={b.damage} min={1} max={254} onChange={(damage) => setBehavior({ kind: 'hazard', damage })} />
        </Field>
      )}
      {b?.kind === 'breakable' && (
        <>
          <Field label="Toughness">
            <NumberInput value={b.toughness} min={1} max={255} onChange={(toughness) => setBehavior({ ...b, toughness })} />
          </Field>
          <Field label="Effect">
            <NumberInput value={b.effect} min={0} max={31} onChange={(effect) => setBehavior({ ...b, effect })} />
          </Field>
          <Field label="Becomes">
            <select value={b.result ?? 'floor'} onChange={(e) => setBehavior(e.target.value === 'broken' ? { ...b, result: 'broken', broken: b.broken ?? wallTile } : { ...b, result: 'floor' })}>
              <option value="broken">Broken version</option>
              <option value="floor">Rubble floor</option>
            </select>
          </Field>
          {b.result === 'broken' ? (
            <Field label="Broken tile">
              <div className="row">
                <div className="tile" style={{ width: 34 }}>
                  <TileCanvas game={game} level={project.baseLevel} tile={project.tiles[(b.broken ?? 0) & 0x3fff]} />
                </div>
                <button className="small" disabled={b.broken === wallTile} onClick={() => setBehavior({ ...b, broken: wallTile })}>
                  Use wall tile {wallTile}
                </button>
              </div>
            </Field>
          ) : (
            <Field label="Leaves behind">
              <div className="row">
                <div className="tile" style={{ width: 34 }}>
                  <TileCanvas game={game} level={project.baseLevel} tile={project.tiles[b.leaves & 0x3fff]} />
                </div>
                <button className="small" disabled={b.leaves === floorTile} onClick={() => setBehavior({ ...b, leaves: floorTile })}>
                  Use floor tile {floorTile}
                </button>
              </div>
            </Field>
          )}
        </>
      )}
      {b?.kind === 'teleporter' && (
        <>
          <Field label="To area">
            <select value={b.group} onChange={(e) => setBehavior({ ...b, group: Number(e.target.value), layer: 0 })}>
              {project.groups.map((g, i) => (
                <option key={i} value={i}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To layer">
            <select value={b.layer} onChange={(e) => setBehavior({ ...b, layer: Number(e.target.value) })}>
              {(project.groups[b.group]?.layers ?? []).map((l, i) => (
                <option key={i} value={i}>
                  {i + 1} · {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To cell">
            <div className="row">
              <NumberInput value={b.x} min={0} max={255} onChange={(x) => setBehavior({ ...b, x })} />
              <NumberInput value={b.y} min={0} max={255} onChange={(y) => setBehavior({ ...b, y })} />
            </div>
          </Field>
          <Field label="Arrive facing">
            <select value={b.facing ?? -1} onChange={(e) => setBehavior({ ...b, facing: Number(e.target.value) < 0 ? null : Number(e.target.value) })}>
              <option value={-1}>Unchanged</option>
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i} value={i}>
                  {(i * 22.5).toFixed(1)}°
                </option>
              ))}
            </select>
          </Field>
          <button className="small" disabled={!project.groups[b.group]?.layers[b.layer]} onClick={() => focusOn(b.group, b.layer, b.x, b.y)} >
            <Icon name="target" size={14} /> Go to destination{b.group !== selection.group ? ` (${project.groups[b.group]?.name ?? 'missing area'})` : ''}
          </button>
        </>
      )}
    </>
  );
}

function SelectionBlock() {
  const selection = useEditor((s) => s.selection);
  return (
    <div className="block">
      <h3>Selection</h3>
      {!selection && <div className="empty">Nothing selected</div>}
      {selection?.kind === 'entity' && <EntityDetails selection={selection} />}
      {selection?.kind === 'wall' && <WallDetails selection={selection} />}
      {selection?.kind === 'cell' && <CellDetails selection={selection} />}
    </div>
  );
}

/* ---------------------------------------------------------- map settings */

function MapSettings() {
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  useEditor((s) => s.revision);
  return (
    <div className="block">
      <h3>Map</h3>
      <Field label="Name">
        <input value={project.name} maxLength={60} onChange={(e) => edit((p) => void (p.name = e.target.value))} />
      </Field>
      <Field label="Author">
        <input value={project.author} maxLength={60} onChange={(e) => edit((p) => void (p.author = e.target.value))} />
      </Field>
      <Field label="Exit">
        <select value={project.exitRule} onChange={(e) => edit((p) => void (p.exitRule = e.target.value as MapProject['exitRule']))}>
          <option value="unconditional">Always open</option>
          <option value="inherit">After the mission goals</option>
        </select>
      </Field>
    </div>
  );
}

/* ---------------------------------------------------------------- checks */

interface CheckResult {
  issues: Issue[];
  stats: { definitions: number; objects: number; tiles: number; mapBytes: number; lmpBytes: number } | null;
}

const useCheckStore = create<CheckResult>(() => ({ issues: [], stats: null }));

/** Latest compile check of the open map. */
export const useChecks = (): CheckResult => useCheckStore();

/** Recompiles the open map shortly after each change. Mounted once by the builder. */
export function ChecksRunner() {
  const game = useGame();
  const project = useEditor((s) => s.project);
  const revision = useEditor((s) => s.revision);
  const baseLevel = project?.baseLevel;
  const options = useMemo(() => (baseLevel ? { opaqueZeroIndex: game.level(baseLevel).opaqueZeroIndex, knownTypes: game.knownTypes } : {}), [game, baseLevel]);
  useEffect(() => {
    if (!project) return;
    // Compiling is fast but not free; wait for a pause in editing.
    const handle = window.setTimeout(() => {
      try {
        const compiled = compileProject(project, options);
        useCheckStore.setState({ issues: compiled.issues, stats: compiled.stats });
      } catch (error) {
        useCheckStore.setState({ issues: error instanceof CompileError ? error.issues : [...validateProject(project, options), { level: 'error', message: (error as Error).message }], stats: null });
      }
    }, 350);
    return () => window.clearTimeout(handle);
  }, [project, revision, options]);
  return null;
}

function Checks() {
  const { issues } = useChecks();
  const focusOn = useEditor((s) => s.focusOn);
  const errors = issues.filter((i) => i.level === 'error').length;
  return (
    <div className="block">
      <h3>
        Checks
        <span className={errors ? 'pill bad' : 'pill ok'}>{errors ? `${errors} to fix` : 'playable'}</span>
      </h3>
      {issues.map((issue, i) => (
        <div
          key={i}
          className={`issue ${issue.level}`}
          role={issue.at ? 'button' : undefined}
          title={issue.at ? 'Show on the map' : undefined}
          onClick={() => {
            if (issue.at) focusOn(issue.at.group, issue.at.layer, issue.at.x, issue.at.y);
          }}
        >
          <Icon name={issue.level === 'info' ? 'info' : 'warn'} size={14} />
          <span>{issue.message}</span>
        </div>
      ))}
      {!issues.length && <div className="hint">No problems.</div>}
    </div>
  );
}

export function Inspector() {
  return (
    <div className="inspector">
      <SelectionBlock />
      <Structure />
      <MapSettings />
      <Checks />
    </div>
  );
}
