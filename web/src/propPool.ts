import * as THREE from 'three';
import { PROP_KINDS, VEHICLE_KINDS, buildPropGeometry, hex, type PropKind } from './props';
import type { Placement } from './scatter';
import type { PoseSink } from './trafficClient';
import { MAX_VEHICLES, POSE_STRIDE, VEHICLE_COLORS, VEHICLE_KIND_NAMES } from './traffic/protocol';
export { laneOffset } from './traffic/graph';

const CAPACITY: Record<PropKind, number> = {
  tree: 6000,
  tree_round: 8000,
  streetlight: 5000,
  car: 6000,
  suv: 2500,
  pickup: 1200,
  van: 900,
  bench: 800,
  person: 2500,
  traffic_light: 1500,
  bus: 300,
  fountain: 100,
};
/** Real-traffic colour mix (white/silver/black/grey dominate), palette keys with weights. */
const CAR_COLORS: [string, number][] = [
  ['car_white', 24], ['car_silver', 18], ['car_black', 15], ['car_grey', 10], ['car_red', 8], ['car_blue', 8],
  ['car_navy', 5], ['car_green', 4], ['car_tan', 4], ['car_orange', 3],
];
const TRAFFIC_OWNER = '\u0000traffic'; // owner tag for moving vehicles (never removed with a tile)

function pickWeighted<T>(items: [T, number][], r: number): T {
  const total = items.reduce((a, b) => a + b[1], 0);
  let x = r * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1][0];
}
/** A pedestrian ping-ponging along a sidewalk path (cars and buses live in the traffic worker). */
interface Walker {
  kind: PropKind;
  path: THREE.Vector3[];
  t: number;
  speed: number;
  idx: number;
  len: number[];
  tileId: string;
  dir: 1 | -1;
}

const WALKER_SPACING_M = 60; // roughly one walker per this many metres of path
const WALKER_CAP_PER_PATH = 4;
const WALKER_MIN_SPEED = 0.9;
const WALKER_MAX_SPEED = 1.5;

/** One InstancedMesh per prop kind; tiles append instances as they load. Walkers are animated here; moving vehicles
 * are driven by the traffic worker and drawn through applyPoses(). */
export class PropPool implements PoseSink {
  readonly group = new THREE.Group();
  private meshes = new Map<PropKind, THREE.InstancedMesh>();
  private counts = new Map<PropKind, number>();
  private walkers: Walker[] = [];
  /** traffic slot -> prop kind index (-1 empty) and instance index */
  private slotKind = new Int8Array(MAX_VEHICLES).fill(-1);
  private slotInst = new Int32Array(MAX_VEHICLES).fill(-1);
  private trafficFree = new Map<PropKind, number[]>();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  /** tile id per instance, per kind, parallel to the instance index */
  private owners = new Map<PropKind, string[]>();
  private currentTile = '';
  private tmp = new THREE.Object3D();
  paused = false;

  constructor(material: THREE.Material) {
    for (const k of PROP_KINDS) {
      const geom = VEHICLE_KINDS.includes(k) ? buildPropGeometry(k, undefined, true) : buildPropGeometry(k);
      const im = new THREE.InstancedMesh(geom, material, CAPACITY[k]);
      im.count = 0;
      im.frustumCulled = false;
      im.name = `props:${k}`;
      this.meshes.set(k, im);
      this.counts.set(k, 0);
      this.owners.set(k, []);
      this.group.add(im);
    }
  }

  /** Tag everything added until the next call with this tile id (for removeTile). */
  beginTile(tileId: string) { this.currentTile = tileId; }

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
      this.owners.get(p.kind)![i] = this.currentTile;
      im.count = i + 1;
      im.instanceMatrix.needsUpdate = true;
      if (VEHICLE_KINDS.includes(p.kind)) {
        // parked vehicles get a body colour too (deterministic from the instance index)
        im.setColorAt(i, hex(pickWeighted(CAR_COLORS, ((i * 7919) % 1000) / 1000) as never));
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
  }

