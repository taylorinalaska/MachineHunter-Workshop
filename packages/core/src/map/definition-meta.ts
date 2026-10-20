/**
 * The 8 metadata bytes of a cell definition: collision profile + behavior.
 *
 *   word 0  flags
 *     0x0001  ground: actors can stand here
 *     0x0006  collision mode: 0 open, 2 diagonal half, 4 4x4 mask (word 1)
 *     0x0018  ramp height band: 0x08 lower half, 0x10 upper half, 0x18 below floor
 *     0x0060  ramp direction (which way is uphill)
 *     0x0180  orientation selector (diagonal side, trigger direction, conveyor axis)
 *     0x1E00  behavior class
 *     0x2000  skip ordinary collision
 *     0x4000  destructible by weapon impacts
 *     0x8000  solid
 *   word 1  4x4 collision mask (bit 0x8000 >> (x + y*4)), or an object index for actions 4/5
 *   bytes 4..7  behavior parameters, layout depends on class
 *
 * Evidence: research/notes/native_collision_height.md and the cell-class
 * sections of research/KNOWLEDGE.md.
 */

export const FLAG_GROUND = 0x0001;
export const COLLISION_MODE_MASK = 0x0006;
export const COLLISION_OPEN = 0x0000;
export const COLLISION_DIAGONAL = 0x0002;
export const COLLISION_MASK = 0x0004;
export const RAMP_BAND_MASK = 0x0018;
export const RAMP_DIRECTION_MASK = 0x0060;
export const ORIENTATION_MASK = 0x0180;
export const CLASS_MASK = 0x1e00;
export const FLAG_NO_COLLISION = 0x2000;
export const FLAG_DESTRUCTIBLE = 0x4000;
export const FLAG_SOLID = 0x8000;

export const CLASS_NONE = 0x0000;
export const CLASS_HAZARD = 0x0200;
export const CLASS_EXIT = 0x0400;
export const CLASS_TELEPORTER = 0x0800;
export const CLASS_HAZARD_SWITCHABLE = 0x0a00;
export const CLASS_REPLACE = 0x0c00;
export const CLASS_ACTION = 0x0e00;
export const CLASS_SEQUENCE = 0x1000;
export const CLASS_CONVEYOR = 0x1200;

export const ACTION_ACTIVATE = 1;
export const ACTION_ADJACENT_PAIR = 2;
export const ACTION_GRANT_ACCESS = 3;
export const ACTION_ENABLE_OBJECT = 4;
export const ACTION_ENABLE_TYPE = 5;
export const ACTION_SWAP = 6;
export const ACTION_MINES_GATE = 7;
export const ACTION_SECRET = 8;

/** 4x4 collision-mask strips for walls along each cell edge (a quarter cell thick). */
export const EDGE_MASK = { west: 0x8888, east: 0x1111, north: 0xf000, south: 0x000f } as const;
export type Edge = keyof typeof EDGE_MASK;
export const EDGES: readonly Edge[] = ['north', 'east', 'south', 'west'];

/**
 * Ramp flag sets. A full layer takes two cells: a "lower" cell rising from
 * 0 to half height and an "upper" cell from half to full height.
 * `direction` is the way you walk to go up.
 */
export const RAMP_FLAGS = {
  east: { lower: 0x0009, upper: 0x0011 },
  west: { lower: 0x0029, upper: 0x0031 },
  north: { lower: 0x0049, upper: 0x0051 },
  south: { lower: 0x0069, upper: 0x0071 },
} as const;
export type RampDirection = keyof typeof RAMP_FLAGS;
export type RampHalf = 'lower' | 'upper';

/**
 * Diagonal-wall collision flags, indexed by [family][side].
 * Family 0 is the "\" diagonal (x = y), family 1 the "/" diagonal (x + y = 1);
 * `side` picks which half of the cell is solid.
 */
export const DIAGONAL_FLAGS = [
  [0x0103, 0x0183],
  [0x0003, 0x0083],
] as const;

export const flagsOf = (meta: Uint8Array): number => meta[0] | (meta[1] << 8);
export const maskOf = (meta: Uint8Array): number => meta[2] | (meta[3] << 8);
export const definitionClass = (meta: Uint8Array): number => flagsOf(meta) & CLASS_MASK;
export const isDestructible = (meta: Uint8Array): boolean => (flagsOf(meta) & FLAG_DESTRUCTIBLE) !== 0;
export const hasBehavior = (meta: Uint8Array): boolean => (flagsOf(meta) & (CLASS_MASK | FLAG_DESTRUCTIBLE)) !== 0;

