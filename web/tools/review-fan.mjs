import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, openViewer, visitProjected, waitForSettle, errorLogs, readStats } from './lib/browser.mjs';

const out = 'snapshots/fan';
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const { page, logs } = await openViewer(browser, { url: process.env.REVIEW_URL ?? 'http://127.0.0.1:5173/' });
  const views = [
    ['stuart-circle', 283012, 4158946, 3.5],
    ['scuffletown', 282062, 4159406, 4],
    ['meadow-park', 282461, 4159140, 4],
    ['upper-fan', 281276, 4159480, 3.5],
    ['structures-decks', 280875, 4159625, 8],
    ['monroe-park', 283541, 4158368, 3.3],
  ];
  const stats = [];
  for (const [name, x, y, zoom] of views) {
    await visitProjected(page, { x, y, zoom, height: 105 });
    await page.screenshot({ path: `${out}/${name}.png` });
    stats.push({ name, ...await readStats(page) });
  }
  const search = page.getByRole('combobox', { name: 'Search places or addresses' });
  await search.fill('Hanover');
  await page.locator('#place-results [role="option"]').first().waitFor();
  await search.press('ArrowDown');
  await search.press('Enter');
  await waitForSettle(page);
  const picker = page.getByRole('combobox', { name: 'Map style' });
  for (const style of ['classic', 'risograph', 'midnight', 'terrarium', 'xray']) {
    await picker.selectOption(style);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}/hanover-${style}.png` });
  }
  await picker.selectOption('classic');
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForSettle(page);
  const bounds = await picker.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  const card = await page.locator('.info-card').boundingBox();
  const toolbar = await page.locator('.toolbar').boundingBox();
  assert(card && toolbar && card.y + card.height <= toolbar.y, 'Selection card must not cover mobile controls');
  assert.notEqual(await page.locator('.info-card h2').textContent(), 'Yes building');
  await picker.selectOption('risograph');
  await picker.selectOption('classic');
  await page.screenshot({ path: `${out}/mobile.png` });
  assert.equal(errorLogs(logs).length, 0, JSON.stringify(errorLogs(logs)));
  writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats));
  console.log('Fan views, address search, styles, mobile layout and graphics checks passed.');
} finally {
  await browser.close();
}
