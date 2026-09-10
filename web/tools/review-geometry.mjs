import assert from 'node:assert/strict';
import {launchBrowser,openViewer,visitProjected,errorLogs,readStats} from './lib/browser.mjs';
const browser=await launchBrowser();
try {
 const {page,logs}=await openViewer(browser,{url:process.env.REVIEW_URL ?? 'http://127.0.0.1:5173/'});
 for(const [name,x,y,zoom] of [['james-road',285220,4157130,3.3],['shockoe-roofs',285680,4157180,3.8],['broad-street-ramps',285425,4157290,4.5],['broad-bus-lanes',285230,4157440,3.8],['federal-reserve-freeway',284700,4157010,4.2]]) {
  if (process.env.QA_VIEW && process.env.QA_VIEW !== name) continue;
  await visitProjected(page,{x,y,zoom});
  await page.screenshot({path:`snapshots/richmond/${name}.png`});
 }
 console.log(JSON.stringify(await readStats(page)));
 assert.equal(errorLogs(logs).length,0,JSON.stringify(errorLogs(logs)));
}finally{await browser.close();}
