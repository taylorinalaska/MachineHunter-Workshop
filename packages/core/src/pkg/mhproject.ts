/**
 * `.mhproject`: one file that is both the editable project and (when it
 * compiles) the playable level the runtime loads from a mod's `maps/` folder.
 *
 *   manifest.json            { format: "mhproject-v2", project, project_crc32, runtime?, build_error? }
 *   project.json             the editable project (see authoring/serialize.ts)
 *   runtime/manifest.json    { format: 1, base_level, map, initial_group, assets, exit_rule, briefing, ... }
 *   runtime/level.map        compiled native MAP
 *   runtime/level.lmp        automap companion
 *   runtime/terrain.bin      terrain bank, only when it differs from the base level's
 *   runtime/briefing.bmp     custom 220x160 briefing picture, when set
 *   runtime/sounds/N.wav     the map's own ambient sounds, when it has any
 *   runtime/sprites/N.b      replacement sprite container for runtime slot N (custom enemies)
 * Custom effects placed in the map go in runtime/manifest.json as "effects".
 *
 * The runtime side of this contract lives in runtime/src/maps/.
 */
import { type CompileOptions, CompileError, type CompiledMap, type Issue, compileProject } from '../authoring/compile.ts';
import { type MapProject, SWITCH_CHANNEL_FIRST } from '../authoring/project.ts';
import { deserializeProject, serializeProject } from '../authoring/serialize.ts';
import { BRIEFING_IMAGE_HEIGHT, BRIEFING_IMAGE_WIDTH, decodeBmp } from '../gfx/bmp.ts';
import { check, crc32 } from '../util/binary.ts';
import { fromUtf8, unzipStored, utf8, zipStored } from './zip.ts';

export const MHPROJECT_FORMAT = 'mhproject-v2';
export const MOD_FORMAT = 'mhmod-1';

export interface BuiltPackage {
  bytes: Uint8Array;
  /** True when the package contains a compiled level the game can load. */
  playable: boolean;
  issues: Issue[];
  compiled: CompiledMap | null;
}

/** The runtime only understands these JSON string escapes, so briefing text must stay plain ASCII. */
function runtimeSafeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[^\x20-\x7e\n]/g, '?');
}

function runtimeManifest(project: MapProject, compiled: CompiledMap, files: Record<string, Uint8Array | string>): string {
  const assets: Record<string, string | Record<string, string>> = { base: project.baseLevel, lmp: 'runtime/level.lmp' };
  if (compiled.terrainBytes) {
    files['runtime/terrain.bin'] = compiled.terrainBytes;
    assets.terrain = 'runtime/terrain.bin';
  }
  const manifest: Record<string, unknown> = {
    format: 1,
    name: runtimeSafeText(project.name),
    base_level: project.baseLevel,
    map: 'runtime/level.map',
    initial_group: project.initialGroup,
    assets,
    exit_rule: { type: project.exitRule },
    debrief: { mode: 'inherit' },
    on_complete: { action: 'inherit' },
  };
  if (project.briefing.mode === 'custom') {
    const briefing: Record<string, string> = { mode: 'custom' };
    if (project.briefing.text.trim()) briefing.text = runtimeSafeText(project.briefing.text).toUpperCase();
    if (project.briefing.title.trim()) briefing.title = runtimeSafeText(project.briefing.title).toUpperCase();
    if (project.briefing.image) {
      const bmp = decodeBmp(project.briefing.image);
      check(bmp.width === BRIEFING_IMAGE_WIDTH && bmp.height === BRIEFING_IMAGE_HEIGHT, 'The briefing picture must be 220x160');
      files['runtime/briefing.bmp'] = project.briefing.image;
      briefing.image = 'runtime/briefing.bmp';
    }
    manifest.briefing = briefing;
  }
  const sprites: Record<string, string> = {};
  for (const t of project.customTypes) {
    if (!t.sprite) continue;
    const file = `runtime/sprites/${t.sprite.slot}.b`;
    files[file] = t.sprite.data;
    sprites[String(t.sprite.slot)] = file;
  }
  if (Object.keys(sprites).length) assets.sprites = sprites;
  const overrides = project.customTypes
    .filter((t) => t.health !== null || t.speed !== 100 || t.fireRate !== 100 || t.damage !== 100 || t.animations?.length)
    .map((t) => ({
      type: t.type,
      ...(t.health !== null ? { health: t.health } : {}),
      speed_pct: t.speed,
      fire_rate_pct: t.fireRate,
      damage_pct: t.damage,
      ...(t.animations?.length ? { animations: t.animations.map((a) => ({ record: a.record, base: a.base, span: a.span, start: a.start, ticks: a.ticks, mode: a.mode, reversed: a.reversed ? 1 : 0 })) } : {}),
    }));
  if (overrides.length) manifest.entity_overrides = overrides;
  // Switches, and the doors they open, are run by the runtime: cells within their layer.
  const switches: { group: number; layer: number; x: number; y: number; channel: number }[] = [];
  const doors: { group: number; layer: number; x: number; y: number; lock: number; axis: number }[] = [];
  project.groups.forEach((group, g) =>
    group.layers.forEach((layer, l) => {
      for (const [index, b] of layer.behaviors) {
        const at = { group: g, layer: l, x: index % layer.width, y: Math.floor(index / layer.width) };
        if (b.kind === 'switch') switches.push({ ...at, channel: b.channel });
        else if (b.kind === 'door') doors.push({ ...at, lock: b.lock, axis: b.facing === 'ns' ? 1 : 2 });
      }
    }),
  );
  if (switches.length) {
    manifest.switches = switches;
  }
  if (doors.length) manifest.doors = doors;
  // What the pads do besides opening doors.
  const triggers = compiled.triggers.filter((t) => t.actions.length);
  if (triggers.length) {
    manifest.triggers = triggers.map((t) => ({
      channel: t.channel,
      once: t.once ? 1 : 0,
      actions: t.actions.map((a) => {
        if (a.kind !== 'effect') return a;
        const effect = project.effects.find((f) => f.id === a.effect);
        check(effect, 'A trigger plays an effect that is not in the project');
        return { kind: 'effect', group: a.group, layer: 0, x: a.x, y: a.y, z: a.z, particles: effect.particles.map((p) => ({ fx: p.fx, spread: Math.round(p.spread) })) };
      }),
    }));
  }
  if (compiled.friends.length) manifest.friends = compiled.friends.map((f) => ({ group: f.group, layer: f.layer, x: f.x, y: f.y, type: f.type, follow: f.follow ? 1 : 0 }));
  if (compiled.effects.length) {
    manifest.effects = compiled.effects.map((placed) => {
      const effect = project.effects.find((f) => f.id === placed.effect);
      check(effect, 'A placed effect refers to an effect that is not in the project');
      return { group: placed.group, x: placed.x, y: placed.y, z: Math.max(0, -placed.z), every: effect.every, particles: effect.particles.map((p) => ({ fx: p.fx, spread: Math.round(p.spread) })) };
    });
  }
  if (compiled.sounds.length) {
    // One entry per emitter; the WAV files are shared between emitters that play the same sound.
    manifest.sounds = compiled.sounds.map((s) => {
      const file = `runtime/sounds/${s.sound}.wav`;
      const sound = project.sounds.find((p) => p.id === s.sound);
      check(sound, 'A sound emitter refers to a sound that is not in the project');
      files[file] = sound.wav;
      return { file, group: s.group, layer: s.layer, x: s.x, y: s.y, delay_ms: Math.max(100, Math.round(s.delay * 1000)), random_ms: Math.max(0, Math.round(s.random * 1000)) };
    });
  }
  return JSON.stringify(manifest, null, 2);
}

