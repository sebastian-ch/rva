import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import regions from '../regions.json' with { type: 'json' };
const __dirname = dirname(fileURLToPath(import.meta.url));

const region = process.env.ISO_REGION ?? 'richmond';
if (!(region in regions)) throw new Error(`Unknown ISO_REGION: ${region}`);
const profile = regions[region as keyof typeof regions];
const TILES_DIR = resolve(__dirname, '..', profile.data, 'tiles');
const ASSETS_DIR = resolve(__dirname, '..', profile.assets);
// Stable asset names are copied outside Vite's hashed module graph. Change their
// request URL when their bytes change, including model-only deployments.
const landmarkDir = join(ASSETS_DIR, 'landmarks');
const landmarkVersions = Object.fromEntries((existsSync(landmarkDir) ? readdirSync(landmarkDir) : [])
  .filter(name => name.endsWith('.glb'))
  .map(name => [`landmarks/${name}`, createHash('sha256').update(readFileSync(join(landmarkDir, name))).digest('hex').slice(0, 16)]));

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
  define: { 'import.meta.env.VITE_REGION': JSON.stringify(region), 'import.meta.env.VITE_LANDMARK_VERSIONS': JSON.stringify(landmarkVersions) },
  base: process.env.BASE_PATH ?? '/',
  plugins: [tilesPlugin()],
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022' },
});
