/**
 * Builds a small showcase map with the same code the Workshop uses, saves it
 * as a project, and (with --install) puts it in the game's Workshop mod.
 *
 *   npx tsx scripts/make-demo-map.ts [--install] [--extra-tiles]
 *
 * --extra-tiles adds enough generated tiles to pass the original engine's
 * 128-tile limit and floors a strip by the start with the last of them, to
 * check the runtime's relocated tile table.
 *
 * It doubles as an end-to-end check of the compiler and packager against the
 * real game, and as an example of building maps from code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, BRIEFING_IMAGE_HEIGHT, BRIEFING_IMAGE_WIDTH, PATH_LOOP, PeImage, buildMhproject, buildPropDefinition, cellIndex, createLayer, createProject, decodeBmp, decodeTerrainBank, encodeBmp, modManifest, nearestIndex, readBriefings, readLevelTable } from '../packages/core/src/index.ts';
import { addEntity, addOverlayProp, addWalls, brushLight, buildRoom, createModel, createPath, linkTeleporter, placeBlock, placeRamp, setBehavior, setFloor, wallRun } from '../apps/workshop/src/editor/ops.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = join(root, 'game', 'DATA', 'DATA.ARC');
const exePath = join(root, 'retail', 'MACHHUNT_ORIGINAL.EXE');
if (!existsSync(archivePath) || !existsSync(exePath)) {
  console.error('This script needs game/DATA/DATA.ARC and retail/MACHHUNT_ORIGINAL.EXE.');
  process.exit(1);
}
const archive = new Archive(new Uint8Array(readFileSync(archivePath)));
const exe = new PeImage(new Uint8Array(readFileSync(exePath)));
const mars = readLevelTable(exe)[0];
const tiles = decodeTerrainBank(archive.read(mars.resources.terrain));

// MARS tiles: the retail level floors its rooms with 12 and walls them with 20/21.
const FLOOR = 12;
const WALL = 21;
const RAMP = 15;
const cell = (n: number) => n * 256 + 128;

const project = createProject({ name: 'Workshop demo', baseLevel: 'MARS', width: 28, height: 20, tiles });
project.author = 'Machine Hunter Workshop';
project.description = 'Two rooms, a ramp to an upper walkway, a teleporter and an exit.';
const ground = project.groups[0].layers[0];
const upper = createLayer('Walkway', 28, 20);
project.groups[0].layers.push(upper);

// Start room, corridor and arena.
buildRoom(ground, { x0: 2, y0: 6, x1: 8, y1: 13 }, FLOOR, 0, WALL, 1);
buildRoom(ground, { x0: 14, y0: 3, x1: 25, y1: 16 }, FLOOR, 0, WALL, 1);
for (let x = 9; x <= 13; x++) for (let y = 9; y <= 10; y++) setFloor(ground, x, y, FLOOR, 0);
addWalls(ground, [...wallRun({ x: 9, y: 9 }, { x: 14, y: 9 }), ...wallRun({ x: 9, y: 11 }, { x: 14, y: 11 })], WALL, 1);
// Doorways: knock the corridor ends out of the two room walls.
for (const y of [9, 10]) {
  ground.walls.delete(`9,${y},9,${y + 1}`);
  ground.walls.delete(`14,${y},14,${y + 1}`);
}
// A low divider and a diagonal corner inside the arena.
addWalls(ground, wallRun({ x: 18, y: 7 }, { x: 18, y: 12 }), WALL, 0.5);
addWalls(ground, wallRun({ x: 23, y: 3 }, { x: 26, y: 6 }), WALL, 1);

// Ramp from the arena floor up to a walkway along its east side, each side in its own tile.
placeRamp(project, 0, 0, 21, 14, 'east', RAMP, WALL);
for (const x of [21, 22]) {
  const ramp = ground.surfaces.get(cellIndex(ground, x, 14));
  if (ramp?.kind === 'ramp') Object.assign(ramp.sides, { north: 20, south: 12 });
}

// Blocks around the start: a low crate, a half-height plinth, a full block and a pillar.
const block = { topTile: RAMP, sideTile: WALL, floorTile: FLOOR };
placeBlock(ground, 6, 9, { ...block, height: 0.25, pillar: false });
placeBlock(ground, 6, 11, { ...block, height: 0.5, pillar: false });
placeBlock(ground, 7, 12, { ...block, height: 1, pillar: false });
placeBlock(ground, 3, 8, { ...block, height: 1, pillar: true });

if (process.argv.includes('--extra-tiles')) {
  // Copies of the level's tiles with a bright cross, so they are easy to tell apart on screen.
  const base = project.tiles.length;
  for (let i = 0; base + i < 160; i++) {
    const tile = project.tiles[i % base].slice();
    for (let k = 0; k < 64; k++) tile[k * 64 + k] = tile[k * 64 + 63 - k] = tile[k * 64 + ((k + 1) & 63)] = 0xb0 + (i % 16);
    project.tiles.push(tile);
  }
  for (let x = 3; x <= 5; x++) setFloor(ground, x, 11, project.tiles.length - 1 - (x - 3), 0);
  console.log(`terrain bank grown from ${base} to ${project.tiles.length} tiles`);
}
for (let y = 8; y <= 14; y++) for (let x = 23; x <= 25; x++) setFloor(upper, x, y, FLOOR, 0);
addWalls(upper, [...wallRun({ x: 23, y: 8 }, { x: 26, y: 8 }), ...wallRun({ x: 26, y: 8 }, { x: 26, y: 15 }), ...wallRun({ x: 23, y: 8 }, { x: 23, y: 14 })], WALL, 0.25);

// Lighting: dim rooms with pools of light.
ground.lighting.fill(9);
upper.lighting.fill(12);
brushLight(ground, 5.5, 10, 4, 24, 1);
brushLight(ground, 20, 9.5, 6, 22, 1);
brushLight(upper, 24.5, 11, 3, 26, 1);

// Entities.
addEntity(project, ground, 1, cell(4), cell(10)); // player start
addEntity(project, ground, 45, cell(7), cell(8)); // energy
addEntity(project, ground, 16, cell(7), cell(12)); // power level 2
// A Four Foot patrolling a loop round the arena: behaviour 5 is what the retail levels give a robot on a route.
const sentry = addEntity(project, ground, 3, cell(16), cell(6), 5);
const route = createPath(project, 0, 0, PATH_LOOP);
route.points = [[16, 5], [23, 5], [23, 13], [16, 13]].map(([x, y]) => ({ x: cell(x), y: cell(y), tail0: 0, tail1: 0 }));
sentry.pathId = route.id;
addEntity(project, ground, 3, cell(20), cell(13), 7);

// A built prop: a barricade across the corridor that can be shot away.
const barricade = createModel(project, WALL);
barricade.name = 'Barricade';
barricade.parts = [{ shape: 'box', x: 6, y: 0, z: 0, w: 4, d: 16, h: 10, turn: 0, tile: WALL }];
project.definitions[barricade.definitionId] = buildPropDefinition(barricade);
for (const y of [9, 10]) {
  addOverlayProp(ground, 11, y, barricade.definitionId);
  ground.overlays.get(cellIndex(ground, 11, y))!.breakable = { toughness: 6, effect: 8 };
}
addEntity(project, ground, 4, cell(22), cell(6), 6); // Lockjaw
addEntity(project, upper, 45, cell(24), cell(9));

// A teleporter from the start room to the walkway, and an exit at the walkway's end.
linkTeleporter(project, { group: 0, layer: 0, x: 3, y: 7 }, { group: 0, layer: 1, x: 24, y: 13 });
for (const [x, y] of [[24, 9], [25, 9], [24, 10], [25, 10]]) setBehavior(upper, x, y, { kind: 'exit' });

/**
 * A briefing picture whose right way up is obvious: an arrow pointing up above
 * a solid bar, in the colours of the level's own briefing picture.
 */
