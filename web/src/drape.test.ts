import {expect,it} from 'vitest';
import * as THREE from 'three';
import {conformTriangle} from './drape';

it('resolves a narrow cut missed by the initial midpoint and centroid probes',()=>{
 const height=(x:number,z:number)=>Math.abs(x-15)<3 && Math.abs(z-10)<3 ? 0 : 10;
 const triangles:THREE.Vector3[][]=[];
 conformTriangle(new THREE.Vector3(0,10,0),new THREE.Vector3(80,10,0),new THREE.Vector3(0,10,80),height,(...v)=>triangles.push(v));
 expect(triangles.flat().some(v=>v.y===0)).toBe(true);
 expect(triangles.length).toBeGreaterThan(1);
});
