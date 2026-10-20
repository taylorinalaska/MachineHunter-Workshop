/** Picks how a door opens: on touch, with a key, or with a trigger (an existing one or a new one). */
import { KEY_COUNT, type MapProject } from '@mh/core';
import { freeSwitchChannel, mapSwitches, triggerName } from '../editor/doors.ts';

export function LockSelect({ project, value, onChange, allowTouch = true, allowKeys = true }: { project: MapProject; value: number; onChange: (lock: number) => void; allowTouch?: boolean; allowKeys?: boolean }) {
  const channels = [...new Set([...mapSwitches(project).map((s) => s.channel), ...project.triggers.map((t) => t.channel)])].sort((a, b) => a - b);
  // A channel chosen for a switch that is not placed yet still needs an entry.
  if (value > KEY_COUNT && !channels.includes(value)) channels.push(value);
  const fresh = freeSwitchChannel(project);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {allowTouch && <option value={0}>When touched</option>}
      {allowKeys && Array.from({ length: KEY_COUNT }, (_, i) => (
        <option key={i + 1} value={i + 1}>
          With key {i + 1}
        </option>
      ))}
      {channels.map((c) => (
        <option key={c} value={c}>
          With {triggerName(project, c)}
        </option>
      ))}
      {fresh !== null && !channels.includes(fresh) && <option value={fresh}>With a new trigger</option>}
    </select>
  );
}
