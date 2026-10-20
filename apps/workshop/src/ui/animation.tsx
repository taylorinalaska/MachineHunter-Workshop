/** Playing sprite animations the way the game does, for previews. */
import type { AnimationSource } from '@mh/core';
import { useEffect, useRef } from 'react';
import { type GameData, SPRITE_STAGE } from '../game/gamedata.ts';

/** The game logic runs at a fixed rate; previews assume this many updates per second. */
export const UPDATES_PER_SECOND = 30;

export const MODE_NAMES: Record<number, string> = { 1: 'held frame', 2: 'loop', 3: 'ping-pong', 4: 'chained', 5: 'one-shot', 6: 'special' };

export interface Layer {
  label: string;
  container: string;
  source: AnimationSource | null;
  frame: number;
}

/**
 * Frame index a source shows after `tick` game updates. With `cycle`, modes
 * that would stop (held frames, one-shots) run through their frames in a loop
 * so every frame of the record can be seen.
 */
export function frameAt(source: AnimationSource, tick: number, cycle = false): number {
  const span = Math.max(1, source.frameSpan);
  const step = Math.floor(tick / Math.max(1, source.tickReload));
  let offset = Math.max(0, source.startOffset);
  if (source.mode === 2 || (cycle && source.mode !== 3)) offset = (offset + step) % span;
  else if (source.mode === 3 && span > 1) {
    const cycle = (span - 1) * 2;
    const p = (offset + step) % cycle;
    offset = p < span ? p : cycle - p;
  }
  if (source.reversed) offset = span - 1 - offset;
  return source.frameBase + offset;
}

/**
 * Draw a frame at its own pixel size about the center of the stage. Sprite
 * frames come in 64, 32 and 16 pixel sizes, sometimes within one animation;
 * stretching them all to fill the stage makes the small ones balloon.
 */
export function drawFrame(g: CanvasRenderingContext2D, image: HTMLCanvasElement | null): void {
  if (image) g.drawImage(image, Math.floor((SPRITE_STAGE - image.width) / 2), Math.floor((SPRITE_STAGE - image.height) / 2));
}

export function AnimatedSprite({ game, layers, level, playing, cycle = false, size = 256 }: { game: GameData; layers: Layer[]; level: string; playing: boolean; cycle?: boolean; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    let handle = 0;
    const started = performance.now();
    const draw = (now: number) => {
      const tick = playing ? Math.floor(((now - started) / 1000) * UPDATES_PER_SECOND) : 0;
      g.clearRect(0, 0, SPRITE_STAGE, SPRITE_STAGE);
      for (const layer of layers) drawFrame(g, game.frameImage(layer.container, layer.source ? frameAt(layer.source, tick, cycle) : layer.frame, level));
      if (playing) handle = requestAnimationFrame(draw);
    };
    draw(started);
    return () => cancelAnimationFrame(handle);
  }, [game, layers, level, playing, cycle]);
  return <canvas ref={ref} className="pixel" width={SPRITE_STAGE} height={SPRITE_STAGE} style={{ width: size, height: size }} />;
}

