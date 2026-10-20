/** Application-wide state: game data, the current screen, notifications. */
import { create } from 'zustand';
import { type GameStatus, api } from '../game/api.ts';
import { GameData } from '../game/gamedata.ts';

export type Screen = 'home' | 'build' | 'entities' | 'assets' | 'mods';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface AppState {
  status: GameStatus | null;
  game: GameData | null;
  loading: string | null;
  loadError: string | null;
  screen: Screen;
  toasts: Toast[];
  boot: () => Promise<void>;
  go: (screen: Screen) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

let nextToast = 1;

export const useApp = create<AppState>((set, get) => ({
  status: null,
  game: null,
  loading: 'Starting…',
  loadError: null,
  screen: 'home',
  toasts: [],

  boot: async () => {
    try {
      set({ loading: 'Looking for your game files…', loadError: null });
      const status = await api.status();
      set({ status });
      if (!status.game.archive || !status.retailExecutable) {
        set({ loading: null });
        return;
      }
      const game = await GameData.load((loading) => set({ loading }));
      set({ game, loading: null });
    } catch (error) {
      set({ loading: null, loadError: (error as Error).message });
    }
  },

  go: (screen) => set({ screen }),

  toast: (text, kind = 'info') => {
    const id = nextToast++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    window.setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 4000);
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** The loaded game data; only call from screens that render after loading finished. */
export function useGame(): GameData {
  const game = useApp((s) => s.game);
  if (!game) throw new Error('Game data is not loaded');
  return game;
}