function briefingPicture(): Uint8Array {
  const retail = decodeBmp(archive.read(readBriefings(exe)[0].imageArchiveId));
  const pixels = new Uint8Array(BRIEFING_IMAGE_WIDTH * BRIEFING_IMAGE_HEIGHT).fill(nearestIndex(retail.palette, 8, 12, 20));
  const white = nearestIndex(retail.palette, 230, 230, 230);
  const orange = nearestIndex(retail.palette, 230, 120, 30);
  for (let y = 0; y < BRIEFING_IMAGE_HEIGHT; y++) {
    for (let x = 0; x < BRIEFING_IMAGE_WIDTH; x++) {
      const dx = Math.abs(x - 170);
      const head = y >= 20 && y < 60 && dx <= (y - 20) * 0.7;
      const shaft = y >= 60 && y < 120 && dx <= 7;
      if (head || shaft) pixels[y * BRIEFING_IMAGE_WIDTH + x] = white;
      if (y >= 140 && y < 152 && x >= 130 && x < 210) pixels[y * BRIEFING_IMAGE_WIDTH + x] = orange;
    }
  }
  return encodeBmp({ width: BRIEFING_IMAGE_WIDTH, height: BRIEFING_IMAGE_HEIGHT, palette: retail.palette, pixels });
}

project.briefing = {
  mode: 'custom',
  title: 'WORKSHOP DEMO',
  text: 'THIS MAP WAS BUILT WITH\nTHE MACHINE HUNTER\nWORKSHOP.\n\nCLEAR THE ARENA, CLIMB\nTHE RAMP AND REACH THE\nEXIT ON THE WALKWAY.',
  image: briefingPicture(),
};

const built = buildMhproject(project, { requirePlayable: true });
for (const issue of built.issues) console.log(`${issue.level}: ${issue.message}`);
const stats = built.compiled!.stats;
console.log(`compiled: ${stats.mapBytes} byte MAP, ${stats.definitions} cell shapes, ${stats.objects} entities, ${stats.tiles} tiles (${stats.generatedTiles} cut)`);

mkdirSync(join(root, 'projects'), { recursive: true });
writeFileSync(join(root, 'projects', 'workshop-demo.mhproject'), built.bytes);
console.log('saved projects/workshop-demo.mhproject');

if (process.argv.includes('--install')) {
  const mod = join(root, 'game', 'mods', 'workshop');
  mkdirSync(join(mod, 'maps'), { recursive: true });
  writeFileSync(join(mod, 'mod.json'), modManifest({ id: 'workshop', name: 'Workshop maps', version: '1.0.0', description: 'Maps installed from the Machine Hunter Workshop.' }));
  writeFileSync(join(mod, 'maps', 'workshop-demo.mhproject'), built.bytes);
  console.log('installed game/mods/workshop/maps/workshop-demo.mhproject');
}