export function makeMeta(flags: number, mask = 0, bytes4to7: readonly number[] = [0, 0, 0, 0]): Uint8Array {
  return Uint8Array.of(flags & 0xff, (flags >> 8) & 0xff, mask & 0xff, (mask >> 8) & 0xff, bytes4to7[0] & 0xff, bytes4to7[1] & 0xff, bytes4to7[2] & 0xff, bytes4to7[3] & 0xff);
}

/* ------------------------------------------------------------- behavior */

export interface TeleporterTarget {
  group: number;
  layer: number;
  /** Destination cell inside the destination layer. */
  x: number;
  y: number;
  /** New facing in sixteenths of a turn (0..15), or null to keep the player's facing. */
  facing: number | null;
}

export type CellBehavior =
  | { kind: 'none' }
  | { kind: 'exit' }
  | ({ kind: 'teleporter' } & TeleporterTarget)
  | { kind: 'hazard'; damage: number; switchable: boolean; replaceWith: number }
  | { kind: 'replace'; target: number }
  | { kind: 'action'; action: number; target: number; param: number; objectIndex: number; direction: number }
  | { kind: 'sequence'; next: number; gate: number; pair: number }
  | { kind: 'conveyor'; strength: number; axis: number }
  | { kind: 'unknown'; cls: number };

export interface Destructible {
  /** Definition the cell becomes once destroyed. */
  replaceWith: number;
  /** Higher is tougher: each hit adds max(1, strength * 32 / toughness) to a 0..31 damage counter. */
  toughness: number;
  /** Destruction effect selector (0..31). */
  effect: number;
  playerOnly: boolean;
  centerEffect: boolean;
  /** On destruction, enable the disabled object standing on this cell. */
  enablesObject: boolean;
}

export function decodeBehavior(meta: Uint8Array): CellBehavior {
  const flags = flagsOf(meta);
  const target = (meta[4] | (meta[5] << 8)) & 0x07ff;
  switch (flags & CLASS_MASK) {
    case CLASS_NONE:
      return { kind: 'none' };
    case CLASS_EXIT:
      return { kind: 'exit' };
    case CLASS_TELEPORTER:
      return { kind: 'teleporter', group: meta[6] & 7, layer: meta[7], x: meta[5], y: meta[4], facing: meta[6] & 8 ? meta[6] >> 4 : null };
    case CLASS_HAZARD:
      return { kind: 'hazard', damage: meta[7], switchable: false, replaceWith: 0 };
    case CLASS_HAZARD_SWITCHABLE:
      return { kind: 'hazard', damage: meta[7], switchable: true, replaceWith: target };
    case CLASS_REPLACE:
      return { kind: 'replace', target };
    case CLASS_ACTION:
      return { kind: 'action', action: meta[7], target, param: meta[6], objectIndex: maskOf(meta), direction: (flags & ORIENTATION_MASK) >> 7 };
    case CLASS_SEQUENCE:
      return { kind: 'sequence', next: target, gate: meta[6], pair: meta[7] };
    case CLASS_CONVEYOR:
      return { kind: 'conveyor', strength: meta[7], axis: (flags & ORIENTATION_MASK) >> 7 };
    default:
      return { kind: 'unknown', cls: flags & CLASS_MASK };
  }
}

export function decodeDestructible(meta: Uint8Array): Destructible | null {
  if (!isDestructible(meta)) return null;
  return {
    replaceWith: (meta[4] | (meta[5] << 8)) & 0x07ff,
    toughness: meta[6],
    effect: meta[7] & 0x1f,
    playerOnly: (meta[7] & 0x20) !== 0,
    centerEffect: (meta[7] & 0x40) !== 0,
    enablesObject: (meta[7] & 0x80) !== 0,
  };
}

/** Definition IDs this definition can turn into or trigger. */
export function definitionLinks(meta: Uint8Array): number[] {
  const out: number[] = [];
  const d = decodeDestructible(meta);
  if (d) out.push(d.replaceWith);
  const b = decodeBehavior(meta);
  if (b.kind === 'replace') out.push(b.target);
  else if (b.kind === 'sequence') out.push(b.next);
  else if (b.kind === 'hazard' && b.switchable && b.replaceWith) out.push(b.replaceWith);
  else if (b.kind === 'action' && (b.action === ACTION_ACTIVATE || b.action === ACTION_SWAP || (b.action === ACTION_SECRET && b.target))) out.push(b.target);
  return out;
}

