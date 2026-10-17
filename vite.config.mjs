import { defineConfig } from 'vite';
import { generate } from './scripts/example-metadata.mjs';
import { localSdk } from './scripts/local-sdk.mjs';
export default defineConfig({
  appType: 'mpa',
  plugins: [localSdk(), {
    name: 'example-metadata',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname.endsWith('/') || pathname.endsWith('.html')) generate();
        next();
      });
    },
  }],
});
