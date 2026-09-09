#!/usr/bin/env node
// Screenshot the iso-rva viewer at a named view, a landmark, or a raw local
// coordinate. Requires the Vite dev server to already be running.
//
// Usage:
//   node tools/snap.mjs [view] [--zoom N] [--night] [--heights] [--tour N]
//                        [--at X,Z] [--url http://localhost:5173/] -o out.png
//
// `view` is one of:
//   default              leave the camera at its initial position
//   <landmark-slug>      any slug from ../data/tiles/landmarks.json (zoom 4)
//   intersection | church-hill | river   a few hand-picked local spots
//
// See tools/README.md for details.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser, openViewer, readStats, errorLogs } from './lib/browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data', 'tiles');

// Named spots given directly in local metres (x east, z = -north).
const NAMED_SPOTS = {
  intersection: { lx: 2060, lz: -2560, zoom: 7 },
  'church-hill': { lx: 3300, lz: -2300, zoom: 3 },
  river: { lx: 2000, lz: -1550, zoom: 1.8 },
};

function loadOrigin() {
  const index = JSON.parse(readFileSync(join(DATA_DIR, 'index.json'), 'utf8'));
  return index.origin; // [ox, oy]
}

function loadLandmark(slug) {
  const landmarks = JSON.parse(readFileSync(join(DATA_DIR, 'landmarks.json'), 'utf8'));
  return landmarks[slug] ?? null;
}

function toLocal(x, y, [ox, oy]) {
  return [x - ox, -(y - oy)];
}

function parseArgs(argv) {
  const opts = { view: 'default', zoom: null, night: false, heights: false, tour: null, at: null, url: 'http://localhost:5173/', out: 'snap.png' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zoom') opts.zoom = Number(argv[++i]);
    else if (a === '--night') opts.night = true;
    else if (a === '--heights') opts.heights = true;
    else if (a === '--tour') opts.tour = Number(argv[++i]);
    else if (a === '--at') opts.at = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else rest.push(a);
  }
  if (rest.length) opts.view = rest[0];
  return opts;
}

/** Resolve a view name to a { lx, lz, zoom } target, or null for "default" (no camera move). */
export function resolveView(view, { zoomOverride, atOverride } = {}) {
  if (atOverride) {
    const [x, z] = atOverride.split(',').map(Number);
    if (Number.isNaN(x) || Number.isNaN(z)) throw new Error(`--at expects "X,Z", got "${atOverride}"`);
    return { lx: x, lz: z, zoom: zoomOverride ?? 4 };
  }
  if (!view || view === 'default') return null;
  if (NAMED_SPOTS[view]) {
    const spot = NAMED_SPOTS[view];
    return { lx: spot.lx, lz: spot.lz, zoom: zoomOverride ?? spot.zoom };
  }
  const lm = loadLandmark(view);
  if (lm) {
    const origin = loadOrigin();
    const [lx, lz] = toLocal(lm.x, lm.y, origin);
    return { lx, lz, zoom: zoomOverride ?? 4 };
  }
  throw new Error(`unknown view "${view}" (not "default", a named spot, or a landmark slug)`);
}

async function clickToolbarButton(page, label) {
  await page.evaluate((label) => {
    const btns = Array.from(document.querySelectorAll('#ui button'));
    const btn = btns.find((b) => b.querySelector('.label')?.textContent === label);
    if (!btn) throw new Error(`toolbar button "${label}" not found`);
    btn.click();
  }, label);
}

async function moveCamera(page, target) {
  await page.evaluate(({ lx, lz, zoom }) => {
    const { iso, manager } = window.__iso;
    const { camera, controls } = iso;
    const newTarget = controls.target.clone().set(lx, controls.target.y, lz);
    const delta = newTarget.clone().sub(controls.target);
    controls.target.add(delta);
    camera.position.add(delta);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    controls.update();
    manager().update(camera, zoom, true);
  }, target);
}

export async function snap({ view = 'default', zoom = null, night = false, heights = false, tour = null, at = null, url = 'http://localhost:5173/', out = 'snap.png' } = {}) {
  const target = resolveView(view, { zoomOverride: zoom, atOverride: at });

  const browser = await launchBrowser();
  try {
    const { page, logs } = await openViewer(browser, { url });

    if (night) await clickToolbarButton(page, 'Night');
    if (heights) await clickToolbarButton(page, 'Heights');
    if (tour && tour > 0) {
      for (let i = 0; i < tour; i++) {
        await clickToolbarButton(page, 'Tour');
        await page.waitForTimeout(1700); // let the flyTo animation settle
      }
    }
    if (target) {
      await moveCamera(page, target);
      await page.waitForFunction(() => !window.__iso.manager().busy, null, { timeout: 60000 });
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: out });
    const stats = await readStats(page);
    console.log(JSON.stringify(stats));

    const errs = errorLogs(logs);
    if (errs.length) {
      console.error(`[snap] ${errs.length} console error(s):`);
      for (const e of errs) console.error(`  [${e.type}] ${e.text}`);
    }
    return { stats, errors: errs };
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  snap(opts).catch((err) => {
    console.error(`[snap] failed: ${err.message}`);
    process.exit(1);
  });
}