  /**
   * Spawn pedestrians walking along sidewalk/footway centrelines. They ping-pong between the
   * path ends (not loop), tagged with the current tile like cars/buses so removeTile compacts
   * them. Spawn count per path is proportional to length (~1 per 60 m, capped at 4); shares the
   * 'person' instance capacity with static scatter people and stops spawning once it's full.
   */
  addWalkers(paths: THREE.Vector3[][], rand: () => number) {
    const im = this.meshes.get('person')!;
    for (const path of paths) {
      if (path.length < 2) continue;
      const len: number[] = [0];
      for (let i = 1; i < path.length; i++) len.push(len[i - 1] + path[i].distanceTo(path[i - 1]));
      const total = len[len.length - 1];
      if (total < 10) continue;
      const expected = Math.min(WALKER_CAP_PER_PATH, total / WALKER_SPACING_M);
      let n = Math.floor(expected);
      if (rand() < expected - n) n++;
      n = Math.min(WALKER_CAP_PER_PATH, n);
      for (let k = 0; k < n; k++) {
        const idx = this.counts.get('person')!;
        if (idx >= CAPACITY.person) return; // capacity hit: stop spawning entirely
        this.counts.set('person', idx + 1);
        this.owners.get('person')![idx] = this.currentTile;
        im.count = idx + 1;
        const speed = WALKER_MIN_SPEED + rand() * (WALKER_MAX_SPEED - WALKER_MIN_SPEED);
        const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
        this.walkers.push({ kind: 'person', path, t: rand() * total, speed, idx, len, tileId: this.currentTile, dir });
      }
    }
  }

  /** Drop every instance (and vehicle) that belongs to a tile, compacting the instanced buffers. */
  removeTile(tileId: string) {
    for (const k of PROP_KINDS) {
      const owners = this.owners.get(k)!;
      const im = this.meshes.get(k)!;
      const n = this.counts.get(k)!;
      if (!owners.slice(0, n).includes(tileId)) continue;
      const remap = new Map<number, number>();
      let w = 0;
      const m = new THREE.Matrix4(), c = new THREE.Color();
      for (let r = 0; r < n; r++) {
        if (owners[r] === tileId) continue;
        if (w !== r) {
          im.getMatrixAt(r, m); im.setMatrixAt(w, m);
          if (im.instanceColor) { im.getColorAt(r, c); im.setColorAt(w, c); }
          owners[w] = owners[r];
        }
        remap.set(r, w);
        w++;
      }
      owners.length = w;
      this.counts.set(k, w);
      im.count = w;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      if (k === 'person') {
        this.walkers = this.walkers.filter((v) => v.tileId !== tileId);
        for (const v of this.walkers) v.idx = remap.get(v.idx) ?? v.idx;
      }
      // moving vehicles share the instanced buffers with parked ones: follow the compaction
      const ki = VEHICLE_KIND_NAMES.indexOf(k as never);
      if (ki >= 0) {
        for (let slot = 0; slot < MAX_VEHICLES; slot++) if (this.slotKind[slot] === ki) this.slotInst[slot] = remap.get(this.slotInst[slot]) ?? this.slotInst[slot];
        const free = this.trafficFree.get(k);
        if (free) this.trafficFree.set(k, free.map((i) => remap.get(i) ?? i).filter((i) => i < w));
      }
    }
  }

  counts_(): Record<string, number> { const o: Record<string, number> = {}; for (const [k, v] of this.counts) o[k] = v; return o; }

