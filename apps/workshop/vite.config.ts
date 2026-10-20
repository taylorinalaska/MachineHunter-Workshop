import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// The local file API is plain JavaScript so the stand-alone server can use it without a build step.
// @ts-expect-error -- no type declarations for the .mjs module
import { handleApi } from './server/api.mjs';

/** Mounts the Workshop's local file API on the dev server. */
function localApi(): Plugin {
  return {
    name: 'mh-local-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handleApi(req, res).then((handled: boolean) => {
          if (!handled) next();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi()],
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
