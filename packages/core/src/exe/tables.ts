/**
 * Recovered data tables of the retail executable. Each reader documents the
 * address it trusts; the evidence lives in research/KNOWLEDGE.md.
 */
import type { PeImage } from './pe.ts';

/* ------------------------------------------------------------------ levels */

export const LEVEL_COUNT = 25;
export const SINGLE_PLAYER_LEVEL_COUNT = 17;

/** Internal level-table order. Indices 17..24 are the deathmatch arenas. */
export const LEVEL_IDS = [
  'MARS', 'LABS0', 'DOCK2', 'MINES4', 'CITY1', 'CITY2', 'HOSP0', 'SEWER1', 'JUNK1', 'POWER3',
  'SWAMP', 'MILIT1', 'MILIT3', 'ASTER1', 'ASTER2', 'ALIEN1', 'BOSS3MAP',
  'DMMARS1', 'DMMILIT1', 'DMBARR1', 'DMALIEN1', 'DMLABS1', 'DMSWAMP1', 'DMSEWER1', 'DMASTER1',
] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

const LEVEL_TABLE = 0x0048c920;
const LEVEL_RECORD_SIZE = 0x4c;
const SPRITE_BINDING_TABLE = 0x0048c530;
const SPRITE_BINDING_COUNT = 126;

export interface SpriteBinding {
  /** Index into the executable's global binding table. */
  bindingIndex: number;
  /** DATA.ARC directory index of the .B container. */
  archiveId: number;
  /** Runtime sprite slot the container is loaded into (0..255). */
  slot: number;
}

export interface LevelRecord {
  index: number;
  id: LevelId;
  /** DATA.ARC directory indices of the level's resources. */
  resources: { map: number; terrain: number; pal: number; plt: number; msk: number; rmp: number; brt: number; lmp: number };
  /** Group that is active when the level starts. */
  initialGroup: number;
  sprites: SpriteBinding[];
}

export function readLevelTable(pe: PeImage): LevelRecord[] {
  const levels: LevelRecord[] = [];
  for (let index = 0; index < LEVEL_COUNT; index++) {
    const base = LEVEL_TABLE + index * LEVEL_RECORD_SIZE;
    const id = (i: number) => pe.u32(base + i * 4);
    const sprites: SpriteBinding[] = [];
    // +0x24: up to 39 binding indices, terminated by 0xFF.
    for (let i = 0; i < 40; i++) {
      const bindingIndex = pe.u8(base + 0x24 + i);
      if (bindingIndex === 0xff || bindingIndex >= SPRITE_BINDING_COUNT) break;
      const record = SPRITE_BINDING_TABLE + bindingIndex * 8;
      sprites.push({ bindingIndex, archiveId: pe.u32(record), slot: pe.u32(record + 4) });
    }
    levels.push({
      index,
      id: LEVEL_IDS[index],
      resources: { map: id(0), terrain: id(1), pal: id(2), plt: id(3), msk: id(4), rmp: id(5), brt: id(6), lmp: id(7) },
      initialGroup: pe.u32(base + 0x20),
      sprites,
    });
  }
  return levels;
}

/* --------------------------------------------------------------- briefings */

const BRIEFING_TEXT_TABLE = 0x00489f80;
const BRIEFING_IMAGE_TABLE = 0x00489fe8;

export interface RetailBriefing {
  levelIndex: number;
  /** Body text; lines are separated by explicit '\n' (the game does not wrap). */
  text: string;
  /** DATA.ARC directory index of the 220x160 background bitmap. */
  imageArchiveId: number;
}

