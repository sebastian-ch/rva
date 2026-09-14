import assert from 'node:assert/strict';
import { launchBrowser, openViewer, errorLogs } from './lib/browser.mjs';

const url = process.env.CITY_HALL_URL ??
  'http://127.0.0.1:5173/#view=1&region=richmond&x=285051.20&y=4157670.45&z=130.00&zoom=4.2&az=3.9270&distance=1800.00&night=0&map=0&style=classic';
const browser = await launchBrowser();
try {
  const { page, logs } = await openViewer(browser, { url });
  await page.waitForFunction(() => window.__iso.scene.getObjectByName('landmark:richmond-city-hall'));
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => {
    const obj = window.__iso.scene.getObjectByName('landmark:richmond-city-hall');
    let meshes = 0, vertices = 0, vertexColored = 0, bounds = null;
    obj.traverse((child) => {
      if (!child.isMesh) return;
      meshes++;
      vertices += child.geometry.getAttribute('position')?.count ?? 0;
      if (child.geometry.getAttribute('color')) vertexColored++;
      child.geometry.computeBoundingBox();
      bounds = {
        min: child.geometry.boundingBox.min.toArray(),
        max: child.geometry.boundingBox.max.toArray(),
      };
    });
    return {
      visible: obj.visible,
      meshes,
      vertices,
      vertexColored,
      position: obj.position.toArray(),
      bounds,
    };
  });
  await page.screenshot({ path: '/tmp/review-city-hall.png' });
  assert.equal(state.visible, true);
  assert.ok(state.meshes > 0 && state.vertices > 300 && state.vertexColored > 0, JSON.stringify(state));
  assert.equal(errorLogs(logs).length, 0, JSON.stringify(errorLogs(logs)));
  console.log(JSON.stringify(state));
} finally {
  await browser.close();
}