/**
 * Package a project. The editable project is always stored; the compiled
 * level is added when it builds. With `requirePlayable`, build errors throw.
 */
export function buildMhproject(project: MapProject, options: CompileOptions & { requirePlayable?: boolean } = {}): BuiltPackage {
  const projectJson = utf8(serializeProject(project));
  const files: Record<string, Uint8Array | string> = { 'project.json': projectJson };
  const manifest: Record<string, unknown> = {
    format: MHPROJECT_FORMAT,
    name: project.name,
    base_level: project.baseLevel,
    project: 'project.json',
    project_crc32: crc32(projectJson),
    runtime_ready: false,
  };
  let compiled: CompiledMap | null = null;
  let issues: Issue[] = [];
  try {
    compiled = compileProject(project, options);
    issues = compiled.issues;
    files['runtime/level.map'] = compiled.mapBytes;
    files['runtime/level.lmp'] = compiled.lmpBytes;
    files['runtime/manifest.json'] = runtimeManifest(project, compiled, files);
    manifest.runtime = 'runtime/manifest.json';
    manifest.runtime_ready = true;
  } catch (e) {
    if (options.requirePlayable) throw e;
    issues = e instanceof CompileError ? e.issues : [{ level: 'error', message: (e as Error).message }];
    manifest.build_error = runtimeSafeText(issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ')).slice(0, 1500);
    compiled = null;
    for (const key of Object.keys(files)) if (key.startsWith('runtime/')) delete files[key];
  }
  // manifest.json goes first so tools can identify the file from its head.
  const bytes = zipStored({ 'manifest.json': JSON.stringify(manifest, null, 2), ...files });
  return { bytes, playable: compiled !== null, issues, compiled };
}

/** Read the editable project back out of a `.mhproject`. */
export function openMhproject(bytes: Uint8Array): MapProject {
  const files = unzipStored(bytes);
  const manifestBytes = files.get('manifest.json');
  check(manifestBytes, 'The package has no manifest.json');
  const manifest = JSON.parse(fromUtf8(manifestBytes)) as { format?: string; project?: string };
  check(manifest.format === MHPROJECT_FORMAT, 'This package was not made by the Workshop (unsupported manifest format)');
  const projectBytes = files.get(manifest.project ?? 'project.json');
  check(projectBytes, 'The package has no project data');
  return deserializeProject(fromUtf8(projectBytes));
}

export interface ModInfo {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
}

/** `mod.json` for a mod folder under `game/mods/`. */
export function modManifest(info: ModInfo): string {
  check(/^[A-Za-z0-9._-]{1,95}$/.test(info.id), 'A mod id may only use letters, digits, ".", "_" and "-"');
  const out: Record<string, string> = { format: MOD_FORMAT, id: info.id, name: info.name.slice(0, 128) };
  if (info.version) out.version = info.version.slice(0, 64);
  if (info.author) out.author = info.author.slice(0, 128);
  if (info.description) out.description = info.description.slice(0, 1024);
  return JSON.stringify(out, null, 2) + '\n';
}

/** A file-system-safe name derived from a map title. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'map'
  );
}
