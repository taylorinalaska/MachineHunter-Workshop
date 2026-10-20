/**
 * Builds the maps the in-game checks run on, and the layout file that tells
 * the checking script (runtime/tests/game-checks/main.lua) where everything is.
 *
 *   npx tsx scripts/game-checks.ts <output folder> [--copies N] [--themes]
 *
 * Writes into <output>:
 *   maps/game-checks.mhproject   the main test map, on MARS
 *   maps/second-area.mhproject   starts in its second area; tanks on routes (MILIT3)
 *   maps/page-test-N.mhproject   with --copies, N copies of the main map for MAPS paging
 *   themes/theme-ID.mhproject    with --themes, a plain room on every retail theme
 *   layout.lua                   positions, read by the checking script
 *
 * Run by scripts/game-test.ps1; nothing here is installed by itself.
 *
 * Each feature gets its own walled room, so a check that goes wrong cannot
 * spoil the next one. Positions are in map cells.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Archive,
  COLLISION_MODE_MASK,
  COLLISION_OPEN,
  FLAG_GROUND,
  type GameMap,
  type LevelRecord,
  type MapProject,
  OP_FLOOR,
  OP_WALL_X,
  OP_WALL_Y,
  PATH_BACK_AND_FORTH,
  PATH_LOOP,
  PATH_ONCE,
  PATH_ZONE,
  PeImage,
  TEXTURE_INDEX_MASK,
  buildMhproject,
  openMhproject,
  buildPropDefinition,
  cellIndex,
  createLayer,
  createProject,
  decodeSprites,
  decodeTerrainBank,
  encodeSprites,
  flagsOf,
  objectBehavior,
  objectMapType,
  parseMap,
  CUSTOM_EFFECT_TYPE,
  KEY_PICKUP_TYPES,
  EFFECT_ID_COUNT,
  readBodyFormAnimations,
  readEntityType,
  readLevelTable,
} from '../packages/core/src/index.ts';
import type { DoorStyle, PropPart, RampDirection } from '../packages/core/src/index.ts';
import { PROP_PRESETS, presetParts } from '../apps/workshop/src/editor/prop-presets.ts';
import { addEntity, addWalls, buildRoom, createModel, createPath, cutFloorCorner, eraseCell, importProp, linkTeleporter, placeBlock, placeRamp, rampFootprint, removeWalls, setBehavior, setFloor, setProp, wallRun, zonePoints } from '../apps/workshop/src/editor/ops.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'build', 'game-checks'));
const copiesAt = process.argv.indexOf('--copies');
const copies = copiesAt > 0 ? Number(process.argv[copiesAt + 1]) : 0;

const archivePath = join(root, 'game', 'DATA', 'DATA.ARC');
const exePath = join(root, 'retail', 'MACHHUNT_ORIGINAL.EXE');
if (!existsSync(archivePath) || !existsSync(exePath)) {
  console.error('This script needs game/DATA/DATA.ARC and retail/MACHHUNT_ORIGINAL.EXE.');
  process.exit(1);
}
const archive = new Archive(new Uint8Array(readFileSync(archivePath)));
const levels = readLevelTable(new PeImage(new Uint8Array(readFileSync(exePath))));
const level = (id: string): LevelRecord => levels.find((l) => l.id === id)!;
const levelMap = (l: LevelRecord): GameMap => parseMap(archive.read(l.resources.map), { lmp: archive.read(l.resources.lmp) });
const levelTiles = (l: LevelRecord) => decodeTerrainBank(archive.read(l.resources.terrain));

const ROBOT = 3; // Four Foot
const PERSON = 109; // GENEMAN8: walks routes in MARS and a one-way route in ALIEN1
const TANK = 98;
const cell = (n: number) => n * 256 + 128;

/** The behaviour the retail levels most often give a type with this kind of path (or none). */
function retailBehavior(type: number, kind: 'route' | 'zone' | 'none', fallback: number): number {
  const counts = new Map<number, number>();
  for (const l of levels.slice(0, 17)) {
    const map = levelMap(l);
    for (const group of map.groups)
      for (const layer of group.layers)
        for (const o of layer.objects) {
          if (objectMapType(o) !== type) continue;
          const path = o.pathIndex >= 0 ? map.paths[o.pathIndex] : null;
          if ((path ? (path.word0 === PATH_ZONE ? 'zone' : 'route') : 'none') !== kind) continue;
          counts.set(objectBehavior(o), (counts.get(objectBehavior(o)) ?? 0) + 1);
        }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

/** A level's most used floor and wall tiles, so a test map in its theme looks like it. */
function commonTiles(map: GameMap): { floor: number; wall: number } {
  const floors = new Map<number, number>();
  const walls = new Map<number, number>();
  for (const def of map.definitions) {
    for (const c of def.commands) {
      if (c.texture === undefined) continue;
      const tile = c.texture & TEXTURE_INDEX_MASK;
      const bucket = c.op === OP_FLOOR ? floors : c.op === OP_WALL_X || c.op === OP_WALL_Y ? walls : null;
      bucket?.set(tile, (bucket.get(tile) ?? 0) + 1);
    }
  }
  const top = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1])[0][0];
  return { floor: top(floors), wall: top(walls) };
}

