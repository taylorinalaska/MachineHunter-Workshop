/** Doors, keys and switches: what the editor needs to describe and link them. */
import { KEY_COUNT, KEY_PICKUP_TYPES, type MapProject, SWITCH_CHANNEL_FIRST, SWITCH_CHANNEL_LAST } from '@mh/core';

export interface PlacedSwitch {
  channel: number;
  group: number;
  layer: number;
  x: number;
  y: number;
}

/** Every switch in the map. */
export function mapSwitches(project: MapProject): PlacedSwitch[] {
  const out: PlacedSwitch[] = [];
  project.groups.forEach((g, group) =>
    g.layers.forEach((l, layer) => {
      for (const [index, b] of l.behaviors) if (b.kind === 'switch') out.push({ channel: b.channel, group, layer, x: index % l.width, y: Math.floor(index / l.width) });
    }),
  );
  return out;
}

/** The number a switch goes by: its channel counted from the first switch channel. */
export const switchNumber = (channel: number): number => channel - SWITCH_CHANNEL_FIRST + 1;

/** What a trigger is called: its own name, or its number. */
export function triggerName(project: MapProject, channel: number): string {
  return project.triggers.find((t) => t.channel === channel)?.name || `Trigger ${switchNumber(channel)}`;
}

/** A channel no trigger, pad or door uses yet, or null when all are taken. */
export function freeSwitchChannel(project: MapProject): number | null {
  const used = new Set([...mapSwitches(project).map((s) => s.channel), ...project.triggers.map((t) => t.channel)]);
  for (const g of project.groups) for (const l of g.layers) for (const b of l.behaviors.values()) if (b.kind === 'door') used.add(b.lock);
  for (let c = SWITCH_CHANNEL_FIRST; c <= SWITCH_CHANNEL_LAST; c++) if (!used.has(c)) return c;
  return null;
}

export function lockLabel(lock: number, project?: MapProject): string {
  if (lock === 0) return 'Opens when touched';
  if (lock <= KEY_COUNT) return `Needs key ${lock}`;
  return `Opens with ${project ? triggerName(project, lock) : `trigger ${switchNumber(lock)}`}`;
}

/** Doors in the map with a lock. */
export function doorsWithLock(project: MapProject, lock: number): number {
  let n = 0;
  for (const g of project.groups) for (const l of g.layers) for (const b of l.behaviors.values()) if (b.kind === 'door' && b.lock === lock) n++;
  return n;
}

/** The key a map type is, 1..5, or 0. */
export const keyOfType = (type: number): number => (KEY_PICKUP_TYPES as readonly number[]).indexOf(type) + 1;
