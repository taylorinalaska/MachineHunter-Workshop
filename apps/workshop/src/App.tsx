import { useEffect } from 'react';
import { Assets } from './screens/Assets.tsx';
import { Build } from './screens/Build.tsx';
import { Entities } from './screens/Entities.tsx';
import { Home } from './screens/Home.tsx';
import { Mods } from './screens/Mods.tsx';
import { type Screen, useApp } from './state/app.ts';
import { useEditor } from './state/editor.ts';
import { Icon } from './ui/icons.tsx';

const NAV: { screen: Screen; label: string; icon: string }[] = [
  { screen: 'home', label: 'Home', icon: 'home' },
  { screen: 'build', label: 'Build', icon: 'build' },
  { screen: 'entities', label: 'Entities', icon: 'entities' },
  { screen: 'assets', label: 'Assets', icon: 'assets' },
  { screen: 'mods', label: 'Mods', icon: 'mods' },
];

function Setup() {
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.loadError);
  const boot = useApp((s) => s.boot);
  const have = (ok: boolean | undefined) => <span className={ok ? 'pill ok' : 'pill bad'}>{ok ? 'found' : 'missing'}</span>;
  return (
    <div className="splash">
      <div className="box">
        <h1>Machine Hunter Workshop</h1>
        <p className="dim">The Workshop reads the game straight from your own copy of Machine Hunter. A couple of files are missing.</p>
        {error && (
          <p className="card" style={{ marginTop: 14, borderColor: 'var(--red)', textAlign: 'left' }}>
            {error}
          </p>
        )}
        <div className="steps">
          <div className="card row">
            <div className="grow">
              <b>game/DATA/DATA.ARC</b>
              <div className="dim">The game's data archive, from the DATA folder of your disc or install.</div>
            </div>
            {have(status?.game.archive)}
          </div>
          <div className="card row">
            <div className="grow">
              <b>retail/MACHHUNT_ORIGINAL.EXE</b>
              <div className="dim">The untouched retail executable (699,904 bytes). Tables such as levels and briefings are read from it.</div>
            </div>
            {have(status?.retailExecutable)}
          </div>
        </div>
        <p className="dim" style={{ marginTop: 14 }}>
          Folder: <code>{status?.root ?? '…'}</code>
        </p>
        <button className="primary" style={{ marginTop: 16 }} onClick={() => void boot()}>
          Check again
        </button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** How often the open map is autosaved while it has unsaved changes. */
const AUTOSAVE_SECONDS = 60;

export function App() {
  const { game, loading, screen, go, boot } = useApp();
  const hasProject = useEditor((s) => !!s.project);
  const dirty = useEditor((s) => s.dirty);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Autosave the open map every minute while it has unsaved changes, and when the window is hidden or closed.
  useEffect(() => {
    const save = () => void useEditor.getState().autosave();
    const timer = window.setInterval(save, AUTOSAVE_SECONDS * 1000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  // Warn before closing the tab with unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (loading) {
    return (
      <div className="splash">
        <div className="box">
          <div className="spinner" />
          <h2>Machine Hunter Workshop</h2>
          <p className="dim" style={{ marginTop: 6 }}>
            {loading}
          </p>
        </div>
      </div>
    );
  }
  if (!game) return <Setup />;

  return (
    <div className="shell">
      <nav className="nav">
        <div className="logo" title="Machine Hunter Workshop">
          MH
        </div>
        {NAV.map((item) => (
          <button key={item.screen} className={screen === item.screen ? 'active' : ''} onClick={() => go(item.screen)} title={item.label}>
            <Icon name={item.icon} size={20} />
            {item.label}
            {item.screen === 'build' && dirty ? ' •' : ''}
          </button>
        ))}
      </nav>
      <div className="screen">
        {screen === 'home' && <Home />}
        {/* The builder stays mounted so its 3D view and undo history survive visits to other screens. */}
        <div style={{ display: screen === 'build' ? 'block' : 'none', height: '100%' }}>{hasProject ? <Build visible={screen === 'build'} /> : screen === 'build' && <Home />}</div>
        {screen === 'entities' && <Entities />}
        {screen === 'assets' && <Assets />}
        {screen === 'mods' && <Mods />}
      </div>
      <Toasts />
    </div>
  );
}
