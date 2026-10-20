/**
 * A preview of how an entity walks a path, for the editor to play. It shows
 * the order the points are visited in, which is what the path modes decide;
 * the pace is a steady walk, not each entity's own speed, and robots in the
 * game leave the path to fight once they notice the player.
 */
import { PATH_BACK_AND_FORTH, PATH_ONCE, PATH_ZONE } from '@mh/core';

export interface SimPoint {
  x: number;
  y: number;
}

/** Walk from `from` to `to`, then wait `pause` seconds. */
interface Leg {
  from: SimPoint;
  to: SimPoint;
  walk: number;
  pause: number;
}

export interface WalkPlan {
  /** From where the entity stands to where the path starts; played once. */
  intro: Leg[];
  /** Then this, over and over (empty: it stays at the end of the intro). */
  cycle: Leg[];
}

export interface WalkerState {
  x: number;
  y: number;
  /** Direction of travel, radians clockwise from north. */
  heading: number;
  moving: boolean;
}

/** A steady walk: two cells a second, in map units (256 a cell). */
export const WALK_SPEED = 512;
/** How long a wanderer waits at each place it picks. */
const ZONE_PAUSE = 0.8;
/** Places a wanderer visits before the preview repeats itself. */
const ZONE_VISITS = 24;

const distance = (a: SimPoint, b: SimPoint) => Math.hypot(b.x - a.x, b.y - a.y);

function legs(stops: SimPoint[], from: SimPoint, speed: number, pause = 0): Leg[] {
  const out: Leg[] = [];
  let at = from;
  for (const to of stops) {
    out.push({ from: at, to, walk: distance(at, to) / speed, pause });
    at = to;
  }
  return out;
}

/** A small seeded generator, so a zone's preview is the same each time it is played. */
function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * The walk an entity standing at `start` takes along a path with mode `mode`
 * and `points` (see PATH_* in @mh/core): back and forth through the points,
 * round and round, staying at the first one, or, for a zone, from one of its
 * nine places (every pairing of the three X values with the three Y values)
 * to another at random.
 */
export function planWalk(mode: number, points: readonly SimPoint[], start: SimPoint, seed = 1, speed = WALK_SPEED): WalkPlan {
  if (!points.length) return { intro: [], cycle: [] };
  if (mode === PATH_ZONE) {
    // Distinct places only: a zone still being drawn (one point, or a flat rectangle) has fewer than nine.
    const places = [...new Map(points.flatMap((a) => points.map((b) => [`${a.x},${b.y}`, { x: a.x, y: b.y }] as const))).values()];
    if (places.length < 2) return { intro: legs([places[0]], start, speed), cycle: [] };
    const next = random(seed);
    const visits: SimPoint[] = [];
    while (visits.length < ZONE_VISITS) {
      const place = places[Math.floor(next() * places.length)];
      const last = visits[visits.length - 1];
      if (!last || last.x !== place.x || last.y !== place.y) visits.push(place);
    }
    const intro = legs([visits[0]], start, speed, ZONE_PAUSE);
    return { intro, cycle: legs([...visits.slice(1), visits[0]], visits[0], speed, ZONE_PAUSE) };
  }
  const first = points[0];
  const intro = legs([first], start, speed);
  if (mode === PATH_ONCE || points.length < 2) return { intro, cycle: [] };
  const rest = points.slice(1);
  if (mode === PATH_BACK_AND_FORTH) return { intro, cycle: legs([...rest, ...points.slice(0, -1).reverse()], first, speed) };
  return { intro, cycle: legs([...rest, first], first, speed) };
}

const headingOf = (leg: Leg, fallback: number) => (leg.to.x === leg.from.x && leg.to.y === leg.from.y ? fallback : Math.atan2(leg.to.x - leg.from.x, -(leg.to.y - leg.from.y)));

/** Where the walker is `t` seconds into the plan. */
export function walkerAt(plan: WalkPlan, t: number, start: SimPoint): WalkerState {
  let heading = 0;
  const play = (list: Leg[], time: number): WalkerState | number => {
    let left = time;
    for (const leg of list) {
      heading = headingOf(leg, heading);
      if (left < leg.walk) {
        const f = leg.walk > 0 ? left / leg.walk : 1;
        return { x: leg.from.x + (leg.to.x - leg.from.x) * f, y: leg.from.y + (leg.to.y - leg.from.y) * f, heading, moving: true };
      }
      left -= leg.walk;
      if (left < leg.pause) return { x: leg.to.x, y: leg.to.y, heading, moving: false };
      left -= leg.pause;
    }
    return left;
  };
  const intro = play(plan.intro, Math.max(0, t));
  if (typeof intro !== 'number') return intro;
  const end = plan.intro.length ? plan.intro[plan.intro.length - 1].to : start;
  const length = plan.cycle.reduce((sum, leg) => sum + leg.walk + leg.pause, 0);
  if (!plan.cycle.length || length <= 0) return { x: end.x, y: end.y, heading, moving: false };
  const cycled = play(plan.cycle, intro % length);
  return typeof cycled === 'number' ? { x: end.x, y: end.y, heading, moving: false } : cycled;
}
