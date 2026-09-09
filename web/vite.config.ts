import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync, cpSync } from 'node:fs';
import { resolve, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const TILES_DIR = resolve(__dirname, '../data/tiles');
const ASSETS_DIR = resolve(__dirname, '../assets');

/** Serve ../data/tiles at /tiles/* in dev; copy it into dist/tiles on build. */
function tilesPlugin(): Plugin {
  return {
    name: 'iso-rva-tiles',
    configureServer(server) {
      const serveDir = (dir: string) => (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
        const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
        if (rel.includes('..')) return next();
        const file = join(dir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end('not found');
        }
        res.setHeader('Content-Type', file.endsWith('.glb') ? 'model/gltf-binary' : 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      };
      server.middlewares.use('/tiles', serveDir(TILES_DIR));
      server.middlewares.use('/assets', serveDir(ASSETS_DIR));
    },
    closeBundle() {
      if (existsSync(TILES_DIR)) cpSync(TILES_DIR, resolve(__dirname, 'dist/tiles'), { recursive: true });
      const lm = join(ASSETS_DIR, 'landmarks');
      if (existsSync(lm)) cpSync(lm, resolve(__dirname, 'dist/assets/landmarks'), { recursive: true, filter: (src) => !src.endsWith('.md') });
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [tilesPlugin()],
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022' },
});