/** Walk-on floor with something drawn on it, from the retail level: a prop that walls can be added to. */
function floorProp(map: GameMap): number {
  let best = -1;
  let bestHeight = Infinity;
  for (let id = 1; id < map.definitions.length; id++) {
    const def = map.definitions[id];
    const flags = flagsOf(def.meta);
    if (flags !== (FLAG_GROUND | COLLISION_OPEN) || (flags & COLLISION_MODE_MASK) !== COLLISION_OPEN) continue;
    if (def.commands.length < 2 || !def.commands.some((c) => c.op === OP_FLOOR)) continue;
    // The lowest one, so the player can be seen standing on it (z grows downwards).
    let height = 0;
    for (let i = 2; i < def.vertices.length; i += 3) height = Math.max(height, -def.vertices[i]);
    if (height < bestHeight) {
      best = id;
      bestHeight = height;
    }
  }
  if (best < 0) throw new Error('No floor prop found in the level');
  return best;
}

function write(name: string, project: MapProject) {
  const built = buildMhproject(project, { requirePlayable: true });
  for (const issue of built.issues) console.log(`${name}: ${issue.level}: ${issue.message}`);
  writeFileSync(join(out, 'maps', `${name}.mhproject`), built.bytes);
  return built.bytes;
}

const layout: Record<string, unknown> = {};

/* =============================================================== main map */

