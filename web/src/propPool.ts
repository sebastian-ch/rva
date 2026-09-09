import * as THREE from 'three';
import { PROP_KINDS, buildPropGeometry, type PropKind } from './props';
import type { Placement } from './scatter';

const CAPACITY: Record<PropKind, number> = { tree: 6000, tree_round: 8000, streetlight: 5000, car: 2500, bench: 800, person: 2500 };
const CAR_COLORS = ['brick', 'cream', 'slate', 'steel', 'terracotta', 'roof_green'] as const;

/** One InstancedMesh per prop kind; tiles append instances as they load. Cars are animated along road paths. */
export class PropPool {
  readonly group = new THREE.Group();
  private meshes = new Map<PropKind, THREE.InstancedMesh>();
  private counts = new Map<PropKind, number>();
  private cars: { path: THREE.Vector3[]; t: number; speed: number; idx: number; len: number[] }[] = [];
  private tmp = new THREE.Object3D();
  paused = false;

  constructor(material: THREE.Material) {
    for (const k of PROP_KINDS) {
      const geom = k === 'car' ? mergeCarVariants() : buildPropGeometry(k);
      const im = new THREE.InstancedMesh(geom, material, CAPACITY[k]);
      im.count = 0;
      im.frustumCulled = false;
      im.name = `props:${k}`;
      this.meshes.set(k, im);
      this.counts.set(k, 0);
      this.group.add(im);
    }
  }

  add(placements: Placement[]) {
    for (const p of placements) {
      const im = this.meshes.get(p.kind)!;
      const i = this.counts.get(p.kind)!;
      if (i >= CAPACITY[p.kind]) continue;
      this.tmp.position.set(p.x, p.y, p.z);
      this.tmp.rotation.set(0, p.rot, 0);
      this.tmp.scale.setScalar(p.scale);
      this.tmp.updateMatrix();
      im.setMatrixAt(i, this.tmp.matrix);
      this.counts.set(p.kind, i + 1);
      im.count = i + 1;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  /** Spawn moving cars on a subset of road paths. */
  addCars(paths: THREE.Vector3[][], rand: () => number) {
    const im = this.meshes.get('car')!;
    for (const path of paths) {
      if (path.length < 2) continue;
      const len: number[] = [0];
      for (let i = 1; i < path.length; i++) len.push(len[i - 1] + path[i].distanceTo(path[i - 1]));
      const total = len[len.length - 1];
      if (total < 40 || rand() > 0.35) continue;
      const idx = this.counts.get('car')!;
      if (idx >= CAPACITY.car) return;
      this.counts.set('car', idx + 1);
      im.count = idx + 1;
      this.cars.push({ path: rand() < 0.5 ? path : path.slice().reverse(), t: rand() * total, speed: 6 + rand() * 6, idx, len });
    }
  }

  update(dt: number) {
    if (this.paused || !this.cars.length) return;
    const im = this.meshes.get('car')!;
    for (const c of this.cars) {
      const total = c.len[c.len.length - 1];
      c.t = (c.t + c.speed * dt) % total;
      let i = 1;
      while (i < c.len.length - 1 && c.len[i] < c.t) i++;
      const a = c.path[i - 1], b = c.path[i];
      const seg = c.len[i] - c.len[i - 1];
      const f = seg > 0 ? (c.t - c.len[i - 1]) / seg : 0;
      this.tmp.position.lerpVectors(a, b, f);
      this.tmp.position.x += (b.z - a.z) / Math.max(seg, 1e-6) * 1.6; // drive on the right
      this.tmp.position.z -= (b.x - a.x) / Math.max(seg, 1e-6) * 1.6;
      this.tmp.position.y += 0.05;
      this.tmp.rotation.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      this.tmp.scale.setScalar(1);
      this.tmp.updateMatrix();
      im.setMatrixAt(c.idx, this.tmp.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  }
}

/** Cars share one geometry; bake a few body colors by rotating the palette per vertex-chunk is overkill, so pick one. */
function mergeCarVariants(): THREE.BufferGeometry {
  return buildPropGeometry('car', CAR_COLORS[0]);
}
