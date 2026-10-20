import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- shared server module is plain JavaScript
import { createFiles } from '../server/files.mjs';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const folders: string[] = [];
afterEach(async () => { for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('returns immediately while Save As is open, then authorizes saving and reopening the chosen file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mh-files-'));
  folders.push(dir);
  const path = join(dir, 'chosen.mhproject');
  let finish!: (path: string | null) => void;
  const files = createFiles({ projectsDir: join(dir, 'projects'), HttpError, showDialog: () => new Promise((resolve) => { finish = resolve; }) });
  const call = async (route: string[], method: string, query = '', data = Buffer.alloc(0)) => {
    let result: any;
    await files.handle(route, method, new URL(`http://localhost/api/?${query}`), {}, {}, {
      readBody: async () => data,
      sendJson: (_res: unknown, value: unknown) => { result = value; },
      sendFile: async (_res: unknown, file: string) => { result = await readFile(file); },
    });
    return result;
  };
  const started = await call(['dialog', 'save'], 'POST');
  expect(started.dialog).toEqual(expect.any(String));
  expect(await call(['dialog', started.dialog], 'GET')).toEqual({ pending: true });
  await expect(call(['dialog', 'save'], 'POST')).rejects.toThrow('already open');
  finish(path);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await call(['dialog', started.dialog], 'GET')).toEqual({ path });
  const query = `path=${encodeURIComponent(path)}`;
  const bytes = Buffer.from('project bytes');
  expect(await call(['file'], 'PUT', query, bytes)).toMatchObject({ ok: true, size: bytes.length });
  expect(await call(['file'], 'GET', query)).toEqual(bytes);
  const canceled = await call(['dialog', 'save'], 'POST');
  finish(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await call(['dialog', canceled.dialog], 'GET')).toEqual({ path: null });
});
