/** Triggers in the editor: which exist, making sure one has a record, and saying what an action does. */
import { KEY_COUNT, type MapProject, type Trigger, type TriggerAction } from '@mh/core';
import type { GameData } from '../game/gamedata.ts';
import { mapSwitches, switchNumber } from './doors.ts';

/** Every trigger channel the map uses: those with a record, those with pads and those doors wait for, in order. */
export function triggerChannels(project: MapProject): number[] {
  const channels = new Set<number>([...project.triggers.map((t) => t.channel), ...mapSwitches(project).map((s) => s.channel)]);
  for (const g of project.groups) for (const l of g.layers) for (const b of l.behaviors.values()) if (b.kind === 'door' && b.lock > KEY_COUNT) channels.add(b.lock);
  return [...channels].sort((a, b) => a - b);
}

/** The record of a trigger, made if the channel has none yet (pads and doors can exist without one). */
export function ensureTrigger(project: MapProject, channel: number): Trigger {
  let t = project.triggers.find((x) => x.channel === channel);
  if (!t) {
    t = { channel, name: `Trigger ${switchNumber(channel)}`, once: false, actions: [] };
    project.triggers.push(t);
    project.triggers.sort((a, b) => a.channel - b.channel);
  }
  return t;
}

/** Remove a trigger: its record, its pads, and the lock of the doors waiting for it (they open on touch again). */
export function removeTrigger(project: MapProject, channel: number): void {
  project.triggers = project.triggers.filter((t) => t.channel !== channel);
  for (const g of project.groups)
    for (const l of g.layers)
      for (const [index, b] of [...l.behaviors]) {
        if (b.kind === 'switch' && b.channel === channel) l.behaviors.delete(index);
        else if (b.kind === 'door' && b.lock === channel) l.behaviors.set(index, { ...b, lock: 0 });
      }
}

/** Pads a trigger has. */
export const padCount = (project: MapProject, channel: number): number => mapSwitches(project).filter((s) => s.channel === channel).length;

/** A short line saying what an action does. */
export function describeAction(project: MapProject, game: GameData, a: TriggerAction): string {
  const where = (x: number, y: number) => `${x}, ${y}`;
  switch (a.kind) {
    case 'break':
      return `Break ${where(a.x, a.y)}`;
    case 'retexture':
      return `Retexture ${where(a.x, a.y)}`;
    case 'effect':
      return `${project.effects.find((f) => f.id === a.effect)?.name ?? 'Effect'} at ${where(a.x >> 8, a.y >> 8)}`;
    case 'reveal': {
      const e = project.groups[a.group]?.layers[a.layer]?.entities.find((x) => x.id === a.entity);
      return `Reveal ${e ? (game.entity(e.type)?.name ?? `type ${e.type}`) : 'a missing entity'}`;
    }
  }
}

/** The cells an action acts on, for showing on the map. */
export function actionCell(a: TriggerAction, project: MapProject): { x: number; y: number } | null {
  if (a.kind === 'effect') return { x: a.x >> 8, y: a.y >> 8 };
  if (a.kind === 'reveal') {
    const e = project.groups[a.group]?.layers[a.layer]?.entities.find((x) => x.id === a.entity);
    return e ? { x: e.x >> 8, y: e.y >> 8 } : null;
  }
  return { x: a.x, y: a.y };
}
