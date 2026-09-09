import assert from 'node:assert/strict';
import {launchBrowser,openViewer,waitForSettle,errorLogs,readStats} from './lib/browser.mjs';
const browser=await launchBrowser();
try {
 const {page,logs}=await openViewer(browser,{url:'http://127.0.0.1:5173/'});
 for(const [name,x,y,zoom] of [['james-road',285220,4157130,3.3],['shockoe-roofs',285680,4157180,3.8],['broad-street-ramps',285425,4157290,4.5],['federal-reserve-freeway',284700,4157010,4.2]]) {
  if (process.env.QA_VIEW && process.env.QA_VIEW !== name) continue;
  await page.evaluate(({x,y,zoom})=>{
   const {iso,manager}=window.__iso;
   const next=iso.controls.target.clone().set(x-282750,48,4154750-y);
   iso.camera.position.add(next.clone().sub(iso.controls.target));iso.controls.target.copy(next);
   iso.camera.zoom=zoom;iso.camera.updateProjectionMatrix();iso.controls.update();manager().update(iso.camera,zoom,true);
  },{x,y,zoom});await waitForSettle(page);await page.waitForTimeout(800);
  await page.screenshot({path:`snapshots/richmond/${name}.png`});
 }
 console.log(JSON.stringify(await readStats(page)));
 assert.equal(errorLogs(logs).length,0,JSON.stringify(errorLogs(logs)));
}finally{await browser.close();}
