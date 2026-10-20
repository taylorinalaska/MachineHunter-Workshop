/** Shared UI building blocks. */
import { TILE_SIZE } from '@mh/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { GameData, SlotLooks } from '../game/gamedata.ts';
import { Icon } from './icons.tsx';

/** A dialog or the prop editor is open over the page: shortcuts for what is behind it must not fire. */
export const modalOpen = (): boolean => !!document.querySelector('.backdrop');

export function Dialog({ title, width, onClose, children, footer }: { title: string; width?: number; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title} style={width ? ({ '--dialog-width': `${width}px` } as React.CSSProperties) : undefined}>
        <header>
          <h2>{title}</h2>
          <button className="ghost icon right" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="body scroll">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Draws a terrain tile with a level's palette. */
export function TileCanvas({ game, level, tile, masked = false, size }: { game: GameData; level: string; tile: Uint8Array | undefined; masked?: boolean; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    if (!tile) return;
    const rgba = game.level(level).palette.toRgba(tile, masked ? 0 : null);
    g.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, TILE_SIZE, TILE_SIZE), 0, 0);
  }, [game, level, tile, masked]);
  return <canvas ref={ref} className="pixel" width={TILE_SIZE} height={TILE_SIZE} style={size ? { width: size, height: size } : undefined} />;
}

/** Copies a pre-rendered canvas (sprite frame, icon) into the page. */
export function CanvasImage({ source, className, size }: { source: HTMLCanvasElement | null; className?: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const side = source?.width ?? 64;
    canvas.width = canvas.height = side;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, side, side);
    if (source) g.drawImage(source, 0, 0);
  }, [source]);
  return <canvas ref={ref} className={className ?? 'sprite-thumb'} style={size ? { width: size, height: size } : undefined} />;
}

export function EntityThumb({ game, type, level, size, looks }: { game: GameData; type: number; level: string; size?: number; looks?: SlotLooks }) {
  return <CanvasImage source={game.entityImage(type, level, looks)} size={size} />;
}

export function Field({ label, children, stack = false }: { label: string; children: ReactNode; stack?: boolean }) {
  return (
    <label className={stack ? 'field stack' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * A number field. Typed text is only applied on Enter or when the field loses
 * focus, so half-typed values are neither clamped under the cursor nor applied
 * (each application can be an undo step, a resize or a settings write). The
 * spinner and arrow keys apply at once.
 */
export function NumberInput({ value, min, max, step = 1, onChange, width = 70 }: { value: number; min: number; max: number; step?: number; onChange: (value: number) => void; width?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = (text: string) => {
    setDraft(null);
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return;
    const clamped = Math.max(min, Math.min(max, n));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <input
      type="number"
      value={draft ?? value}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      onChange={(e) => {
        // Typing and deleting carry an input type; the spinner and arrow keys do not.
        if ((e.nativeEvent as InputEvent).inputType) setDraft(e.target.value);
        else apply(e.target.value);
      }}
      onBlur={(e) => draft !== null && apply(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') apply(e.currentTarget.value);
        else if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
