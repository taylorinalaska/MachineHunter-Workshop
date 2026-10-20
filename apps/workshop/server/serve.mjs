/**
 * Stand-alone Workshop server: serves the built UI from dist/ plus the local
 * file API, on the loopback interface only.
 *
 *   node apps/workshop/server/serve.mjs [--port 5174] [--open]
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 5174;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error('The Workshop has not been built yet. Run "npm run build" first (or use "npm run dev").');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let path = resolve(dist, '.' + pathname);
  if (path !== dist && !path.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  const address = `http://localhost:${port}/`;
  console.log(`Machine Hunter Workshop is running at ${address}`);
  console.log('Close this window to stop it.');
  if (args.includes('--open')) {
    // Open in the default browser.
    const child = spawn('cmd', ['/c', 'start', '', address], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
});
