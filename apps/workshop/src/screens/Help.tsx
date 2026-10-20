/** The builder's help window: every tool, the controls, and a few words on each feature. */
import { useEditor } from '../state/editor.ts';
import { Dialog } from '../ui/common.tsx';
import { Icon } from '../ui/icons.tsx';
import { TOOLS } from './Build.tsx';

const CONTROLS: [string, string][] = [
  ['Right-drag', 'Orbit'],
  ['Middle-drag or Space+drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['W A S D', 'Move'],
  ['Q', 'Rotate the view'],
  ['Home', 'Show the whole layer'],
  ['Page Up / Page Down', 'Layer up / down'],
  ['R', 'Turn the brush'],
  ['Esc', 'Cancel, back to Select'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save / Save as'],
  ['Ctrl+O', 'Open'],
  ['F5', 'Play in the game'],
  ['M', 'Mission briefing'],
  ['F1', 'Help'],
];

const TOPICS: [string, string][] = [
  ['Layers', 'Stacked floors of the same area. Add one on the right, switch with Page Up / Page Down. Ramps lead up to the next one.'],
  ['Areas', 'Separate places in one map, up to three, joined by teleporters. The ★ area is where the player starts.'],
  ['Custom enemies', 'Entities tool → Custom tab. Start from any enemy, then change its name, health, speed, colors or sprites.'],
  ['Custom effects', 'Entities tool → Custom tab. Mix the game’s particles into smoke, fire or sparks of your own.'],
  ['Custom props', 'Props tool → New prop. Put boxes, wedges, roofs, cylinders and more together, or start from a preset. Drag a part to move it, drag its dots to resize.'],
  ['Paths', 'Robots patrol a path until they see the player. Back and forth, loop, or wander inside a zone. Preview shows how they walk it.'],
  ['Interactive', 'One tool (I) for everything that reacts to the player: Doors (J), Breakables, Triggers, Teleporter (T), Exit (K) and Hazard.'],
  ['Doors', 'Open when the player walks up to them, with a key, or with a trigger. They rise, slide or sink, with the game’s door sound.'],
  ['Breakables', 'Shot enough, a cell or wall turns to rubble, or into a broken version of itself (a cracked wall, a broken window) and stays solid.'],
  ['Glass and grates', 'Floor or Wall tool → See-through: color 0 of the tile becomes transparent. Make it breakable with a broken-glass tile for a window that shatters.'],
  ['Triggers', 'Pads the player steps on. A trigger opens its doors and runs its actions: break cells, retexture cells, play an effect, reveal entities that start hidden. Far-off entities appear as the player comes near.'],
  ['Light', '0 is black, about 22 is true color, 31 is overlit. Turn on the sun button to preview it.'],
  ['Exit', 'Under Map on the right: always open, or only after the mission goals.'],
  ['Checks', 'The right panel lists anything that stops the map from playing. Click one to jump to it.'],
];

export function Help() {
  const close = () => useEditor.getState().setHelpOpen(false);
  return (
    <Dialog
      title="Help"
      width={860}
      onClose={close}
      footer={
        <button className="primary" onClick={close}>
          Done
        </button>
      }
    >
      <div className="help">
        <section>
          <h3>Tools</h3>
          {TOOLS.map((t) => (
            <div key={t.id} className="help-row">
              <Icon name={t.icon} size={16} />
              <b>{t.label}</b>
              <span className="kbd">{t.key}</span>
              <span className="grow">
                {t.help}
                {t.mods && (
                  <span className="mods">
                    {t.mods.map(([key, what]) => (
                      <span key={key}>
                        <span className="kbd">{key}</span> {what}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </div>
          ))}
        </section>
        <section>
          <h3>Controls</h3>
          {CONTROLS.map(([key, what]) => (
            <div key={key} className="help-key">
              <span className="kbd">{key}</span>
              <span>{what}</span>
            </div>
          ))}
          <h3 style={{ marginTop: 16 }}>Good to know</h3>
          {TOPICS.map(([name, text]) => (
            <p key={name} className="help-topic">
              <b>{name}.</b> {text}
            </p>
          ))}
        </section>
      </div>
    </Dialog>
  );
}
