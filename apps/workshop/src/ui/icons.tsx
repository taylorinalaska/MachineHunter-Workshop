/** Small stroke-icon set. Paths are drawn on a 24x24 grid. */
const PATHS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  build: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  entities: 'M12 3a4 4 0 100 8 4 4 0 000-8zM4 21c0-4 3.5-7 8-7s8 3 8 7',
  assets: 'M4 5h16v14H4zM4 15l4.5-4.5L13 15l3-3 4 4M15.5 9.5h.01',
  mission: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  mods: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  select: 'M5 3l14 8-6 2-2 6z',
  room: 'M4 4h16v16H4zM4 4l4 4M20 4l-4 4M8 8h8v8H8z',
  floor: 'M3 15l9-5 9 5-9 5zM3 15V9l9-5 9 5v6',
  wall: 'M3 6h18v12H3zM3 12h18M9 6v6M15 12v6',
  ramp: 'M3 19h18L21 7zM9 19v-3.6M15 19v-7.4',
  block: 'M4 9h12v11H4zM4 9l4-5h12l-4 5M16 20l4-5V4',
  path: 'M5 19a2 2 0 100-4 2 2 0 000 4zM19 9a2 2 0 100-4 2 2 0 000 4zM7 17c4 0 2-8 6-8h4M12 12.500a2 2 0 100 .01',
  tag: 'M3 12V4h8l10 10-8 8zM7.500 8.500h.01',
  spark: 'M12 2l2.200 6.800L21 11l-6.800 2.200L12 20l-2.200-6.800L3 11l6.800-2.200z',
  cube: 'M12 3l8 4.500v9L12 21l-8-4.500v-9zM4 7.500l8 4.500 8-4.500M12 12v9',
  import: 'M12 3v12M7 10l5 5 5-5M5 15v5h14v-5',
  target: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 1v4M12 19v4M1 12h4M19 12h4',
  paint: 'M19 3l2 2-9 9-3 1 1-3zM9 15c-3 0-4 2-4 4 2 0 5 0 5-3',
  erase: 'M7 20h13M5 15l9-9 5 5-9 9H7z',
  entity: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 100 8 4 4 0 000-8z',
  prop: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  teleporter: 'M12 3a9 9 0 019 9M12 21a9 9 0 01-9-9M12 7a5 5 0 015 5M12 17a5 5 0 01-5-5M12 11.5v1',
  door: 'M6 21V4h12v17M3 21h18M14.5 12.5h.01',
  exit: 'M10 4H5v16h5M14 8l4 4-4 4M9 12h9',
  light: 'M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2',
  play: 'M7 4l13 8-13 8z',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 21v-7h8v7',
  check: 'M4 12l5 5L20 6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  grid: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  rotate: 'M20 11a8 8 0 10-2.3 6M20 4v7h-7',
  frame: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  folder: 'M3 6h6l2 2h10v11H3z',
  close: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  sound: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  export: 'M12 3v12M7 8l5-5 5 5M5 15v5h14v-5',
  marker: 'M12 21s7-6.5 7-12a7 7 0 10-14 0c0 5.500 7 12 7 12zM12 6.500a2.500 2.500 0 100 5 2.500 2.500 0 000-5z',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