  update(dt: number) {
    if (this.paused || !this.walkers.length) return;
    const im = this.meshes.get('person')!;
    for (const c of this.walkers) {
      const total = c.len[c.len.length - 1];
      let t = c.t + c.speed * dt * c.dir;
      let dir = c.dir;
      if (t >= total) { t = total - (t - total); dir = -1; }
      else if (t <= 0) { t = -t; dir = 1; }
      c.t = THREE.MathUtils.clamp(t, 0, total);
      c.dir = dir;
      let i = 1;
      while (i < c.len.length - 1 && c.len[i] < c.t) i++;
      const a = c.path[i - 1], b = c.path[i];
      const seg = c.len[i] - c.len[i - 1];
      const f = seg > 0 ? (c.t - c.len[i - 1]) / seg : 0;
      this.tmp.position.lerpVectors(a, b, f);
      const hx = c.dir === -1 ? a.x - b.x : b.x - a.x;
      const hz = c.dir === -1 ? a.z - b.z : b.z - a.z;
      this.tmp.rotation.set(0, Math.atan2(-hz, hx), 0); // body length is +X
      this.tmp.scale.setScalar(1);
      this.tmp.updateMatrix();
      im.setMatrixAt(c.idx, this.tmp.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  /** Number of moving vehicles currently drawn. */
  trafficCount(): number { let n = 0; for (let i = 0; i < MAX_VEHICLES; i++) if (this.slotKind[i] >= 0) n++; return n; }

  /**
   * Draw the traffic worker's pose buffers. Slots are stable across frames; a slot that changes kind or empties
   * releases its instance (hidden with a zero-scale matrix, recycled for the next vehicle of that kind).
   */
  applyPoses(prev: Float32Array | null, cur: Float32Array, alpha: number) {
    if (this.paused) return;
    const touched = new Set<THREE.InstancedMesh>();
    const a = Math.min(1.25, Math.max(0, alpha));
    for (let slot = 0; slot < MAX_VEHICLES; slot++) {
      const o = slot * POSE_STRIDE;
      const ki = cur[o + 4];
      const had = this.slotKind[slot];
      if (ki < 0) {
        if (had >= 0) this.releaseSlot(slot, touched);
        continue;
      }
      const kind = VEHICLE_KIND_NAMES[ki] as PropKind;
      const im = this.meshes.get(kind)!;
      if (had !== ki) {
        if (had >= 0) this.releaseSlot(slot, touched);
        const free = this.trafficFree.get(kind) ?? [];
        let idx = free.pop();
        if (idx === undefined) {
          idx = this.counts.get(kind)!;
          if (idx >= CAPACITY[kind]) continue;
          this.counts.set(kind, idx + 1);
          im.count = idx + 1;
        }
        this.trafficFree.set(kind, free);
        this.owners.get(kind)![idx] = TRAFFIC_OWNER;
        this.slotKind[slot] = ki;
        this.slotInst[slot] = idx;
        if (VEHICLE_KINDS.includes(kind)) {
          // white-bodied car kinds take a body colour; buses (and anything pre-coloured) keep their vertex colours
          im.setColorAt(idx, hex(VEHICLE_COLORS[Math.max(0, Math.min(VEHICLE_COLORS.length - 1, cur[o + 5] | 0))] as never));
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
      }
      let x = cur[o], y = cur[o + 1], z = cur[o + 2], h = cur[o + 3];
      if (prev && prev[o + 4] === ki && had === ki) {
        const px = prev[o], py = prev[o + 1], pz = prev[o + 2], ph = prev[o + 3];
        // skip interpolation across a respawn (large jump)
        if ((x - px) * (x - px) + (z - pz) * (z - pz) < 400) {
          x = px + (x - px) * a; y = py + (y - py) * a; z = pz + (z - pz) * a;
          let dh = h - ph; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
          h = ph + dh * a;
        }
      }
      this.tmp.position.set(x, y, z);
      this.tmp.rotation.set(0, h, 0);
      this.tmp.scale.setScalar(1);
      this.tmp.updateMatrix();
      im.setMatrixAt(this.slotInst[slot], this.tmp.matrix);
      touched.add(im);
    }
    for (const im of touched) im.instanceMatrix.needsUpdate = true;
  }

  private releaseSlot(slot: number, touched: Set<THREE.InstancedMesh>) {
    const kind = VEHICLE_KIND_NAMES[this.slotKind[slot]] as PropKind;
    const im = this.meshes.get(kind)!;
    im.setMatrixAt(this.slotInst[slot], this.hidden);
    touched.add(im);
    const free = this.trafficFree.get(kind) ?? [];
    free.push(this.slotInst[slot]);
    this.trafficFree.set(kind, free);
    this.slotKind[slot] = -1;
    this.slotInst[slot] = -1;
  }
}