function mainMap(): MapProject {
  const mars = level('MARS');
  const marsMap = levelMap(mars);
  const FLOOR = 12;
  const WALL = 21;
  const RAMP = 15;
  const W = 48;
  const H = 36;

  const project = createProject({ name: 'Game checks', baseLevel: 'MARS', width: W, height: H, tiles: levelTiles(mars) });
  project.description = 'Built by scripts/game-checks.ts for the automated in-game checks.';
  project.exitRule = 'unconditional';
  const ground = project.groups[0].layers[0];
  const upper = createLayer('Upper', W, H);
  project.groups[0].layers.push(upper);
  ground.lighting.fill(14);
  upper.lighting.fill(14);
  const room = (x0: number, y0: number, x1: number, y1: number) => buildRoom(ground, { x0, y0, x1, y1 }, FLOOR, 0, WALL, 1);

  // Start room. The player starts here; the free camera and menu checks also run here.
  room(1, 1, 7, 7);
  addEntity(project, ground, 1, cell(4), cell(4));
  layout.start = { x: 4, y: 4 };

  // One room per ramp direction. The player starts two cells before the low end
  // and walks up; three cells of upper floor, walled in, wait at the top.
  const STEP: Record<RampDirection, { x: number; y: number }> = { east: { x: 1, y: 0 }, west: { x: -1, y: 0 }, north: { x: 0, y: -1 }, south: { x: 0, y: 1 } };
  const ramps: Record<string, unknown>[] = [];
  function rampRoom(direction: RampDirection, lowX: number, lowY: number) {
    const s = STEP[direction];
    const side = { x: s.y, y: s.x }; // perpendicular
    const start = { x: lowX - 2 * s.x, y: lowY - 2 * s.y };
    const [, high] = rampFootprint(lowX, lowY, direction);
    const far = { x: high.x + 3 * s.x, y: high.y + 3 * s.y };
    const xs = [start.x, far.x].sort((a, b) => a - b);
    const ys = [start.y, far.y].sort((a, b) => a - b);
    room(xs[0] - 1 - Math.abs(side.x), ys[0] - 1 - Math.abs(side.y), xs[1] + 1 + Math.abs(side.x), ys[1] + 1 + Math.abs(side.y));
    placeRamp(project, 0, 0, lowX, lowY, direction, RAMP, WALL);
    // Simulate projects damaged by editing order: missing or painted-over landings.
    if (process.argv.includes('--ramp-regressions')) {
      const index = cellIndex(upper, high.x, high.y);
      if (direction === 'east' || direction === 'south') upper.surfaces.delete(index);
      if (direction === 'west') upper.surfaces.set(index, { kind: 'floor', tile: FLOOR, turn: 0 });
    }
    // Upper floor beyond the landing, three cells wide, with a low rail round it.
    const cells: { x: number; y: number }[] = [];
    for (let k = 1; k <= 3; k++) for (let w = -1; w <= 1; w++) cells.push({ x: high.x + k * s.x + w * side.x, y: high.y + k * s.y + w * side.y });
    for (const c of cells) {
      if (process.argv.includes('--ramp-regressions')) placeBlock(ground, c.x, c.y, { height: 1, topTile: FLOOR, sideTile: WALL, pillar: false, floorTile: null });
      else setFloor(upper, c.x, c.y, FLOOR, 0);
    }
    const ux = [...cells.map((c) => c.x), high.x];
    const uy = [...cells.map((c) => c.y), high.y];
    const r = { x0: Math.min(...ux), y0: Math.min(...uy), x1: Math.max(...ux) + 1, y1: Math.max(...uy) + 1 };
    const rail = [
      ...wallRun({ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }),
      ...wallRun({ x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }),
      ...wallRun({ x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }),
      ...wallRun({ x: r.x0, y: r.y1 }, { x: r.x0, y: r.y0 }),
    ];
    // Leave the landing's own edge open, or the rail would block the top of the ramp.
    const touchesLanding = (seg: { x0: number; y0: number; x1: number; y1: number }) => Math.abs((seg.x0 + seg.x1) / 2 - 0.5 - high.x) <= 0.5 && Math.abs((seg.y0 + seg.y1) / 2 - 0.5 - high.y) <= 0.5;
    addWalls(upper, rail.filter((seg) => !touchesLanding(seg)), WALL, 0.25);
    // A spot beside the ramp, two cells to its side, from which a screenshot shows its side wall.
    const beside = { x: lowX + 2 * side.x, y: lowY + 2 * side.y };
    ramps.push({ direction, start, low: { x: lowX, y: lowY }, high, beside });
  }
  rampRoom('east', 12, 3);
  rampRoom('west', 18, 10);
  rampRoom('south', 26, 3);
  rampRoom('north', 33, 10);
  const directionAt = process.argv.indexOf('--ramp-direction');
  layout.ramps = directionAt > 0 ? ramps.filter((r) => r.direction === process.argv[directionAt + 1]) : ramps;

  // Hazard floor: a strip three cells long in the walking direction.
  room(37, 1, 46, 5);
  for (let x = 40; x <= 42; x++) for (let y = 2; y <= 4; y++) setBehavior(ground, x, y, { kind: 'hazard', damage: 4 });
  layout.hazard = { start: { x: 38, y: 3 }, x0: 40, x1: 43 };

  // Diagonal walls, one of each family, standing in open floor.
  room(1, 14, 9, 22);
  addWalls(ground, wallRun({ x: 3, y: 16 }, { x: 7, y: 20 }), WALL, 1);
  room(11, 14, 19, 22);
  addWalls(ground, wallRun({ x: 17, y: 16 }, { x: 13, y: 20 }), WALL, 1);
  const diagonals: Record<string, unknown>[] = [
    // The player starts on the south-west side of x - y = -13 and walks north-east into it.
    { name: 'diagonal \\', start: { x: 3, y: 19 }, keys: ['north', 'east'], a: 1, b: -1, c: 3 - 16 },
    // The player starts on the north-west side of x + y = 33 and walks south-east into it.
    { name: 'diagonal /', start: { x: 13, y: 17 }, keys: ['south', 'east'], a: 1, b: 1, c: 17 + 16 },
  ];

  // A room edge built the Workshop way: floor cut along the diagonal (split
  // floor cells), nothing beyond it, and a diagonal wall standing on the cut.
  room(1, 24, 9, 34);
  addWalls(ground, wallRun({ x: 4, y: 26 }, { x: 8, y: 30 }), WALL, 1);
  for (let y = 24; y <= 34; y++) {
    for (let x = 1; x <= 9; x++) {
      if (x - y >= -21) eraseCell(ground, x, y); // wholly north-east of x - y = -22
      else if (x - y === -22 && x >= 4 && x <= 7) cutFloorCorner(ground, x, y, 'ne');
    }
  }
  // The kept halves alternate tiles so a screenshot shows the cut lining up with the wall.
  for (let x = 4; x <= 7; x++) {
    const s = ground.surfaces.get((x + 22) * ground.width + x);
    if (s?.kind === 'split' && s.halves.sw) s.halves.sw.tile = x % 2 ? FLOOR : RAMP;
  }
  diagonals.push({ name: 'split-floor edge', start: { x: 3, y: 31 }, keys: ['north', 'east'], a: 1, b: -1, c: 4 - 26, shot: 'split-floor' });
  layout.diagonals = diagonals;

  // A retail prop with a wall added on one edge of its cell.
  room(11, 24, 19, 28);
  const propId = floorProp(marsMap);
  setProp(ground, 15, 26, importProp(project, 'MARS', propId, marsMap.definitions[propId]));
  addWalls(ground, [{ x0: 16, y0: 26, x1: 16, y1: 27 }], WALL, 1);
  layout.prop = { start: { x: 13, y: 26 }, cell: { x: 15, y: 26 }, wall: 16, retail: propId };

  // A teleporter within the area: walk east onto it, arrive in the room below.
  room(22, 14, 30, 18);
  room(22, 21, 30, 25);
  linkTeleporter(project, { group: 0, layer: 0, x: 26, y: 16 }, { group: 0, layer: 0, x: 26, y: 23 });
  layout.teleporter = { start: { x: 23, y: 16 }, to: { x: 26, y: 23 } };

  // A robot with no path, for passive enemies and the runtime trace.
  room(21, 27, 30, 34);
  const guard = retailBehavior(ROBOT, 'none', 7);
  addEntity(project, ground, ROBOT, cell(28), cell(31), guard);
  layout.guard = { robot: { x: 28, y: 31 }, player: { x: 24, y: 31 }, behavior: guard };

  // Followers, each watched from a spot close enough for it to be active
  // (actors far from the player are not).
  room(31, 15, 46, 34);
  const followers: Record<string, unknown>[] = [];
  function follower(name: string, type: number, mode: number, points: { x: number; y: number }[], watch: { x: number; y: number }) {
    const path = createPath(project, 0, 0, mode);
    path.points = mode === PATH_ZONE ? zonePoints({ x: cell(points[0].x), y: cell(points[0].y) }, { x: cell(points[1].x), y: cell(points[1].y) }) : points.map((p) => ({ x: cell(p.x), y: cell(p.y), tail0: 0, tail1: 0 }));
    const behavior = retailBehavior(type, mode === PATH_ZONE ? 'zone' : 'route', type === ROBOT ? 5 : 0);
    const entity = addEntity(project, ground, type, cell(points[0].x), cell(points[0].y), behavior);
    entity.pathId = path.id;
    followers.push({ name, type, mode, x: points[0].x, y: points[0].y, points, behavior, watch });
  }
  follower('robot, round and round', ROBOT, PATH_LOOP, [{ x: 33, y: 17 }, { x: 37, y: 17 }, { x: 37, y: 21 }, { x: 33, y: 21 }], { x: 35, y: 19 });
  follower('robot, back and forth', ROBOT, PATH_BACK_AND_FORTH, [{ x: 40, y: 17 }, { x: 45, y: 17 }], { x: 42, y: 19 });
  follower('robot, wander zone', ROBOT, PATH_ZONE, [{ x: 33, y: 26 }, { x: 39, y: 32 }], { x: 36, y: 29 });
  // A follower on a one-way route (retail mode 0) stays at its first point; the person here and
  // the tank on the second map check that it still does.
  follower('person, back and forth', PERSON, PATH_BACK_AND_FORTH, [{ x: 41, y: 25 }, { x: 45, y: 25 }], { x: 43, y: 27 });
  follower('person, one-way route', PERSON, PATH_ONCE, [{ x: 41, y: 30 }, { x: 45, y: 30 }], { x: 43, y: 33 });
  // Keep the routes apart.
  addWalls(ground, wallRun({ x: 39, y: 15 }, { x: 39, y: 24 }), WALL, 1);
  addWalls(ground, wallRun({ x: 39, y: 20 }, { x: 47, y: 20 }), WALL, 1);
  addWalls(ground, wallRun({ x: 31, y: 24 }, { x: 47, y: 24 }), WALL, 1);
  addWalls(ground, wallRun({ x: 40, y: 24 }, { x: 40, y: 35 }), WALL, 1);
  addWalls(ground, wallRun({ x: 40, y: 28 }, { x: 47, y: 28 }), WALL, 1);
  layout.followers = followers;

  // A teleporter into a second area, where the exit is.
  linkTeleporter(project, { group: 0, layer: 0, x: 6, y: 6 }, { group: 1, layer: 0, x: 4, y: 8 });
  const second = createLayer('Second area', 16, 16);
  second.lighting.fill(14);
  project.groups.push({ name: 'Second area', layers: [second] });
  buildRoom(second, { x0: 2, y0: 5, x1: 13, y1: 11 }, FLOOR, 0, WALL, 1);
  for (let x = 7; x <= 8; x++) for (let y = 7; y <= 9; y++) setBehavior(second, x, y, { kind: 'exit' });
  layout.area = { start: { x: 4, y: 6 }, to: { x: 4, y: 8 } };
  return project;
}

