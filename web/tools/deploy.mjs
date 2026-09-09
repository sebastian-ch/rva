#!/usr/bin/env node
/**
 * Build the viewer for GitHub Pages and push `dist/` to the `gh-pages` branch of a repo.
 *
 *   npm run deploy -- [--remote https://github.com/<owner>/<repo>.git] [--base /<repo>/] [--dry-run]
 *
 * Defaults: remote from `git remote get-url origin` of this checkout, base path = "/<repo name>/". Pages must be
 * set to serve the gh-pages branch (root) once; `gh api` can do it (see README). Tiles and landmark models are
 * copied into dist by vite.config.ts, so the pipeline must have been run first.
 */
import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dry = args.includes('--dry-run');
const sh = (cmd, cwd = web, env = process.env) => execSync(cmd, { cwd, stdio: 'inherit', env });
const out = (cmd, cwd = web) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

let remote = opt('--remote', null);
if (!remote) {
  try { remote = out('git remote get-url origin'); } catch { /* none */ }
}
if (!remote) { console.error('no remote: pass --remote <url> or add an origin'); process.exit(1); }
const repoName = remote.replace(/\.git$/, '').split('/').pop();
const base = opt('--base', `/${repoName}/`);

if (!existsSync(resolve(web, '../data/tiles/index.json'))) { console.error('data/tiles is empty: run pipeline/build_tiles.py first'); process.exit(1); }

console.log(`building with base ${base}`);
sh('npx tsc --noEmit');
sh('npx vite build', web, { ...process.env, BASE_PATH: base });
const dist = resolve(web, 'dist');
writeFileSync(resolve(dist, '.nojekyll'), '');

if (dry) { console.log(`dry run: built ${dist}; would push to ${remote} gh-pages`); process.exit(0); }
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
sh('git init -q -b gh-pages', dist);
sh('git add -A', dist);
sh(`git -c user.name=deploy -c user.email=deploy@local commit -q -m "deploy ${new Date().toISOString()}"`, dist);
sh(`git push --force "${remote}" gh-pages:gh-pages`, dist);
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
console.log(`pushed to ${remote} (branch gh-pages). Site: https://${remote.split('/')[3] ?? ''}.github.io${base}`);
