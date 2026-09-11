import assert from 'node:assert/strict';
import {launchBrowser,openViewer,visitProjected,errorLogs,readStats} from './lib/browser.mjs';
const browser=await launchBrowser();
try {
 const {page,logs}=await openViewer(browser,{url:process.env.REVIEW_URL ?? 'http://127.0.0.1:5173/'});
 for(const [name,x,y,zoom,height=48] of [
  ['james-road',285220,4157130,3.3],['shockoe-roofs',285680,4157180,3.8],
  ['broad-street-ramps',285425,4157290,4.5],['broad-bus-lanes',285230,4157440,3.8],
  ['federal-reserve-freeway',284700,4157010,4.2],
  ['fan-cary-crossings',280412.10,4159423.47,5.006],
  ['fan-harrison-crossings',281052.84,4159930.87,3.469],
  ['fan-expressway-descent',280529.60,4160402.41,3.890],
  ['fan-service-junction-rosewood',281824.87,4158290.13,3.975,0],
  ['fan-service-junction-grayland',281869.98,4158407.33,6.221,0],
  ['fan-meadow-bridge',281928.62,4158535.68,5.711,0],
  ['fan-service-junction-belmont',280975.31,4159291.00,6.149,0],
  ['fan-sidewalk-auburn',280585.55,4159236.00,12.000,0],
  ['fan-road-elevation-cumberland',280686.17,4158856.05,3.874,0],
  ['fan-freeway-descent-monument',280645.73,4160634.86,3.497,0],
  ['fan-freeway-descent-monument-close',280800,4160600,8.000,95],
  ['fan-elevated-footpath',281640.28,4158643.40,4.829,0],
  ['byrd-theatre',281117.91,4159043.62,10.000,117],
  ['cary-mcdonalds',280447.44,4159362.17,12.000,122],
  ['fan-roundabout',282883.07,4158525.19,10.868,0],
  ['fan-crosswalk-lombardy',283703.67,4158682.20,8.315,0],
  ['fan-junction-broad-gilmer',283722.27,4158688.34,8.068,0],
  ['downtown-sidewalk-edge',284004.97,4157577.72,6.716,0],
  ['downtown-ramp-connection',285593.75,4157526.06,7.302,0],
  ['fan-service-junction-meadow',281506.39,4157052.19,5.915,0],
 ]) {
  if (process.env.QA_VIEW && process.env.QA_VIEW !== name) continue;
  await visitProjected(page,{x,y,zoom,height});
  await page.screenshot({path:`snapshots/richmond/${name}.png`});
 }
 console.log(JSON.stringify(await readStats(page)));
 assert.equal(errorLogs(logs).length,0,JSON.stringify(errorLogs(logs)));
}finally{await browser.close();}
