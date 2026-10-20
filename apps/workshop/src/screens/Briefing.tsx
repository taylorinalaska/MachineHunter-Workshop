/** The typewriter briefing shown before a level starts: a dialog of the builder. */
import { BRIEFING_IMAGE_HEIGHT, BRIEFING_IMAGE_WIDTH, type IndexedBitmap, LEVEL_IDS, type LevelId, bitmapToRgba, decodeBmp, encodeBmp, nearestIndex } from '@mh/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gameFont } from '../game/font.ts';
import { type GameData, LEVEL_TITLES, bestiary } from '../game/gamedata.ts';
import { useApp, useGame } from '../state/app.ts';
import { useEditor } from '../state/editor.ts';
import { Dialog, Field } from '../ui/common.tsx';

/** Recovered layout of the briefing screen (320x240). */
const IMAGE_X = 50;
const IMAGE_Y = 40;
const TITLE_X = 66;
const TITLE_Y = 48;
const BODY_X = 66;
const BODY_Y = 62;
const TEXT_STYLE = 1;

function retailBriefing(game: GameData, level: string) {
  const index = LEVEL_IDS.indexOf(level as LevelId);
  const briefing = game.briefings[index];
  if (!briefing) return null;
  return { text: briefing.text, title: (LEVEL_TITLES[level] ?? level).toUpperCase(), image: decodeBmp(game.archive.read(briefing.imageArchiveId)) };
}

function Preview({ image, title, text }: { image: IndexedBitmap | null; title: string; text: string }) {
  const game = useGame();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext('2d')!;
    const frame = g.createImageData(320, 240);
    for (let i = 3; i < frame.data.length; i += 4) frame.data[i] = 255;
    if (image) {
      const rgba = bitmapToRgba(image);
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const from = (y * image.width + x) * 4;
          const to = ((y + IMAGE_Y) * 320 + x + IMAGE_X) * 4;
          frame.data[to] = rgba[from];
          frame.data[to + 1] = rgba[from + 1];
          frame.data[to + 2] = rgba[from + 2];
        }
      }
    }
    const font = gameFont(game);
    font.draw(frame, TEXT_STYLE, title.toUpperCase(), TITLE_X, TITLE_Y);
    font.draw(frame, TEXT_STYLE, text.toUpperCase(), BODY_X, BODY_Y);
    g.putImageData(frame, 0, 0);
  }, [game, image, title, text]);
  return <canvas ref={ref} className="briefing-preview pixel" width={320} height={240} />;
}

