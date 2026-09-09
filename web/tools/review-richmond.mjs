import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {launchBrowser,openViewer,waitForSettle,errorLogs} from './lib/browser.mjs';
const out='snapshots/richmond'; mkdirSync(out,{recursive:true});
const browser=await launchBrowser();
try {
 const {page,logs}=await openViewer(browser,{url:process.env.SMOKE_URL??'http://127.0.0.1:5173/'});
 const picker=page.getByRole('combobox',{name:'Map style'});
 const search=page.getByRole('combobox',{name:'Search places or addresses'});
 await search.fill('Virginia State Capitol'); await page.locator('#place-results [role="option"]').first().waitFor();
 await search.press('ArrowDown'); await search.press('Enter');
 await page.waitForFunction(()=>!window.__iso.iso.isAnimating); await waitForSettle(page); await page.keyboard.press('Escape');
 assert.ok(Math.abs(await page.evaluate(()=>window.__iso.iso.camera.zoom)-2.6)<0.002);
 const styles=await picker.locator('option').evaluateAll(options=>options.map(o=>o.value));
 for(const style of styles) {
  await picker.selectOption(style); await page.waitForTimeout(600);
  await page.screenshot({path:`${out}/${style}-capitol.png`});
  await page.getByRole('button',{name:'Share view'}).click();
  await page.waitForFunction(s=>new URLSearchParams(location.hash.slice(1)).get('style')===s,style);
  const before=await page.evaluate(()=>window.__iso.iso.controls.target.toArray());
  await page.reload(); await waitForSettle(page); assert.equal(await picker.inputValue(),style);
  const after=await page.evaluate(()=>window.__iso.iso.controls.target.toArray());
  before.forEach((v,i)=>assert.ok(Math.abs(v-after[i])<0.02));
  if(style==='xray') assert.ok(await page.evaluate(()=>{let n=0;window.__iso.scene.traverse(o=>n+=o.userData.plateCount??0);return n>0;}));
 }
 await page.setViewportSize({width:390,height:844}); await waitForSettle(page);
 for(const style of styles) {
  await picker.selectOption(style); await page.waitForTimeout(400);
  assert.ok(await picker.isVisible()); const b=await picker.boundingBox(); assert.ok(b.x>=0&&b.x+b.width<=390);
  await page.screenshot({path:`${out}/${style}-mobile.png`});
 }
 await picker.selectOption('classic');
 assert.equal(await page.evaluate(()=>window.__iso.scene.getObjectByName('building-style-effects').children.length),0);
 assert.equal(errorLogs(logs).length,0,JSON.stringify(errorLogs(logs)));
 console.log('Search, all style share/restore checks, X-ray floors, mobile dropdown and cleanup passed.');
} finally {await browser.close();}
