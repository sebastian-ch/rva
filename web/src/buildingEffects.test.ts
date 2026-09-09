import {expect,it} from 'vitest';
import {floorLayout,buildXray,BuildingEffects} from './buildingEffects';
import {MAP_STYLES} from './styles';
import * as THREE from 'three';
import type {LoadedTile} from './tiles';
import type {BuildingProps,Feature,PolyGeom} from './types';
it('uses plausible reported floors and estimates missing or implausible counts',()=>{
 expect(floorLayout({height:36,min_height:0,levels:12})).toMatchObject({count:12,estimated:false});
 expect(floorLayout({height:36,min_height:0,levels:null})).toMatchObject({count:10,estimated:true});
 expect(floorLayout({height:36,min_height:0,levels:1000})).toMatchObject({count:10,estimated:true});
 expect(floorLayout({height:36,min_height:6,levels:10}).heights).toEqual([9,12,15,18,21,24,27,30,33]);
 expect(floorLayout({height:8,min_height:0,levels:2}).heights).toEqual([]);
});
it('creates floors without filling courtyards and disposes effects when leaving X-ray',()=>{
 const p={id:'tower',height:30,min_height:0,levels:10,ground_z:5,roof_shape:'flat',roof_height:0,wall_color:'concrete',roof_color:'roof_flat'} as BuildingProps;
 const f:Feature<PolyGeom,BuildingProps>={type:'Feature',properties:p,geometry:{type:'Polygon',coordinates:[[[0,0],[20,0],[20,20],[0,20],[0,0]],[[5,5],[5,15],[15,15],[15,5],[5,5]]]}};
 const tile={buildingFeatures:new Map([['tower',f]]),buildings:new THREE.Mesh(),meta:{id:'test'}} as unknown as LoadedTile;
 const group=buildXray(tile,(x,y)=>[x,y]);
 expect(group.userData.plateCount).toBe(9);
 const pos=(group.children[1] as THREE.Mesh).geometry.getAttribute('position');
 let area=0;
 for(let i=0;i<pos.count;i+=3){
  const x=(pos.getX(i)+pos.getX(i+1)+pos.getX(i+2))/3,z=(pos.getZ(i)+pos.getZ(i+1)+pos.getZ(i+2))/3;
  expect(x>5&&x<15&&z>5&&z<15).toBe(false);
  area+=Math.abs((pos.getX(i+1)-pos.getX(i))*(pos.getZ(i+2)-pos.getZ(i))-(pos.getZ(i+1)-pos.getZ(i))*(pos.getX(i+2)-pos.getX(i)))/2;
 }
 expect(area).toBeCloseTo(300*9);
 const effects=new BuildingEffects((x,y)=>[x,y]); effects.setStyle(MAP_STYLES.xray,[tile]);
 expect(tile.buildings!.visible).toBe(false); expect(effects.group.children.length).toBe(1);
 effects.setStyle(MAP_STYLES.classic,[tile]); expect(tile.buildings!.visible).toBe(true); expect(effects.group.children.length).toBe(0);
});
