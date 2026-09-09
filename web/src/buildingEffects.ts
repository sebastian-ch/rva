import * as THREE from 'three';
import { extrudeBuilding } from './buildings';
import { MeshBuilder, cleanRing, polygons, triangulate, rng, hashStr, type V2 } from './geomutil';
import type { BuildingProps } from './types';
import type { LoadedTile } from './tiles';
import type { StyleDefinition } from './styles/definition';

/** Floor count includes the ground storey; plates are the internal boundaries. */
export function floorLayout(p: Pick<BuildingProps, 'height' | 'min_height' | 'levels'>) {
  const span = Math.max(0, p.height - p.min_height);
  const reported = p.levels !== null && Number.isInteger(p.levels) && p.levels > 0 && span / p.levels >= 2.2 && span / p.levels <= 6;
  const count = Math.min(80, Math.max(1, reported ? p.levels! : Math.round(span / 3.6)));
  return { count, estimated: !reported, heights: span >= 18 ? Array.from({ length: count - 1 }, (_, i) => p.min_height + span * (i + 1) / count) : [] };
}

const glass = new THREE.MeshBasicMaterial({ color: '#3b7d99', transparent: true, opacity: 0.10, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
const edgeMaterial = new THREE.LineBasicMaterial({ color: '#9fe8ff', transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });
const floorMaterial = new THREE.MeshBasicMaterial({ color: '#3b7d99', transparent: true, opacity: 0.018, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
const floorLineMaterial = new THREE.LineBasicMaterial({ color: '#9fe8ff', transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
const coreMaterial = new THREE.MeshBasicMaterial({ color: '#ff9f4a', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
const mossMaterial = new THREE.MeshStandardMaterial({ color: '#728952', roughness: 1, flatShading: true });

export function buildXray(tile: LoadedTile, toLocal: (x: number, y: number) => V2): THREE.Group {
  const group = new THREE.Group(); group.name = 'xray-buildings';
  const shell = new MeshBuilder(), floors = new MeshBuilder(), edges: number[] = [], floorEdges: number[] = [], cores: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D(), white = new THREE.Color('white');
  let plateCount = 0, estimatedBuildings = 0;
  for (const feature of tile.buildingFeatures.values()) {
    const p = feature.properties;
    if (p.hidden) continue;
    extrudeBuilding(shell, feature, toLocal, p.ground_z, { details: false });
    const layout = floorLayout(p);
    if (layout.heights.length && layout.estimated) estimatedBuildings++;
    for (const polygon of polygons(feature.geometry)) {
      const rings = polygon.map((r) => cleanRing(r).map(([x, y]) => toLocal(x, y))).filter((r) => r.length >= 3);
      if (!rings.length) continue;
      const all = rings.flat(), indices = triangulate(rings[0], rings.slice(1));
      const base = p.ground_z + p.min_height, top = p.ground_z + p.height;
      for (const ring of rings) for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        edges.push(a[0], base, a[1], a[0], top, a[1], a[0], top, a[1], b[0], top, b[1]);
      }
      for (const height of layout.heights) {
        const y = p.ground_z + height;
        for (let i = 0; i < indices.length; i += 3) {
          const a = all[indices[i]], b = all[indices[i + 1]], c = all[indices[i + 2]];
          floors.tri(new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(b[0], y, b[1]), new THREE.Vector3(c[0], y, c[1]), white);
        }
        // Fine floor perimeter lines keep individual levels legible without opaque slabs.
        for (const ring of rings) for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          floorEdges.push(a[0], y, a[1], b[0], y, b[1]);
        }
        plateCount++;
      }
      if (layout.heights.length && indices.length >= 3) {
        // Use an interior triangle centroid, never a courtyard or concave footprint centroid.
        let best = 0, area = -1;
        for (let i = 0; i < indices.length; i += 3) {
          const a = all[indices[i]], b = all[indices[i+1]], c = all[indices[i+2]];
          const next = Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
          if (next > area) { best = i; area = next; }
        }
        const a = all[indices[best]], b = all[indices[best+1]], c = all[indices[best+2]];
        const x = (a[0]+b[0]+c[0])/3, z = (a[1]+b[1]+c[1])/3;
        let radius = 2;
        for (const ring of rings) for (let i=0;i<ring.length;i++) {
          const u=ring[i], v=ring[(i+1)%ring.length], dx=v[0]-u[0], dz=v[1]-u[1];
          const f=THREE.MathUtils.clamp(((x-u[0])*dx+(z-u[1])*dz)/(dx*dx+dz*dz || 1),0,1);
          radius=Math.min(radius,Math.hypot(x-u[0]-f*dx,z-u[1]-f*dz)*0.45);
        }
        dummy.position.set(x,(base+top)/2,z); dummy.scale.set(radius,top-base,radius); dummy.updateMatrix(); cores.push(dummy.matrix.clone());
      }
    }
  }
  group.add(new THREE.Mesh(shell.build(), glass), new THREE.Mesh(floors.build(), floorMaterial));
  const edgeGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
  const floorGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(floorEdges, 3));
  group.add(new THREE.LineSegments(floorGeometry, floorLineMaterial));
  if (cores.length) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), coreMaterial, cores.length);
    cores.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); group.add(mesh);
  }
  group.userData = { plateCount, estimatedBuildings };
  return group;
}

function buildMoss(tile: LoadedTile): THREE.Group {
  const group = new THREE.Group(); group.name = 'roof-overgrowth';
  const geometry = tile.buildings?.geometry, pos = geometry?.getAttribute('position'), normal = geometry?.getAttribute('normal');
  if (!pos || !normal) return group;
  const rand = rng(hashStr(tile.meta.id)), matrices: THREE.Matrix4[] = [], dummy = new THREE.Object3D();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < pos.count && matrices.length < 1000; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i+1); c.fromBufferAttribute(pos, i+2);
    if (Math.abs(normal.getY(i)) < 0.12 && rand() < 0.22) {
      const vertices=[a,b,c];
      for(let k=0;k<3;k++) {
        const u=vertices[k],v=vertices[(k+1)%3],w=vertices[(k+2)%3];
        if(Math.hypot(u.x-v.x,u.z-v.z)>0.02 || Math.abs(u.y-v.y)<5) continue;
        const fraction=0.15+rand()*0.65;
        const lo=Math.min(u.y,v.y)*(1-fraction)+w.y*fraction;
        const hi=Math.max(u.y,v.y)*(1-fraction)+w.y*fraction;
        const x=u.x*(1-fraction)+w.x*fraction,z=u.z*(1-fraction)+w.z*fraction;
        const n=new THREE.Vector3().fromBufferAttribute(normal,i);
        for(let y=hi;y>Math.max(lo,hi-14) && matrices.length<1000;y-=0.85) {
          dummy.position.set(x+n.x*0.22+(rand()-0.5)*0.4,y,z+n.z*0.22+(rand()-0.5)*0.4);
          dummy.scale.set(Math.abs(n.x)>0.7?0.28:0.65+rand()*0.45,0.65+rand()*0.4,Math.abs(n.z)>0.7?0.28:0.65+rand()*0.45);
          dummy.updateMatrix();matrices.push(dummy.matrix.clone());
        }
        break;
      }
    }
    if (normal.getY(i) < 0.85) continue;
    const area = ab.subVectors(b,a).cross(ac.subVectors(c,a)).length()/2;
    const count = Math.min(30, Math.floor(area/70 + rand()));
    for (let j=0;j<count && matrices.length<1000;j++) {
      const u=Math.sqrt(rand()), v=rand(), size=0.55+rand()*1.1;
      dummy.position.copy(a).multiplyScalar(1-u).addScaledVector(b,u*(1-v)).addScaledVector(c,u*v);
      dummy.position.y += 0.04; dummy.scale.set(size,0.35+rand()*1.1,size); dummy.updateMatrix(); matrices.push(dummy.matrix.clone());
    }
  }
  if (matrices.length) {
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),mossMaterial,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m)); group.add(mesh);
  }
  return group;
}