/* ==================================================== second map: MILIT3 */

/** Starts in its second area, where tanks follow a one-way and a back-and-forth route. */
function secondMap(): MapProject {
  const milit3 = level('MILIT3');
  const { floor, wall } = commonTiles(levelMap(milit3));
  const project = createProject({ name: 'Second area', baseLevel: 'MILIT3', width: 10, height: 10, tiles: levelTiles(milit3) });
  project.exitRule = 'unconditional';
  const first = project.groups[0].layers[0];
  first.lighting.fill(14);
  buildRoom(first, { x0: 1, y0: 1, x1: 8, y1: 8 }, floor, 0, wall, 1);
  const layer = createLayer('Tank yard', 20, 22);
  layer.lighting.fill(14);
  project.groups.push({ name: 'Tank yard', layers: [layer] });
  project.initialGroup = 1;
  buildRoom(layer, { x0: 1, y0: 1, x1: 18, y1: 20 }, floor, 0, wall, 1);
  addWalls(layer, wallRun({ x: 1, y: 11 }, { x: 19, y: 11 }), wall, 1);
  addEntity(project, layer, 1, cell(3), cell(3));
  const tanks: Record<string, unknown>[] = [];
  function tank(name: string, mode: number, behavior: number, points: { x: number; y: number }[], watch: { x: number; y: number }) {
    const path = createPath(project, 1, 0, mode);
    path.points = points.map((p) => ({ x: cell(p.x), y: cell(p.y), tail0: 0, tail1: 0 }));
    const entity = addEntity(project, layer, TANK, cell(points[0].x), cell(points[0].y), behavior);
    entity.pathId = path.id;
    tanks.push({ name, type: TANK, mode, x: points[0].x, y: points[0].y, points, behavior, watch });
  }
  // The behaviours MILIT3 pairs with these modes.
  tank('tank, one-way route', PATH_ONCE, 0, [{ x: 4, y: 7 }, { x: 14, y: 7 }], { x: 9, y: 3 });
  tank('tank, back and forth', PATH_BACK_AND_FORTH, 8, [{ x: 4, y: 16 }, { x: 14, y: 16 }], { x: 9, y: 19 });
  layout.second = { start: { x: 3, y: 3 }, followers: tanks, floor, wall };
  return project;
}

/**
 * A custom enemy: a Four Foot made over for the map with its own health,
 * harder-hitting shots and a recoloured look (frames from MARS's own slot).
 */
function customMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Custom enemy', baseLevel: 'MARS', width: 16, height: 10, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(14);
  buildRoom(layer, { x0: 1, y0: 1, x1: 14, y1: 8 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(3), cell(5));
  const behavior = retailBehavior(ROBOT, 'none', 7);
  addEntity(project, layer, ROBOT, cell(13), cell(7), behavior);
  // The Four Foot's sprites: its descriptor's slot, filled from the container MARS loads there.
  const pe = new PeImage(new Uint8Array(readFileSync(exePath)));
  const descriptor = readEntityType(pe, ROBOT).descriptor!;
  const slot = descriptor.primaryAnimation!.slot;
  const container = archive.entries[mars.sprites.find((s) => s.slot === slot)!.archiveId].name;
  const frames = decodeSprites(archive.read(container));
  // A crude recolour that needs no palette: swap the pixel indices of the frames around.
  const swapped = frames.map((f) => ({ ...f, pixels: f.pixels.map((p) => (p >= 160 ? 160 + ((p - 160 + 48) % 96) : p)) }));
  // Four groups of eight extra frames with different shapes, one group per kind of record a robot plays.
  // Seen in the game: idle, it shows the hollow square (its descriptor's body); standing and firing, the bar (upper body standing).
  const last = frames[frames.length - 1];
  const side = 64 / last.scale;
  const shape = (kind: number, i: number) => {
    const pixels = new Uint8Array(side * side);
    const c = side / 2;
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const dx = Math.abs(x - c);
        const dy = Math.abs(y - c);
        const inside = kind === 0 ? dx < 4 && dy < 4 : kind === 1 ? dx < 12 && dy < 12 && (dx > 9 || dy > 9) : kind === 2 ? dy < 2 && dx < 14 : dx < 2 && dy < 14;
        if (inside) pixels[y * side + x] = [200, 216, 232, 248][kind] + i;
      }
    return { ...last, pixels };
  };
  const blocks = [0, 1, 2, 3].flatMap((k) => Array.from({ length: 8 }, (_, i) => shape(k, i)));
  const forms = readBodyFormAnimations(pe)[1];
  const at = (k: number) => frames.length + k * 8;
  const animations = [
    { record: forms.idleBody!.va, base: at(0), span: 8, start: 0, ticks: 4, mode: 2, reversed: false }, // small square
    { record: descriptor.primaryAnimation!.va, base: at(1), span: 8, start: 0, ticks: 4, mode: 2, reversed: false }, // hollow square
    { record: 0x47c640 + 2 * 0x10, base: at(2), span: 8, start: 0, ticks: 4, mode: 2, reversed: false }, // horizontal bar
    { record: forms.moveBody!.va, base: at(3), span: 8, start: 0, ticks: 2, mode: 3, reversed: false }, // vertical bar
  ];
  project.customTypes.push({ type: ROBOT, name: 'Toxic Four Foot', health: 250, speed: 100, fireRate: 100, damage: 500, sprite: { slot, data: encodeSprites([...swapped, ...blocks], 'auto') }, look: null, animations });
  layout.custom = { player: { x: 10, y: 7 }, robot: { x: 13, y: 7 }, health: 250, retail_health: descriptor.maxHealth, min_hit: 5 };
  return project;
}

/**
 * Two friends that follow the player, an armed Four Foot and a person, round a
 * course: two rooms joined by one door, a ramp up to a second storey, and a
 * teleporter there into a second area. They must not shoot the player, must
 * keep up the whole way, stand a little apart, and wander only a little.
 */
function friendMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const RAMP = 15;
  const project = createProject({ name: 'Friends', baseLevel: 'MARS', width: 26, height: 14, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const ground = project.groups[0].layers[0];
  const upper = createLayer('Upper', 26, 14);
  project.groups[0].layers.push(upper);
  ground.lighting.fill(14);
  upper.lighting.fill(14);
  // Room A (x 1..9) and room B (x 10..22), sharing the wall at x = 10 but for a door at y = 10.
  buildRoom(ground, { x0: 1, y0: 1, x1: 9, y1: 12 }, floor, 0, wall, 1);
  buildRoom(ground, { x0: 10, y0: 1, x1: 22, y1: 12 }, floor, 0, wall, 1);
  removeWalls(ground, wallRun({ x: 10, y: 10 }, { x: 10, y: 11 }));
  // A ramp east up to a landing on the upper storey, and a teleporter at its far end.
  placeRamp(project, 0, 0, 14, 4, 'east', RAMP, wall);
  const [, high] = rampFootprint(14, 4, 'east');
  for (let x = high.x + 1; x <= high.x + 4; x++) for (let y = 3; y <= 5; y++) setFloor(upper, x, y, floor, 0);
  const tele = { x: high.x + 4, y: 4 };
  const second = createLayer('Second area', 12, 10);
  second.lighting.fill(14);
  project.groups.push({ name: 'Second area', layers: [second] });
  buildRoom(second, { x0: 1, y0: 1, x1: 10, y1: 8 }, floor, 0, wall, 1);
  linkTeleporter(project, { group: 0, layer: 1, x: tele.x, y: tele.y }, { group: 1, layer: 0, x: 5, y: 4 });

  addEntity(project, ground, 1, cell(3), cell(4));
  const friend = (type: number, x: number, y: number) => {
    const route = createPath(project, 0, 0, PATH_BACK_AND_FORTH);
    route.points = [{ x: cell(x), y: cell(y), tail0: 0, tail1: 0 }, { x: cell(x), y: cell(y), tail0: 0, tail1: 0 }];
    const e = addEntity(project, ground, type, cell(x), cell(y), retailBehavior(type, 'route', 5));
    e.pathId = route.id;
    e.friendly = { follow: true };
    return { type, x, y };
  };
  layout.friends = {
    start: { x: 3, y: 4 },
    friends: [friend(ROBOT, 5, 4), friend(PERSON, 5, 6)],
    // Glide the player along this course (cells), through the door into room B and to the foot of the ramp.
    course: [{ x: 3, y: 4 }, { x: 3, y: 10 }, { x: 13, y: 10 }, { x: 12, y: 4 }],
    ramp: { from: { x: 12, y: 4 }, low: { x: 14, y: 4 }, high },
    teleporter: tele,
  };
  return project;
}

/**
 * A fight: the player, a friendly Four Foot that follows, and a hostile
 * Lockjaw made tough (255 health) so it outlasts the friend. The friend must
 * shoot it, it must shoot the friend, and the friend must die and stay dead.
 */
function fightMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Fight', baseLevel: 'MARS', width: 12, height: 10, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(14);
  // A small room with the player in the middle: everything in it stays awake.
  buildRoom(layer, { x0: 1, y0: 1, x1: 10, y1: 8 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(5), cell(4));
  const route = createPath(project, 0, 0, PATH_BACK_AND_FORTH);
  route.points = [{ x: cell(4), y: cell(5), tail0: 0, tail1: 0 }, { x: cell(4), y: cell(5), tail0: 0, tail1: 0 }];
  const friend = addEntity(project, layer, ROBOT, cell(4), cell(5), retailBehavior(ROBOT, 'route', 5));
  friend.pathId = route.id;
  friend.friendly = { follow: true };
  const LOCKJAW = 4;
  // Behaviour 7: chases the nearest target and attacks (the retail placements of a Lockjaw are mostly inactive ones).
  addEntity(project, layer, LOCKJAW, cell(9), cell(4), 7);
  project.customTypes.push({ type: LOCKJAW, name: 'Tough Lockjaw', health: 255, speed: 100, fireRate: 100, damage: 100, sprite: null, look: null });
  layout.fight = { friend: ROBOT, enemy: LOCKJAW };
  return project;
}

/**
 * Two against two: friendly Four Foot and Laughing Cavalier, following the
 * player, against two tough hostile Lockjaws. Everyone must get hurt, nobody
 * may crash the game, and the friends' shots must not hurt the player.
 */
function battleMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Battle', baseLevel: 'MARS', width: 12, height: 10, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(14);
  buildRoom(layer, { x0: 1, y0: 1, x1: 10, y1: 8 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(4), cell(4));
  const friend = (type: number, x: number, y: number) => {
    const route = createPath(project, 0, 0, PATH_BACK_AND_FORTH);
    route.points = [{ x: cell(x), y: cell(y), tail0: 0, tail1: 0 }, { x: cell(x), y: cell(y), tail0: 0, tail1: 0 }];
    const e = addEntity(project, layer, type, cell(x), cell(y), retailBehavior(type, 'route', 5));
    e.pathId = route.id;
    e.friendly = { follow: true };
  };
  const CAVALIER = 5;
  const LOCKJAW = 4;
  friend(ROBOT, 3, 5);
  friend(CAVALIER, 3, 3);
  addEntity(project, layer, LOCKJAW, cell(9), cell(3), 7);
  addEntity(project, layer, LOCKJAW, cell(9), cell(6), 7);
  project.customTypes.push({ type: LOCKJAW, name: 'Tough Lockjaw', health: 255, speed: 100, fireRate: 100, damage: 100, sprite: null, look: null });
  layout.battle = { friends: [ROBOT, CAVALIER], enemy: LOCKJAW };
  return project;
}

/**
 * Doors: a row of door cells in a wall across the room, each a full-height
 * block. One opens on touch, a pair opens together, one needs key 1 (the key
 * lies in the room) and one opens only with the switch beside the start. The
 * first rises into the ceiling, the pair slides apart and the others sink
 * into the floor.
 */
function doorsMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Doors', baseLevel: 'MARS', width: 16, height: 10, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(14);
  buildRoom(layer, { x0: 1, y0: 1, x1: 14, y1: 8 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(3), cell(2));
  // Doors stand on the room's floor; the player walks through them north to south.
  // The touch door rises into the ceiling, the pair slides apart, the key and switch doors sink into the floor.
  const door = (x: number, y: number, lock: number, style: DoorStyle = 'sink') => layer.behaviors.set(y * layer.width + x, { kind: 'door', lock, tile: wall, facing: 'ns', style });
  door(3, 5, 0, 'rise');
  door(3, 3, 0, 'slide');
  for (const x of [2, 4]) placeBlock(layer, x, 3, { height: 1, topTile: floor, sideTile: wall, pillar: false, floorTile: null });
  door(6, 5, 0, 'slide');
  door(7, 5, 0, 'slide');
  door(10, 5, 1);
  door(13, 5, 6);
  // A door with no floor of its own: the cell is emptied first.
  layer.surfaces.delete(5 * layer.width + 11);
  door(11, 5, 0, 'rise');
  layer.behaviors.set(2 * layer.width + 12, { kind: 'switch', channel: 6 });
  addEntity(project, layer, KEY_PICKUP_TYPES[0], cell(9), cell(2));
  layout.doors = {
    walking: { x: 3, y: 3 },
    touch: { x: 3, y: 5 },
    pair: [{ x: 6, y: 5 }, { x: 7, y: 5 }],
    key: { x: 10, y: 5 },
    keyAt: { x: 9, y: 2 },
    switched: { x: 13, y: 5 },
    bare: { x: 11, y: 5 },
    switchAt: { x: 12, y: 2 },
  };
  return project;
}

/**
 * Every particle of the engine's effect table, spawned by custom effects: one
 * emitter per effect id, in a grid round the player, split over maps of at
 * most `perMap` emitters. Each must play without upsetting the game.
 */
function effectMaps(perMap: number): MapProject[] {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const pe = new PeImage(new Uint8Array(readFileSync(exePath)));
  const ids: number[] = [];
  for (let id = 1; id < EFFECT_ID_COUNT; id++) if (pe.u32(0x481130 + id * 8 + 4)) ids.push(id);
  const maps: MapProject[] = [];
  for (let first = 0; first < ids.length; first += perMap) {
    const chunk = ids.slice(first, first + perMap);
    const project = createProject({ name: `Effects ${maps.length + 1}`, baseLevel: 'MARS', width: 16, height: 16, tiles: levelTiles(mars) });
    project.exitRule = 'unconditional';
    const layer = project.groups[0].layers[0];
    layer.lighting.fill(14);
    buildRoom(layer, { x0: 1, y0: 1, x1: 14, y1: 14 }, floor, 0, wall, 1);
    addEntity(project, layer, 1, cell(8), cell(8));
    chunk.forEach((fx, i) => {
      project.effects.push({ id: fx, name: `fx ${fx}`, every: 30, particles: [{ fx, spread: 0 }] });
      const e = addEntity(project, layer, CUSTOM_EFFECT_TYPE, 2 * 256 + (i % 12) * 256 + 128, 2 * 256 + Math.floor(i / 12) * 256 + 128);
      e.effect = fx;
    });
    maps.push(project);
  }
  layout.effects = { ids, perMap };
  return maps;
}

/**
 * Built props: every part shape (some turned) on one row and the builder's
 * presets on another, with the player between them. Only looked at: each
 * must draw whole, textured and the right way out from wherever it is seen.
 */
function propsMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Props', baseLevel: 'MARS', width: 20, height: 12, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(18);
  buildRoom(layer, { x0: 1, y0: 1, x1: 18, y1: 10 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(10), cell(5));
  // MARS tile 21, the main map's wall: lighter than the floor, so the shapes stand out.
  const tile = 21;
  const place = (x: number, y: number, name: string, parts: PropPart[]) => {
    const m = createModel(project, tile);
    m.name = name;
    m.parts = parts;
    project.definitions[m.definitionId] = buildPropDefinition(m);
    layer.overlays.set(y * layer.width + x, { props: [m.definitionId] });
  };
  const one = (shape: PropPart['shape'], turn: PropPart['turn'] = 0): PropPart[] => [{ shape, x: 2, y: 2, z: 0, w: 12, d: 12, h: 12, turn, tile, ...(shape === 'cylinder' || shape === 'cone' ? { sides: 8 } : {}) }];
  (['box', 'wedge', 'pyramid', 'roof', 'cylinder', 'cone'] as const).forEach((shape, i) => place(3 + i * 2, 3, shape, one(shape)));
  place(15, 3, 'wedge east', one('wedge', 1));
  place(17, 3, 'roof turned', one('roof', 1));
  ['Window', 'Doorway', 'Column', 'Stairs', 'Table', 'Hut', 'Tower', 'Lamp'].forEach((name, i) => place(3 + i * 2, 7, name, presetParts(PROP_PRESETS.find((p) => p.name === name)!, tile)));
  layout.props = { spots: [{ x: 5, y: 4 }, { x: 10, y: 4 }, { x: 15, y: 4 }, { x: 5, y: 6 }, { x: 10, y: 6 }, { x: 15, y: 6 }] };
  return project;
}

/**
 * A trigger pad that does everything a trigger can: breaks a block to rubble
 * and another into its broken version, retiles a floor, plays an effect and
 * reveals a robot that starts disabled.
 */
function triggersMap(): MapProject {
  const mars = level('MARS');
  const { floor, wall } = commonTiles(levelMap(mars));
  const project = createProject({ name: 'Triggers', baseLevel: 'MARS', width: 16, height: 10, tiles: levelTiles(mars) });
  project.exitRule = 'unconditional';
  const layer = project.groups[0].layers[0];
  layer.lighting.fill(16);
  buildRoom(layer, { x0: 1, y0: 1, x1: 14, y1: 8 }, floor, 0, wall, 1);
  addEntity(project, layer, 1, cell(3), cell(5));
  const index = (x: number, y: number) => y * layer.width + x;
  const block = (x: number, y: number) => layer.surfaces.set(index(x, y), { kind: 'block', height: 1, topTile: wall, sides: { north: wall, east: wall, south: wall, west: wall }, pillar: false, floorTile: null });
  layer.behaviors.set(index(5, 5), { kind: 'switch', channel: 6 });
  block(8, 3);
  layer.behaviors.set(index(8, 3), { kind: 'breakable', toughness: 30, effect: 26, leaves: floor });
  block(10, 3);
  layer.behaviors.set(index(10, 3), { kind: 'breakable', toughness: 30, effect: 8, leaves: floor, result: 'broken', broken: 21 });
  const robot = addEntity(project, layer, ROBOT, cell(7), cell(7), retailBehavior(ROBOT, 'none', 7));
  robot.disabled = true;
  project.effects.push({ id: 900, name: 'Boom', every: 30, particles: [{ fx: 0x7d, spread: 32 }] });
  project.triggers.push({
    channel: 6,
    name: 'Everything',
    once: true,
    actions: [
      { kind: 'break', group: 0, layer: 0, x: 8, y: 3 },
      { kind: 'break', group: 0, layer: 0, x: 10, y: 3 },
      { kind: 'retexture', group: 0, layer: 0, x: 8, y: 6, tile: 21, faces: 'floor' },
      { kind: 'effect', group: 0, layer: 0, x: cell(12), y: cell(5), effect: 900 },
      { kind: 'reveal', group: 0, layer: 0, entity: robot.id },
    ],
  });
  layout.triggers = { pad: { x: 5, y: 5 }, rubble: { x: 8, y: 3 }, broken: { x: 10, y: 3 }, retiled: { x: 8, y: 6 }, robot: { x: 7, y: 7, type: ROBOT } };
  return project;
}

/* ================================================================== write */

mkdirSync(join(out, 'maps'), { recursive: true });
const main = write('game-checks', mainMap());
write('second-area', secondMap());
write('custom-enemy', customMap());
write('friend', friendMap());
write('fight', fightMap());
write('battle', battleMap());
write('doors', doorsMap());
const doorProjectAt = process.argv.indexOf('--door-project');
if (doorProjectAt > 0) {
  const p = openMhproject(readFileSync(resolve(process.argv[doorProjectAt + 1])));
  const group = p.initialGroup;
  const layer = p.groups[group].layers[0];
  const doorEntries = [...layer.behaviors].filter(([, b]) => b.kind === 'door');
  const entry = doorEntries.find(([, b]) => b.kind === 'door' && layer.entities.some((e) => e.type === KEY_PICKUP_TYPES[b.lock - 1])) ?? doorEntries[0];
  if (!entry || entry[1].kind !== 'door') throw new Error('Door regression needs a door on the starting area ground layer');
  const [index, door] = entry;
  if (door.facing !== 'ns') throw new Error('Project door regression currently approaches north-south doors');
  const key = layer.entities.find((e) => e.type === KEY_PICKUP_TYPES[door.lock - 1]);
  const projectPe = new PeImage(new Uint8Array(readFileSync(exePath)));
  const robot = layer.entities.find((e) => {
    const descriptor = readEntityType(projectPe, e.type).descriptor;
    return descriptor && (descriptor.flags & 0xf) >= 2 && (descriptor.flags & 0xf) <= 10 && (descriptor.flags & 0x20000000) !== 0;
  });
  layout.userDoors = [...layer.behaviors].flatMap(([i, b]) => b.kind === 'door' ? [{ group, layer: 0, x: i % layer.width, y: Math.floor(i / layer.width), lock: b.lock, facing: b.facing }] : []);
  const otherRobot = layer.entities.find((e) => e.type === 4);
  layout.corridorRobot = otherRobot ? { type: otherRobot.type, x: otherRobot.x / 256 - 0.5, y: otherRobot.y / 256 - 0.5 } : null;
  layout.userDoor = { group, layer: 0, x: index % layer.width, y: Math.floor(index / layer.width), lock: door.lock, keyAt: key ? { x: key.x / 256 - 0.5, y: key.y / 256 - 0.5 } : null, robot: robot ? { type: robot.type, x: robot.x / 256 - 0.5, y: robot.y / 256 - 0.5 } : null };
  write('user-door', p);
}

write('props', propsMap());
write('triggers', triggersMap());
if (process.argv.includes('--effects')) effectMaps(96).forEach((p, i) => write(`effects-${i + 1}`, p));
for (let i = 1; i <= copies; i++) writeFileSync(join(out, 'maps', `page-test-${i}.mhproject`), main);

// A plain room on every theme. Six themes once crashed on load (see MHMapsMenu.c, HUD percentage).
if (process.argv.includes('--themes')) {
  mkdirSync(join(out, 'themes'), { recursive: true });
  for (const l of levels.slice(0, 17)) {
    const { floor, wall } = commonTiles(levelMap(l));
    const project = createProject({ name: `Theme ${l.id}`, baseLevel: l.id, width: 12, height: 12, tiles: levelTiles(l) });
    project.exitRule = 'unconditional';
    buildRoom(project.groups[0].layers[0], { x0: 1, y0: 1, x1: 10, y1: 10 }, floor, 0, wall, 1);
    addEntity(project, project.groups[0].layers[0], 1, cell(3), cell(3));
    writeFileSync(join(out, 'themes', `theme-${l.id.toLowerCase()}.mhproject`), buildMhproject(project, { requirePlayable: true }).bytes);
  }
}

/** The layout as a Lua table: the checking script dofile()s it. */
function lua(value: unknown): string {
  if (Array.isArray(value)) return `{ ${value.map((v) => lua(v)).join(', ')} }`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `[${JSON.stringify(k)}] = ${lua(v)}`).join(', ')} }`;
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}
writeFileSync(join(out, 'layout.lua'), `-- Generated by scripts/game-checks.ts.\nreturn ${lua(layout)}\n`);
console.log(`wrote ${out}`);
