// Shared Playwright helpers for tools/snap.mjs and tools/smoke.mjs.
//
// Renders the viewer with Chrome + SwiftShader (software GL) via playwright-core.
// This is the only combination that reliably works headless/CI without a real GPU.
// It is SLOW: a cold load + first-tile settle can take 30-90s.

import { chromium } from 'playwright-core';

const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Launch Chrome (falling back to bundled Chromium) with SwiftShader flags. */
export async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', args: SWIFTSHADER_ARGS });
  } catch (err) {
    console.warn(`[browser] channel "chrome" failed (${err.message}); falling back to bundled chromium`);
    return await chromium.launch({ args: SWIFTSHADER_ARGS });
  }
}

/** Known-benign console patterns that should not fail a smoke check. */
export const BENIGN_CONSOLE_PATTERNS = [
  /GL Driver Message/i,
  /PCFSoftShadowMap/i,
  /Clock.*deprecat/i,
  /toNonIndexed/i,
  /404.*favicon/i,
  /favicon.*404/i,
];

export function isBenignLog(text) {
  return BENIGN_CONSOLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Open `url` in a new page, wire up console/pageerror capture, and wait for
 * window.__iso to exist with at least one tile loaded and the manager idle.
 */
export async function openViewer(browser, { url = 'http://localhost:5173/', timeout = 180000, viewport = { width: 1600, height: 1000 } } = {}) {
  const page = await browser.newPage({ viewport });
  const logs = [];
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }));

  await page.goto(url, { waitUntil: 'load' });
  await waitForSettle(page, timeout);
  await page.waitForTimeout(1500);

  return { page, logs };
}

/** Wait until __iso is booted, has tiles, and the tile manager is idle. */
export async function waitForSettle(page, timeout = 180000) {
  await page
    .waitForFunction(
      () => window.__iso && window.__iso.manager && window.__iso.manager() && window.__iso.tiles.length > 0 && !window.__iso.iso.isAnimating && !window.__iso.manager().busy,
      null,
      { timeout },
    )
    .catch((e) => {
      throw new Error(`viewer did not settle within ${timeout}ms: ${e.message}`);
    });
}

/** Visit projected coordinates using the active manifest's local origin. */
export async function visitProjected(page, { x, y, zoom = 3.3, height = 48 }) {
  const origin = await page.evaluate(async () => {
    const url = new URL('tiles/index.json', location.href);
    return (await (await fetch(url)).json()).origin;
  });
  await page.evaluate(({ x, y, zoom, height, origin }) => {
    const { iso, manager } = window.__iso;
    const next = iso.controls.target.clone().set(x - origin[0], height, origin[1] - y);
    iso.camera.position.add(next.clone().sub(iso.controls.target));
    iso.controls.target.copy(next);
    iso.camera.zoom = zoom;
    iso.camera.updateProjectionMatrix();
    iso.controls.update();
    manager().update(iso.camera, zoom, true);
  }, { x, y, zoom, height, origin });
  await waitForSettle(page);
  await page.waitForTimeout(800);
}

/** Evaluate window.__iso.stats() plus a few scene-level counters. */
export async function readStats(page) {
  return page.evaluate(() => {
    const i = window.__iso;
    let tris = 0;
    i.scene.traverse((o) => {
      if (o.isMesh && o.geometry.getAttribute('position')) {
        tris += (o.geometry.getAttribute('position').count / 3) * (o.isInstancedMesh ? o.count : 1);
      }
    });
    return {
      iso: i.stats && i.stats(),
      tiles: i.tiles.length,
      children: i.scene.children.length,
      tris: Math.round(tris),
    };
  });
}

export function errorLogs(logs) {
  return logs.filter((l) => (l.type === 'error' || l.type === 'pageerror') && !isBenignLog(l.text));
}
