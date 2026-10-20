import { MAX_DEFINITIONS, MAX_MAP_BYTES, MAX_TILES } from '@mh/core';
import { useEditor } from '../state/editor.ts';
import { useChecks } from './Inspector.tsx';

function Meter({ label, value, max, format }: { label: string; value: number; max: number; format?: (n: number) => string }) {
  const ratio = Math.min(1, value / max);
  const show = format ?? String;
  return (
    <span className="meter" title={`${show(value)} of ${show(max)}`}>
      {label}
      <span className="bar">
        <i className={ratio > 0.92 ? 'bad' : ratio > 0.75 ? 'warn' : ''} style={{ width: `${ratio * 100}%` }} />
      </span>
      {show(value)}
    </span>
  );
}

export function StatusBar() {
  const hover = useEditor((s) => s.hover);
  const project = useEditor((s) => s.project)!;
  const group = useEditor((s) => s.group);
  const layer = useEditor((s) => s.layer);
  const { stats } = useChecks();
  const active = project.groups[group].layers[layer];
  return (
    <div className="statusbar">
      <span style={{ minWidth: 88 }}>{hover ? `Cell ${hover.x}, ${hover.y}` : '—'}</span>
      <span>
        {project.groups[group].name} · {active.name} ({active.width}×{active.height})
      </span>
      <span className="grow" />
      {stats && (
        <>
          <Meter label="Shapes" value={stats.definitions} max={MAX_DEFINITIONS} />
          <Meter label="Tiles" value={stats.tiles} max={MAX_TILES} />
          <Meter label="Size" value={stats.mapBytes} max={MAX_MAP_BYTES} format={(n) => `${Math.round(n / 1024)} KB`} />
        </>
      )}
    </div>
  );
}
