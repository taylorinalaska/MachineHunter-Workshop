/**
 * Finds every animation record in the executable.
 *
 * Actor descriptors name only the one or two animations an actor starts with;
 * the rest (walk cycles, attacks, deaths, effects) are records the game code
 * switches to by address. They all share the 0x1C-byte layout described in
 * `tables.ts`, so they can be found by scanning the initialized data for
 * records that are well formed in every field.
 *
 * The scan cannot tell which actor uses a record, only which sprite slot it
 * draws from; callers match slots to sprite containers.
 */
import type { PeImage } from './pe.ts';
import { type AnimationSource, readAnimationSource } from './tables.ts';

const RECORD_SIZE = 0x1c;
const MAX_TICK = 240;
const MAX_SPAN = 512;
const MIN_SCALE = 0x0800;
const MAX_SCALE = 0x40000;

/**
 * All well-formed animation records whose sprite slot is one of `slots`.
 * Records are returned in address order, without duplicates.
 */
export function scanAnimationSources(pe: PeImage, slots: ReadonlySet<number>): AnimationSource[] {
  const text = pe.sections.find((s) => s.name === '.text');
  const codeStart = text ? pe.imageBase + text.virtualAddress : 0;
  const codeEnd = text ? codeStart + text.virtualSize : 0;
  const out: AnimationSource[] = [];
  const seen = new Set<string>();
  for (const section of pe.sections) {
    if (section.name !== '.data') continue;
    const start = pe.imageBase + section.virtualAddress;
    const end = start + Math.min(section.virtualSize, section.rawSize) - RECORD_SIZE;
    for (let va = start; va <= end; va += 4) {
      const slot = pe.u16(va);
      if (!slots.has(slot)) continue;
      const modeWord = pe.u16(va + 2);
      const mode = modeWord & 0x0f;
      if (mode < 1 || mode > 6 || (modeWord & 0x7ff0) !== 0) continue;
      const callback = pe.u32(va + 4);
      if (callback !== 0 && (callback < codeStart || callback >= codeEnd)) continue;
      const span = pe.u16(va + 12);
      const tick = pe.u16(va + 14);
      const scale = pe.u32(va + 16);
      const startOffset = pe.i16(va + 8);
      if (span < 1 || span > MAX_SPAN || tick > MAX_TICK) continue;
      if (scale < MIN_SCALE || scale > MAX_SCALE) continue;
      // Held frames use the start offset to pick a frame beyond the span (the pickups do).
      if (startOffset < -1 || startOffset > MAX_SPAN) continue;
      const source = readAnimationSource(pe, va);
      if (!source) continue;
      const key = `${slot}:${source.frameBase}:${span}:${startOffset}:${modeWord}:${tick}:${scale}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out;
}
