import { describe, expect, it } from 'vitest';
import { PATH_BACK_AND_FORTH, PATH_LOOP, PATH_ONCE, PATH_ZONE } from '@mh/core';
import { snapPlacement } from '../src/editor/ops.ts';
import { WALK_SPEED, planWalk, walkerAt } from '../src/editor/pathsim.ts';

describe('placing entities', () => {
  it('snap to the nearest cell center or corner', () => {
    expect(snapPlacement(256 + 120, 512 + 140, false)).toEqual({ x: 384, y: 640 }); // near the middle of cell (1, 2)
    expect(snapPlacement(256 + 20, 512 + 30, false)).toEqual({ x: 256, y: 512 }); // near its north-west corner
    expect(snapPlacement(256 + 240, 512 + 250, false)).toEqual({ x: 512, y: 768 }); // near its south-east corner
    expect(snapPlacement(256 + 128, 512 + 10, false)).toEqual({ x: 384, y: 640 }); // edge middles go to the center
  });

  it('go exactly where they are dropped when free', () => {
    expect(snapPlacement(300.4, 701.6, true)).toEqual({ x: 300, y: 702 });
  });
});

/** The points a walker is at when it stops moving between legs, in order, over `seconds`. */
function stops(mode: number, points: { x: number; y: number }[], seconds: number) {
  const start = points[0];
  const plan = planWalk(mode, points, start);
  const seen: string[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const at = walkerAt(plan, t, start);
    const hit = points.findIndex((p) => Math.abs(p.x - at.x) < 6 && Math.abs(p.y - at.y) < 6);
    if (hit >= 0 && seen[seen.length - 1] !== String(hit + 1)) seen.push(String(hit + 1));
  }
  return seen.join('');
}

describe('previewing a walk along a path', () => {
  // Three points a cell apart in a row: half a second between neighbors at a steady walk.
  const row = [0, 1, 2].map((i) => ({ x: 128 + i * 256, y: 128 }));
  const step = 256 / WALK_SPEED;

  it('goes back and forth', () => {
    expect(stops(PATH_BACK_AND_FORTH, row, step * 8)).toBe('123212321');
  });

  it('goes round and round, from the last point straight to the first', () => {
    // An L, so the way back to the first point does not pass the second.
    const ell = [{ x: 128, y: 128 }, { x: 640, y: 128 }, { x: 640, y: 640 }];
    expect(stops(PATH_LOOP, ell, step * 10)).toBe('12312');
  });

  it('stays at the first point', () => {
    expect(stops(PATH_ONCE, row, step * 8)).toBe('1');
  });

  it('walks from where the entity stands to the first point', () => {
    const plan = planWalk(PATH_LOOP, row, { x: 128, y: 128 + 512 });
    expect(walkerAt(plan, 0, row[0])).toMatchObject({ x: 128, y: 640 });
    expect(walkerAt(plan, step * 2, row[0])).toMatchObject({ x: 128, y: 128 });
    // Heading north on the way there.
    expect(walkerAt(plan, step, row[0]).heading).toBeCloseTo(0);
  });

  it('copes with a zone whose places are all one spot', () => {
    // Once hung the page: there was never a second place to walk to.
    const spot = { x: 640, y: 640 };
    const plan = planWalk(PATH_ZONE, [spot, spot, spot], { x: 128, y: 128 });
    expect(plan.cycle).toEqual([]);
    expect(walkerAt(plan, 60, spot)).toMatchObject({ x: 640, y: 640, moving: false });
    expect(planWalk(PATH_ZONE, [spot], spot).cycle).toEqual([]);
  });

  it('wanders between the nine places of a zone', () => {
    const corners = [{ x: 0, y: 0 }, { x: 512, y: 256 }, { x: 1024, y: 512 }];
    const plan = planWalk(PATH_ZONE, corners, { x: 0, y: 0 }, 7);
    const places = new Set<string>();
    for (const leg of [...plan.intro, ...plan.cycle]) places.add(`${leg.to.x},${leg.to.y}`);
    for (const p of places) {
      const [x, y] = p.split(',').map(Number);
      expect(corners.some((c) => c.x === x)).toBe(true);
      expect(corners.some((c) => c.y === y)).toBe(true);
    }
    expect(places.size).toBeGreaterThan(4);
  });
});