/** Owns only generated geometry; shared materials and source building geometry are preserved. */
export class BuildingEffects {
  readonly group = new THREE.Group();
  private entries = new Map<LoadedTile, THREE.Group>();
  private style: Pick<StyleDefinition, 'xray' | 'moss'> = { xray: false, moss: false };
  constructor(private toLocal: (x: number, y: number) => V2) { this.group.name = 'building-style-effects'; }
  setStyle(style: StyleDefinition, tiles: LoadedTile[]) {
    for (const tile of [...this.entries.keys()]) this.remove(tile);
    this.style = style;
    for (const tile of tiles) this.add(tile);
  }
  add(tile: LoadedTile) {
    if (tile.buildings) tile.buildings.visible = !this.style.xray;
    if (this.entries.has(tile) || (!this.style.xray && !this.style.moss)) return;
    const group = this.style.xray ? buildXray(tile,this.toLocal) : buildMoss(tile);
    this.entries.set(tile,group); this.group.add(group);
  }
  refresh(tile: LoadedTile) { this.remove(tile); this.add(tile); }
  remove(tile: LoadedTile) {
    if (tile.buildings) tile.buildings.visible = true;
    const group = this.entries.get(tile); if (!group) return;
    group.traverse((o)=> { const geometry=(o as THREE.Mesh).geometry; geometry?.dispose(); });
    this.group.remove(group); this.entries.delete(tile);
  }
}
