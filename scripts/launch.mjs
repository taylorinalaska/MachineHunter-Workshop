import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { checkGame, chooseGameFolder, root, setupGame } from './setup-game.mjs';

try {
  try { checkGame(); } catch {
    console.log('First-time game setup: select your original Machine Hunter folder.');
    setupGame(chooseGameFolder());
  }
  if (process.argv[2] === 'game') {
    const env = { ...process.env };
    delete env.MH_AUTOSTART_MAP;
    env.MH_SKIP_LAUNCHER = '1';
    const child = spawn(join(root, 'game/MACHHUNT.EXE'), [], { cwd: join(root, 'game'), detached: true, stdio: 'ignore', env });
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.unref();
  } else {
    process.argv.push('--open');
    await import('../apps/workshop/server/serve.mjs');
  }
} catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
