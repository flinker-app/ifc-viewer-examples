import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import configuration from '../viewer-sdk.config.json' with { type: 'json' };

const repository = fileURLToPath(new URL('../', import.meta.url));
const prefix = '/__viewer_sdk__/';

// Use the published CDN by default. An explicit directory opts development into
// a local build without copying SDK files into this repository.
export function localSdk({ directory = process.env.IFC_VIEWER_SDK_DIR, root = repository } = {}) {
  if (!directory) return { name: 'published-viewer-sdk' };
  const build = resolve(root, directory);
  const entry = resolve(build, 'ifc-viewer.es.js');
  if (!existsSync(entry)) throw new Error(`Local SDK build is missing: ${entry}`);
  let reload;
  return {
    name: 'local-viewer-sdk',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(`Using local viewer SDK: ${entry}`);
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (!url.pathname.startsWith(prefix)) return next();
        let filename;
        try { filename = resolve(build, decodeURIComponent(url.pathname.slice(prefix.length))); }
        catch { response.writeHead(400).end(); return; }
        if (!filename.startsWith(build + sep) || !existsSync(filename) || !statSync(filename).isFile()) {
          response.writeHead(404).end(); return;
        }
        const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        if (request.method === 'HEAD') response.end();
        else createReadStream(filename).pipe(response);
      });
      server.watcher.add(entry);
      const onChange = filename => {
        if (resolve(filename) !== entry) return;
        clearTimeout(reload);
        reload = setTimeout(() => server.ws.send({ type: 'full-reload' }), 300);
      };
      server.watcher.on('change', onChange);
      server.httpServer?.once('close', () => { clearTimeout(reload); server.watcher.off('change', onChange); });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!context.server) return html;
        const origin = context.server.resolvedUrls?.local[0];
        if (!origin) throw new Error('The development server has no local URL.');
        // An absolute URL bypasses Vite import analysis for the already-built SDK.
        return html.replaceAll(configuration.url, new URL(prefix + 'ifc-viewer.es.js', origin).href);
      },
    },
  };
}
