import { describe, expect, it } from 'vitest';
import {
  type Archive,
  LevelPalette,
  compositeSourcePalette,
  decodeBmp,
  decodePal,
  decodePlt,
  decodeSprites,
  decodeTerrainBank,
  encodeBmp,
  encodeSprites,
  encodeTerrainBank,
  fullbrightFromMsk,
  generateBrt,
  generateRmp,
  readBriefings,
  readEntityType,
  readLevelTable,
  readSoundEffects,
} from '../src/index.ts';
import { gameArchive, hasGameData, retailExe } from './game.ts';

describe('synthetic format round trips', () => {
  it('sprite container encodes and decodes every codec', () => {
    const noise = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff);
    const flat = new Uint8Array(1024).fill(9);
    const frames = [
      { scale: 1 as const, pixels: noise, codec: 'raw' as const },
      { scale: 2 as const, pixels: flat, codec: 'rle' as const },
      { scale: 4 as const, pixels: Uint8Array.from({ length: 256 }, (_, i) => (i < 200 ? 3 : i)), codec: 'rle' as const },
    ];
    for (const codec of ['auto', 'raw', 'rle', 'preserve'] as const) {
      const back = decodeSprites(encodeSprites(frames, codec));
      expect(back.map((f) => [f.scale, Array.from(f.pixels)])).toEqual(frames.map((f) => [f.scale, Array.from(f.pixels)]));
    }
  });

  it('bmp round trip keeps pixels and palette', () => {
    const palette = Uint8Array.from({ length: 768 }, (_, i) => (i * 5) & 0xff);
    const pixels = Uint8Array.from({ length: 220 * 160 }, (_, i) => (i * 31) & 0xff);
    const back = decodeBmp(encodeBmp({ width: 220, height: 160, palette, pixels }));
    expect(back.width).toBe(220);
    expect(back.height).toBe(160);
    expect(Array.from(back.pixels)).toEqual(Array.from(pixels));
    expect(Array.from(back.palette)).toEqual(Array.from(palette));
  });
});

describe.skipIf(!hasGameData)('retail DATA.ARC', () => {
  const arc: Archive = hasGameData ? gameArchive() : (undefined as never);

  it('opens and decompresses every member', () => {
    expect(arc.entries.length).toBe(682);
    for (const entry of arc.entries) expect(arc.read(entry).length).toBeGreaterThan(0);
  });

  it('decodes all 3,341 sprite frames and re-encodes them losslessly', () => {
    let frames = 0;
    for (const entry of arc.withExtension('.B')) {
      const decoded = decodeSprites(arc.read(entry));
      frames += decoded.length;
      const again = decodeSprites(encodeSprites(decoded, 'auto'));
      expect(again.length).toBe(decoded.length);
      for (let i = 0; i < decoded.length; i++) expect(again[i].pixels).toEqual(decoded[i].pixels);
    }
    expect(arc.withExtension('.B').length).toBe(122);
    expect(frames).toBe(3341);
  });

  it('terrain banks round trip byte for byte', () => {
    for (const entry of arc.withExtension('.BIN')) {
      const bytes = arc.read(entry);
      expect(encodeTerrainBank(decodeTerrainBank(bytes))).toEqual(bytes);
    }
  });

  it('level table names real archive members', () => {
    const levels = readLevelTable(retailExe());
    expect(levels.length).toBe(25);
    for (const level of levels) {
      expect(arc.entries[level.resources.map].name).toBe(`${level.id}.MAP`);
      expect(arc.entries[level.resources.terrain].name.endsWith('.BIN')).toBe(true);
      expect(level.sprites.length).toBeGreaterThan(0);
      for (const s of level.sprites) expect(arc.entries[s.archiveId].name.endsWith('.B')).toBe(true);
    }
    expect(levels[6].initialGroup).toBe(1); // HOSP0
    expect(levels[9].initialGroup).toBe(2); // POWER3
  });

  it('regenerates the retail BRT and RMP tables exactly', () => {
    const mars = readLevelTable(retailExe())[0].resources;
    const source = compositeSourcePalette(decodePal(arc.read('CONTROL.PAL')), decodePal(arc.read('OBJECTS.PAL')), decodePal(arc.read(mars.pal)), decodePal(arc.read('SPRITES.PAL')));
    const plt = decodePlt(arc.read(mars.plt));
    expect(generateRmp(plt)).toEqual(arc.read(mars.rmp));
    expect(generateBrt(source, plt, fullbrightFromMsk(arc.read(mars.msk)))).toEqual(arc.read(mars.brt));
    const palette = new LevelPalette(arc.read(mars.plt), arc.read(mars.brt), arc.read(mars.rmp));
    expect(palette.rgbaTable().length).toBe(1024);
  });

  it('reads executable tables', () => {
    const exe = retailExe();
    const briefings = readBriefings(exe);
    expect(briefings[0].text.startsWith('WHEN YOU LAND AT THE DIG')).toBe(true);
    expect(arc.entries[briefings[0].imageArchiveId].name).toBe('MARS.BMP');
    const sounds = readSoundEffects(exe);
    expect(sounds.length).toBe(461);
    expect(sounds[0].sample).toBe('MS_ERROR.RAW');
    const fourFoot = readEntityType(exe, 3);
    expect(fourFoot.descriptor?.maxHealth).toBe(109);
    expect(fourFoot.descriptor?.radius).toBe(73);
    expect(fourFoot.descriptor?.primaryAnimation?.slot).toBe(3);
    expect(fourFoot.descriptor?.primaryAnimation?.frameBase).toBe(49);
    expect(readEntityType(exe, 98).descriptor?.maxHealth).toBe(240); // TANK
    const bmp = decodeBmp(arc.read('MARS.BMP'));
    expect([bmp.width, bmp.height]).toEqual([220, 160]);
  });
});