/** Per-level mission briefing text and background (single-player levels only). */
export function readBriefings(pe: PeImage): RetailBriefing[] {
  const out: RetailBriefing[] = [];
  for (let levelIndex = 0; levelIndex < SINGLE_PLAYER_LEVEL_COUNT; levelIndex++) {
    out.push({
      levelIndex,
      text: pe.cstring(pe.u32(BRIEFING_TEXT_TABLE + levelIndex * 4), 2048),
      imageArchiveId: pe.u32(BRIEFING_IMAGE_TABLE + levelIndex * 4),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ sounds */

const SOUND_DESCRIPTOR_TABLE = 0x00483f90;
const SOUND_NAME_TABLE = 0x004864e8;
export const SOUND_EFFECT_COUNT = 461;

export interface SoundEffect {
  id: number;
  /** DATA.ARC member name of the 22,050 Hz mono 8-bit sample. */
  sample: string;
}

export function readSoundEffects(pe: PeImage): SoundEffect[] {
  const out: SoundEffect[] = [];
  for (let id = 0; id < SOUND_EFFECT_COUNT; id++) {
    if (pe.u16(SOUND_DESCRIPTOR_TABLE + id * 16) !== id) break;
    out.push({ id, sample: pe.cstring(pe.u32(SOUND_NAME_TABLE + id * 4), 16) });
  }
  return out;
}

/* ---------------------------------------------------------------- entities */

const ENTITY_TYPE_TABLE = 0x00494548;

/**
 * An animation source record.
 *
 * Descriptor records are 0x1C bytes:
 *   +00 u16 sprite slot   +02 u16 mode (low nibble; 0x8000 = reversed)
 *   +04 u32 callback      +08 i16 start offset   +0A u16 frame base
 *   +0C u16 frame span    +0E u16 tick reload    +10 u32 Q14 scale
 * The per-form movement records are a 16-byte variant that starts with the
 * mode word and carries no sprite slot (the actor keeps its descriptor's).
 */
export interface AnimationSource {
  va: number;
  /** Runtime sprite slot the frames come from; -1 for the slot-less form records. */
  slot: number;
  /** 1 hold, 2 loop, 3 ping-pong, 4..6 endpoint/callback variants. */
  mode: number;
  /** Mode word bit 0x8000: play backwards. */
  reversed: boolean;
  /** Frame offset, within the span, that playback starts on. */
  startOffset: number;
  frameBase: number;
  frameSpan: number;
  /** Game updates each frame is held for. */
  tickReload: number;
  /** Q14 draw scale (0x4000 = 1.0). Zero for the form records. */
  scale: number;
  /** Code the engine calls when the animation reaches its end, or 0. */
  callback: number;
}

export function readAnimationSource(pe: PeImage, va: number, formRecord = false): AnimationSource | null {
  if (!va || !pe.isFileBacked(va) || !pe.isFileBacked(va + (formRecord ? 0x0f : 0x1b))) return null;
  const modeWord = pe.u16(va + (formRecord ? 0 : 2));
  return {
    va,
    slot: formRecord ? -1 : pe.u16(va),
    mode: modeWord & 0x0f,
    reversed: (modeWord & 0x8000) !== 0,
    startOffset: pe.i16(va + 8),
    frameBase: pe.u16(va + 10),
    frameSpan: pe.u16(va + 12),
    tickReload: pe.u16(va + 14),
    scale: formRecord ? 0 : pe.u32(va + 16),
    callback: pe.u32(va + 4),
  };
}

export interface ActorDescriptor {
  va: number;
  /** Descriptor class/flags dword; pickups and mission objects are told apart by it. */
  flags: number;
  initFn: number;
  updateFn: number;
  /** Auxiliary behavior block (death handling, effects). */
  auxBlock: number;
  radius: number;
  maxHealth: number;
  primaryAnimation: AnimationSource | null;
  secondaryAnimation: AnimationSource | null;
}

export interface EntityTypeRecord {
  mapType: number;
  /** Network activation selector. */
  networkSelector: number;
  /** Below 0x800: fixed spawn angle. 0x800 / 0x1800: taken from the placement. Otherwise random. */
  facingPolicy: number;
  descriptor: ActorDescriptor | null;
}

/** Descriptor of controllable form 1..10 (form 1 is the human player body). */
export const formDescriptorVa = (form: number): number => 0x0047ce40 + (form - 1) * 0x20;

export function readDescriptor(pe: PeImage, va: number): ActorDescriptor | null {
  if (!va || !pe.isFileBacked(va) || !pe.isFileBacked(va + 0x1f)) return null;
  return {
    va,
    flags: pe.u32(va),
    initFn: pe.u32(va + 4),
    updateFn: pe.u32(va + 8),
    auxBlock: pe.u32(va + 12),
    radius: pe.u16(va + 0x14),
    maxHealth: pe.u16(va + 0x16),
    primaryAnimation: readAnimationSource(pe, pe.u32(va + 0x18)),
    secondaryAnimation: readAnimationSource(pe, pe.u32(va + 0x1c)),
  };
}

/** The map-type table: what a placed object's low type byte selects. */
export function readEntityType(pe: PeImage, mapType: number): EntityTypeRecord {
  const at = ENTITY_TYPE_TABLE + mapType * 16;
  return {
    mapType,
    networkSelector: pe.u32(at),
    facingPolicy: pe.i16(at + 10),
    descriptor: readDescriptor(pe, pe.u32(at + 4)),
  };
}

/* ------------------------------------------------------------- body forms */

const BODY_PROFILE_TABLE = 0x0047cfe0;
const BODY_PROFILE_SIZE = 0x70;
export const BODY_FORM_COUNT = 10;

/** Movement-state animation sources for the ten controllable forms (16-byte records). */
const FORM_IDLE_PRIMARY = 0x0047c710;
const FORM_MOVE_PRIMARY = 0x0047c8b0;
const FORM_MOVE_SECONDARY = 0x0047c7e0;
/** Upper body firing: a short one-shot the fire attempt (0x00413290) starts for forms 2..10. */
const FORM_FIRING = 0x0047c980;
/** Upper body dying: the robot death path (0x004129C0) starts it. */
const FORM_DYING = 0x0047cbb0;
/**
 * Upper body while standing. The controlled-movement code (0x004134A0) picks
 * it with the standing body record when a robot stops; form 1 uses a record of
 * its own at 0x0047C630 instead.
 */
const FORM_IDLE_SECONDARY = 0x0047c640;

export interface BodyFormAnimations {
  form: number;
  idleBody: AnimationSource | null;
  moveBody: AnimationSource | null;
  moveTurret: AnimationSource | null;
  firing: AnimationSource | null;
  dying: AnimationSource | null;
  idleTurret: AnimationSource | null;
}

export function readBodyFormAnimations(pe: PeImage): BodyFormAnimations[] {
  const out: BodyFormAnimations[] = [];
  for (let form = 1; form <= BODY_FORM_COUNT; form++) {
    out.push({
      form,
      idleBody: readAnimationSource(pe, FORM_IDLE_PRIMARY + form * 0x10, true),
      moveBody: readAnimationSource(pe, FORM_MOVE_PRIMARY + form * 0x10, true),
      moveTurret: readAnimationSource(pe, FORM_MOVE_SECONDARY + form * 0x10, true),
      firing: readAnimationSource(pe, FORM_FIRING + form * 0x10, true),
      dying: readAnimationSource(pe, FORM_DYING + form * 0x10, true),
      idleTurret: readAnimationSource(pe, (form === 1 ? 0x0047c630 - 0x10 : FORM_IDLE_SECONDARY) + form * 0x10, true),
    });
  }
  return out;
}

/**
 * Raw 0x70-byte body/control profile for a form (1..10). Field semantics: research/data/body_forms.json.
 * Form f's profile is at BODY_PROFILE_TABLE + f * 0x70; its first dword points back at the form's descriptor.
 */
export function readBodyProfileBytes(pe: PeImage, form: number): Uint8Array {
  return pe.slice(BODY_PROFILE_TABLE + form * BODY_PROFILE_SIZE, BODY_PROFILE_SIZE);
}