/** Metadata with every behavior removed, keeping only the collision profile. */
export function stripBehavior(meta: Uint8Array): Uint8Array {
  const out = meta.slice();
  const flags = flagsOf(meta);
  const cls = flags & CLASS_MASK;
  let plain = flags & ~(CLASS_MASK | FLAG_DESTRUCTIBLE);
  // Orientation bits belong to the behavior for triggers and conveyors.
  if ((cls === CLASS_ACTION && meta[7] === ACTION_ADJACENT_PAIR) || cls === CLASS_CONVEYOR) plain &= ~ORIENTATION_MASK;
  if (cls === CLASS_ACTION) out[2] = out[3] = 0;
  if (cls !== CLASS_NONE || flags & FLAG_DESTRUCTIBLE) out[4] = out[5] = out[6] = out[7] = 0;
  out[0] = plain & 0xff;
  out[1] = plain >> 8;
  return out;
}

/** Apply a teleporter behavior on top of a collision profile. */
export function withTeleporter(meta: Uint8Array, t: TeleporterTarget): Uint8Array {
  const out = stripBehavior(meta);
  const flags = flagsOf(out) | CLASS_TELEPORTER;
  out[0] = flags & 0xff;
  out[1] = flags >> 8;
  out[4] = t.y & 0xff;
  out[5] = t.x & 0xff;
  out[6] = (t.group & 7) | (t.facing === null ? 0 : 8 | ((t.facing & 15) << 4));
  out[7] = t.layer & 0xff;
  return out;
}

/**
 * One step of a reversible cell sequence (class 0x1000, a door): when the
 * first cell of a chain is touched or activated, the engine applies each
 * `next` definition in turn, holds the last for 60 updates and walks back.
 * `gate` 0 opens at once, 1..31 needs that access channel (keys grant 1..5),
 * 0xFF the rescue quota. `pair` names the partner cell that opens with it:
 * 1 x+1, 2 x-1, 4 y-1, 8 y+1, 0 none.
 */
export function withSequence(meta: Uint8Array, next: number, gate: number, pair: number): Uint8Array {
  const out = stripBehavior(meta);
  const flags = flagsOf(out) | CLASS_SEQUENCE;
  out[0] = flags & 0xff;
  out[1] = flags >> 8;
  out[4] = next & 0xff;
  out[5] = (next >> 8) & 0x07;
  out[6] = gate & 0xff;
  out[7] = pair & 0xff;
  return out;
}

export function withExit(meta: Uint8Array): Uint8Array {
  const out = stripBehavior(meta);
  const flags = flagsOf(out) | CLASS_EXIT;
  out[0] = flags & 0xff;
  out[1] = flags >> 8;
  return out;
}

export function withHazard(meta: Uint8Array, damage: number): Uint8Array {
  const out = stripBehavior(meta);
  const flags = flagsOf(out) | CLASS_HAZARD;
  out[0] = flags & 0xff;
  out[1] = flags >> 8;
  out[7] = damage & 0xff;
  return out;
}

/**
 * Make a cell destructible on top of its collision profile: weapon impacts
 * wear it down and it then turns into `replaceWith`. The parameter bytes are
 * shared with the behavior classes, so a destructible cell has no other
 * behavior.
 */
export function withDestructible(meta: Uint8Array, d: Pick<Destructible, 'replaceWith' | 'toughness' | 'effect'> & Partial<Destructible>): Uint8Array {
  const out = stripBehavior(meta);
  const flags = flagsOf(out) | FLAG_DESTRUCTIBLE;
  out[0] = flags & 0xff;
  out[1] = flags >> 8;
  out[4] = d.replaceWith & 0xff;
  out[5] = (d.replaceWith >> 8) & 0x07;
  out[6] = Math.max(1, Math.min(255, d.toughness));
  out[7] = (d.effect & 0x1f) | (d.playerOnly ? 0x20 : 0) | (d.centerEffect ? 0x40 : 0) | (d.enablesObject ? 0x80 : 0);
  return out;
}

/** Height of the walkable surface at a point of the cell, in 1/256 cell (0..255 local coordinates). */
export function floorHeightAt(flags: number, localX: number, localY: number): number {
  const band = flags & RAMP_BAND_MASK;
  if (!band) return 0;
  const base = band === 0x10 ? 128 : band === 0x18 ? -128 : 0;
  switch (flags & RAMP_DIRECTION_MASK) {
    case 0x00:
      return base + (localX >> 1);
    case 0x20:
      return base + ((255 - localX) >> 1);
    case 0x40:
      return base + ((255 - localY) >> 1);
    default:
      return base + (localY >> 1);
  }
}
