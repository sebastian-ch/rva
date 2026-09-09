#!/usr/bin/env node
// Smoke test for the iso-rva viewer: loads it, waits for the tile manager to
// settle, sanity-checks stats, exercises every toolbar button, and grabs a
// few reference screenshots. Requires the Vite dev server to already be
// running. Exits non-zero with a clear message on any failure.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser, openViewer, readStats, errorLogs } from './lib/browser.mjs';
import { resolveView, regionId } from './snap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, '..', 'snapshots');
const URL = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const SETTLE_TIMEOUT_MS = 180000;

const TOOLBAR_LABELS = ['Night', 'Pause', 'Map', /* 'Tour' (hidden for now) */ 'Heights'];

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

async function moveCamera(page, { lx, lz, zoom }) {
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
  }, { lx, lz, zoom });
  await page.waitForFunction(() => !window.__iso.manager().busy, null, { timeout: 60000 });
  await page.waitForTimeout(800);
}

async function main() {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  console.log(`[smoke] launching browser, loading ${URL} ...`);
  const browser = await launchBrowser();
  let exitOk = true;
  try {
    const { page, logs } = await openViewer(browser, { url: URL, timeout: SETTLE_TIMEOUT_MS });

    console.log('[smoke] checking stats after settle ...');
    const stats = await readStats(page);
    console.log(`[smoke] stats: ${JSON.stringify(stats)}`);

    if (!(stats.tiles > 0)) fail(`expected tiles > 0, got ${stats.tiles}`);
    if (!(stats.iso && stats.iso.tiles && stats.iso.tiles.full > 0)) {
      fail(`expected stats().tiles.full > 0, got ${JSON.stringify(stats.iso)}`);
    }

    let baseline = errorLogs(logs);
    if (baseline.length) {
      fail(`console errors during initial load:\n${baseline.map((e) => `  [${e.type}] ${e.text}`).join('\n')}`);
    }

    console.log('[smoke] taking snapshots/default.png ...');
    await page.screenshot({ path: join(SNAPSHOTS_DIR, 'default.png') });
    if (regionId === 'honolulu') {
      await page.setViewportSize({ width: 1000, height: 1300 });
      await page.waitForTimeout(1000);
      await page.waitForFunction(() => !window.__iso.manager().busy);
      await page.screenshot({ path: join(SNAPSHOTS_DIR, 'honolulu-portrait.png') });
      await page.setViewportSize({ width: 1600, height: 1000 });
    }

    const views = regionId === 'honolulu' ? ['crater', 'coast'] : ['virginia-state-capitol', 'river'];
    for (const view of views) {
      console.log(`[smoke] moving to ${view} view ...`);
      await moveCamera(page, resolveView(view, {}));
      await page.screenshot({ path: join(SNAPSHOTS_DIR, `${view}.png`) });
    }

    let seen = errorLogs(logs).length;
    if (seen > baseline.length) {
      const fresh = errorLogs(logs).slice(baseline.length);
      fail(`console errors while navigating to landmarks:\n${fresh.map((e) => `  [${e.type}] ${e.text}`).join('\n')}`);
    }

    console.log('[smoke] exercising toolbar buttons ...');
    for (const label of TOOLBAR_LABELS) {
      const before = errorLogs(logs).length;
      await page.evaluate((label) => {
        const btns = Array.from(document.querySelectorAll('#ui button'));
        const btn = btns.find((b) => b.querySelector('.label')?.textContent === label);
        if (!btn) throw new Error(`toolbar button "${label}" not found`);
        btn.click();
      }, label);
      await page.waitForTimeout(500);
      if (label === 'Night' && regionId === 'honolulu') {
        const skyVisible = await page.evaluate(() => window.__iso.scene.getObjectByName('tropical-sky')?.visible);
        if (skyVisible !== false) fail('daytime sky must be hidden at night');
        await page.screenshot({ path: join(SNAPSHOTS_DIR, 'honolulu-night.png') });
      }
      const after = errorLogs(logs).length;
      if (after > before) {
        const fresh = errorLogs(logs).slice(before);
        fail(`clicking toolbar button "${label}" produced console error(s):\n${fresh.map((e) => `  [${e.type}] ${e.text}`).join('\n')}`);
      }
      console.log(`[smoke]   "${label}" ok`);
    }

    console.log('[smoke] all checks passed.');
  } catch (err) {
    exitOk = false;
    console.error(`[smoke] ${err.message}`);
  } finally {
    await browser.close();
  }

  if (!exitOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[smoke] unexpected failure: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
