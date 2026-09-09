import assert from 'node:assert/strict';
import {launchBrowser,openViewer,waitForSettle,errorLogs} from './lib/browser.mjs';
const browser=await launchBrowser();
try {
 const {page,logs}=await openViewer(browser,{url:process.env.REVIEW_URL ?? 'http://127.0.0.1:5173/'});
 const initialReduced=await page.evaluate(()=>window.__iso.tiles.filter(t=>t.lod===1).flatMap(t=>t.placements));
 assert(initialReduced.length>0,'Reduced-detail tiles must retain trees');
 assert(initialReduced.every(p=>p.kind.startsWith('tree')));
 await page.evaluate(()=>{const {iso,manager}=window.__iso;iso.camera.zoom=0.35;iso.camera.updateProjectionMatrix();iso.controls.update();manager().update(iso.camera,0.35,true);});
 await waitForSettle(page);await page.waitForTimeout(1500);
 const result=await page.evaluate(()=>{
  const {tiles,props}=window.__iso;
  const expected=tiles.flatMap(t=>t.placements).filter(p=>p.kind.startsWith('tree')).length;
  const rendered=Object.entries(props.counts_()).filter(([k])=>k.startsWith('tree')).reduce((n,[,v])=>n+v,0);
  const reduced=tiles.filter(t=>t.lod===1).flatMap(t=>t.placements);
  return {expected,rendered,reducedTrees:reduced.length,reducedOnlyTrees:reduced.every(p=>p.kind.startsWith('tree')),models:performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('.glb'))};
 });
 assert(result.expected>8000,JSON.stringify(result));
 assert.equal(result.rendered,result.expected);
 assert(result.reducedOnlyTrees);
 assert(result.models.length>0);
 assert(result.models.every(url=>/[?&]v=[a-f0-9]{16}/.test(url)));
 assert.equal(errorLogs(logs).length,0,JSON.stringify(errorLogs(logs)));
 await page.screenshot({path:'snapshots/richmond/tree-loading.png'});
 console.log(JSON.stringify(result));
}finally{await browser.close();}