/** Fit any picture to 220x160 and map it onto a palette with error-diffusion dithering. */
async function importBriefingImage(file: File, palette: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = BRIEFING_IMAGE_WIDTH;
  canvas.height = BRIEFING_IMAGE_HEIGHT;
  const g = canvas.getContext('2d')!;
  // Cover the frame, cropping whatever does not fit.
  const scale = Math.max(BRIEFING_IMAGE_WIDTH / bitmap.width, BRIEFING_IMAGE_HEIGHT / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  g.drawImage(bitmap, (BRIEFING_IMAGE_WIDTH - w) / 2, (BRIEFING_IMAGE_HEIGHT - h) / 2, w, h);
  const source = g.getImageData(0, 0, BRIEFING_IMAGE_WIDTH, BRIEFING_IMAGE_HEIGHT).data;
  const work = new Float32Array(BRIEFING_IMAGE_WIDTH * BRIEFING_IMAGE_HEIGHT * 3);
  for (let i = 0; i < work.length / 3; i++) for (let c = 0; c < 3; c++) work[i * 3 + c] = source[i * 4 + c];
  const pixels = new Uint8Array(BRIEFING_IMAGE_WIDTH * BRIEFING_IMAGE_HEIGHT);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < BRIEFING_IMAGE_HEIGHT; y++) {
    for (let x = 0; x < BRIEFING_IMAGE_WIDTH; x++) {
      const i = y * BRIEFING_IMAGE_WIDTH + x;
      const r = clamp(work[i * 3]);
      const gr = clamp(work[i * 3 + 1]);
      const b = clamp(work[i * 3 + 2]);
      const index = nearestIndex(palette, r, gr, b);
      pixels[i] = index;
      const errors = [r - palette[index * 3], gr - palette[index * 3 + 1], b - palette[index * 3 + 2]];
      const spread = (dx: number, dy: number, weight: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= BRIEFING_IMAGE_WIDTH || ny >= BRIEFING_IMAGE_HEIGHT) return;
        for (let c = 0; c < 3; c++) work[(ny * BRIEFING_IMAGE_WIDTH + nx) * 3 + c] += errors[c] * weight;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return encodeBmp({ width: BRIEFING_IMAGE_WIDTH, height: BRIEFING_IMAGE_HEIGHT, palette, pixels });
}

function ProjectBriefing() {
  const game = useGame();
  const toast = useApp((s) => s.toast);
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  useEditor((s) => s.revision);
  const retail = useMemo(() => retailBriefing(game, project.baseLevel), [game, project.baseLevel]);
  const b = project.briefing;
  const custom = b.mode === 'custom';
  const image = useMemo(() => (custom && b.image ? decodeBmp(b.image) : (retail?.image ?? null)), [custom, b.image, retail]);
  const lines = b.text.split('\n');
  const longest = Math.max(0, ...lines.map((l) => l.length));

  const pickImage = async (file: File | undefined) => {
    if (!file || !retail) return;
    try {
      // The retail picture's palette also carries the colors the briefing text is drawn in, so keep it.
      const bmp = await importBriefingImage(file, retail.image.palette);
      edit((p) => void (p.briefing.image = bmp));
    } catch (error) {
      toast(`Could not use that picture: ${(error as Error).message}`, 'error');
    }
  };

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 28, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 360px', maxWidth: 520 }}>
        <div className="segmented" style={{ marginBottom: 14 }}>
          <button className={!custom ? 'active' : ''} onClick={() => edit((p) => void (p.briefing.mode = 'inherit'))}>
            Use the {project.baseLevel} briefing
          </button>
          <button
            className={custom ? 'active' : ''}
            onClick={() =>
              edit((p) => {
                p.briefing.mode = 'custom';
                if (!p.briefing.text && retail) p.briefing.text = retail.text;
                if (!p.briefing.title) p.briefing.title = p.name;
              })
            }
          >
            Write my own
          </button>
        </div>
        {custom ? (
          <>
            <Field label="Title" stack>
              <input value={b.title} maxLength={40} onChange={(e) => edit((p) => void (p.briefing.title = e.target.value))} />
            </Field>
            <Field label="Briefing text" stack>
              <textarea rows={9} value={b.text} maxLength={2000} spellCheck={false} onChange={(e) => edit((p) => void (p.briefing.text = e.target.value))} />
            </Field>
            <p className="hint">
              {lines.length} lines, longest {longest} characters (about 26 fit). No automatic line breaks.
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <label className="check">
                <button
                  onClick={(e) => {
                    (e.currentTarget.nextElementSibling as HTMLInputElement).click();
                  }}
                >
                  Choose a picture…
                </button>
                <input type="file" accept="image/*" hidden onChange={(e) => void pickImage(e.target.files?.[0])} />
              </label>
              {b.image && (
                <button className="ghost" onClick={() => edit((p) => void (p.briefing.image = null))}>
                  Use the {project.baseLevel} picture
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="hint">Uses the {project.baseLevel} briefing.</p>
        )}
      </div>
      <div>
        <Preview image={image} title={custom ? b.title : (retail?.title ?? '')} text={custom ? b.text : (retail?.text ?? '')} />
      </div>
    </div>
  );
}

function RetailBriefings() {
  const game = useGame();
  const [level, setLevel] = useState<string>('MARS');
  const retail = useMemo(() => retailBriefing(game, level), [game, level]);
  const levels = [...bestiary.campaign.map((c) => c.level), 'BOSS3MAP'];
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 28, flexWrap: 'wrap' }}>
      <div className="list" style={{ width: 260 }}>
        {levels.map((id, i) => (
          <div key={id} className={`item ${level === id ? 'selected' : ''}`} onClick={() => setLevel(id)}>
            <span className="faint" style={{ width: 18 }}>
              {i + 1}
            </span>
            {LEVEL_TITLES[id] ?? id}
          </div>
        ))}
      </div>
      {retail && <Preview image={retail.image} title={retail.title} text={retail.text} />}
    </div>
  );
}

/** The briefing editor, opened from the builder's tool rail. */
export function Briefing() {
  const project = useEditor((s) => s.project);
  const close = () => useEditor.getState().setBriefingOpen(false);
  const [tab, setTab] = useState<'mine' | 'retail'>(project ? 'mine' : 'retail');
  return (
    <Dialog
      title="Mission briefing"
      width={1080}
      onClose={close}
      footer={
        <button className="primary" onClick={close}>
          Done
        </button>
      }
    >
      <div className="tabs">
        <button className={tab === 'mine' ? 'active' : ''} disabled={!project} onClick={() => setTab('mine')}>
          {project ? `"${project.name}"` : 'No map open'}
        </button>
        <button className={tab === 'retail' ? 'active' : ''} onClick={() => setTab('retail')}>
          The game's briefings
        </button>
      </div>
      {tab === 'mine' && project ? <ProjectBriefing /> : <RetailBriefings />}
    </Dialog>
  );
}
