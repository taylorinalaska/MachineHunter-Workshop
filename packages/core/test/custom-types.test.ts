import { describe, expect, it } from 'vitest';
import { CUSTOM_EFFECT_TYPE, type CustomType, type MapProject, buildMhproject, createProject, encodeSprites, fromUtf8, openMhproject, unzipStored, validateProject } from '../src/index.ts';

function mapWith(customTypes: CustomType[]): MapProject {
  const p = createProject({ name: 'Custom', baseLevel: 'MARS', width: 8, height: 8, tiles: [new Uint8Array(64 * 64)] });
  const layer = p.groups[0].layers[0];
  layer.cells.fill(0);
  layer.entities.push({ id: p.nextId++, type: 1, x: 3 * 256 + 128, y: 3 * 256 + 128, behavior: 0, weapon: 0, pathId: null, disabled: false } as MapProject['groups'][0]['layers'][0]['entities'][0]);
  p.customTypes = customTypes;
  return p;
}

const sprite = encodeSprites([{ scale: 2, pixels: new Uint8Array(32 * 32).fill(7), codec: 'raw' }], 'auto');
const toxic: CustomType = { type: 3, name: 'Toxic Four Foot', health: 250, speed: 150, fireRate: 100, damage: 200, sprite: { slot: 3, data: sprite }, look: { kind: 'recolor', hue: 120, saturation: 100, brightness: 100 } };

describe('custom enemies', () => {
  it('survive saving and opening the map', () => {
    const back = openMhproject(buildMhproject(mapWith([toxic])).bytes);
    expect(back.customTypes).toHaveLength(1);
    expect(back.customTypes[0]).toMatchObject({ type: 3, name: 'Toxic Four Foot', health: 250, speed: 150, damage: 200, look: { kind: 'recolor', hue: 120 } });
    expect([...back.customTypes[0].sprite!.data]).toEqual([...sprite]);
  });

  it('give the runtime their sprites and numbers', () => {
    const built = buildMhproject(mapWith([toxic, { ...toxic, type: 4, name: 'Plain', health: null, speed: 100, damage: 100, sprite: null, look: null }]));
    const files = unzipStored(built.bytes);
    const manifest = JSON.parse(fromUtf8(files.get('runtime/manifest.json')!));
    expect(manifest.assets.sprites).toEqual({ '3': 'runtime/sprites/3.b' });
    expect([...files.get('runtime/sprites/3.b')!]).toEqual([...sprite]);
    // A type with nothing changed but its name and look needs no override.
    expect(manifest.entity_overrides).toEqual([{ type: 3, health: 250, speed_pct: 150, fire_rate_pct: 100, damage_pct: 200 }]);
  });

  it('carry retimed animations', () => {
    const walk = { record: 0x47c8d0, base: 72, span: 8, start: 0, ticks: 2, mode: 3, reversed: true };
    const back = openMhproject(buildMhproject(mapWith([{ ...toxic, animations: [walk] }])).bytes);
    expect(back.customTypes[0].animations).toEqual([walk]);
    const files = unzipStored(buildMhproject(mapWith([{ ...toxic, animations: [walk] }])).bytes);
    const manifest = JSON.parse(fromUtf8(files.get('runtime/manifest.json')!));
    expect(manifest.entity_overrides[0].animations).toEqual([{ record: 0x47c8d0, base: 72, span: 8, start: 0, ticks: 2, mode: 3, reversed: 1 }]);
    // A look and new animations with the numbers left alone still need an override entry.
    const plain = { ...toxic, health: null, speed: 100, damage: 100, animations: [walk] };
    expect(JSON.parse(fromUtf8(unzipStored(buildMhproject(mapWith([plain])).bytes).get('runtime/manifest.json')!)).entity_overrides).toHaveLength(1);
  });

  it('are checked against what the game accepts', () => {
    const messages = (types: CustomType[]) => validateProject(mapWith(types)).map((i) => i.message).join(' ');
    expect(messages([{ ...toxic, health: 300 }])).toMatch(/health from 1 to 255/);
    expect(messages([{ ...toxic, damage: 900 }])).toMatch(/damage from 10% to 500%/);
    expect(messages([toxic, { ...toxic, name: 'Again' }])).toMatch(/customized twice/);
    expect(messages([toxic, { ...toxic, type: 2, name: 'Shared' }])).toMatch(/sprite slot 3/);
    expect(messages([{ ...toxic, type: 1 }])).toMatch(/cannot be customized/);
    const anim = { record: 0x47c8d0, base: 0, span: 4, start: 0, ticks: 2, mode: 2, reversed: false };
    expect(messages([{ ...toxic, animations: [{ ...anim, start: 4 }] }])).toMatch(/impossible numbers/);
    expect(messages([{ ...toxic, animations: [anim, anim] }])).toMatch(/already changed/);
  });

  it('place effects the runtime spawns instead of map objects', () => {
    const p = mapWith([]);
    p.effects.push({ id: 900, name: 'Fire', every: 4, particles: [{ fx: 0xa7, spread: 32 }, { fx: 0x7d, spread: 32 }] });
    const layer = p.groups[0].layers[0];
    layer.entities.push({ ...layer.entities[0], id: 901, type: CUSTOM_EFFECT_TYPE, x: 5 * 256 + 128, y: 6 * 256 + 128, effect: 900 });
    const built = buildMhproject(p);
    const manifest = JSON.parse(fromUtf8(unzipStored(built.bytes).get('runtime/manifest.json')!));
    expect(manifest.effects).toEqual([{ group: 0, x: 5 * 256 + 128, y: 6 * 256 + 128, z: 0, every: 4, particles: [{ fx: 0xa7, spread: 32 }, { fx: 0x7d, spread: 32 }] }]);
    // Only the player start is a map object.
    expect(built.compiled!.map.groups[0].layers[0].objects).toHaveLength(1);
    expect(openMhproject(built.bytes).effects).toEqual(p.effects);
    const bad = mapWith([]);
    bad.effects.push({ id: 1, name: 'Nothing', every: 0, particles: [] });
    expect(validateProject(bad).map((i) => i.message).join(' ')).toMatch(/one to 3 particles.*rate of 1 to 255/);
  });

  it('list friendly characters for the runtime', () => {
    const p = mapWith([]);
    const layer = p.groups[0].layers[0];
    layer.entities.push({ ...layer.entities[0], id: 950, type: 3, x: 5 * 256 + 128, y: 6 * 256 + 128, pathId: null, friendly: { follow: true } });
    const built = buildMhproject(p);
    const manifest = JSON.parse(fromUtf8(unzipStored(built.bytes).get('runtime/manifest.json')!));
    expect(manifest.friends).toEqual([{ group: 0, layer: 0, x: 5 * 256 + 128, y: 6 * 256 + 128, type: 3, follow: 1 }]);
    // It is still an ordinary map object, and the map warns that a follower without a route stays put.
    expect(built.compiled!.map.groups[0].layers[0].objects).toHaveLength(2);
    expect(validateProject(p).map((i) => i.message).join(' ')).toMatch(/needs a route/);
    expect(openMhproject(built.bytes).groups[0].layers[0].entities.find((e) => e.id === 950)!.friendly).toEqual({ follow: true });
  });
});
