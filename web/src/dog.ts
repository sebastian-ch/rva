import * as THREE from 'three';
import { hex, mergeColored } from './props';
import type { LoadedTile } from './tiles';
import type { V2 } from './geomutil';

/**
 * A fluffy ginger Aussie that runs laps of the lawns in the Robins Sculpture Garden behind the Virginia Museum of
 * Fine Arts, stopping now and then to sniff. The loop (EPSG:32618) stays inside the garden (osm:way/236129239),
 * is ~80% on its lawns, crossing the garden paths between them, and keeps 7 m clear of every building. Height is
 * the top of the tile's ground meshes (terrain, land drapes, paths) under the dog, raycast a few times a second,
 * so it stands on the surface rather than inside it; it hides while its tile is not resident.
 */
const LAWN_LOOP: V2[] = [
  [281279, 4159440], [281294, 4159460], [281309, 4159480], [281319, 4159495], [281311, 4159510], [281324, 4159535],
  [281334, 4159560], [281344, 4159585], [281369, 4159565], [281384, 4159550], [281359, 4159540], [281339, 4159520],
  [281324, 4159490], [281311, 4159455], [281299, 4159425],
];

const SCALE = 2.4;        // well over life size: a real-sized dog is a few pixels at the viewer's closest zoom
const RUN_SPEED = 5.5;    // m/s, an easy lope
const STRIDE = 1.2;       // m of ground per gallop cycle (before SCALE)
const LEG_TOP = 0.4;      // hip/shoulder height above the paws
const GROUND_LIFT = 0.03; // over the surface hit
const PROBE_EVERY = 0.15; // s between ground raycasts
const GROUND_MESHES = new Set(['terrain', 'land', 'roads']);

function box(sx: number, sy: number, sz: number, rotX = 0, rotZ = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  return g;
}

export class Dog {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly tail = new THREE.Group();
  private readonly legs: { pivot: THREE.Group; phase: number }[] = [];
  private readonly loop: { x: number; y: number; lx: number; lz: number; s: number }[] = [];
  private readonly length: number;
  private s = 0;
  private gait = 0;           // stride phase (rad)
  private run = 1;            // 1 running, 0 stopped; eased
  private yaw = 0;
  private time = 0;
  private nextStop = 25;
  private stopLeft = 0;
  private probeIn = 0;
  private groundY: number | null = null;
  private groundTarget = 0;
  private readonly ray = new THREE.Raycaster();

  constructor(material: THREE.Material, toLocal: (x: number, y: number) => V2) {
    const coat = hex('dog_coat'), ear = hex('dog_ear'), cream = hex('dog_cream'), collar = hex('dog_collar'), nose = hex('roof_dark');
    const mesh = (g: THREE.BufferGeometry) => { const m = new THREE.Mesh(g, material); m.castShadow = true; m.receiveShadow = true; return m; };

    // Body: modelled along +X like every prop. The long coat makes a deep chest ruff and a round rump.
    this.body.add(mesh(mergeColored([
      { geom: box(0.7, 0.34, 0.34), color: coat, position: [0, 0.52, 0] },
      { geom: box(0.3, 0.38, 0.4), color: coat, position: [-0.25, 0.53, 0] },   // fluffy hindquarters
      { geom: box(0.22, 0.34, 0.38), color: coat, position: [0.28, 0.5, 0] },   // chest ruff
      { geom: box(0.08, 0.2, 0.2), color: cream, position: [0.38, 0.42, 0] },   // cream bib
      { geom: box(0.4, 0.08, 0.3), color: cream, position: [0.02, 0.33, 0] },   // belly fringe
      { geom: box(0.07, 0.24, 0.41), color: collar, position: [0.33, 0.63, 0] }, // collar, proud of the ruff
    ])));
    this.head.position.set(0.42, 0.72, 0);
    this.head.add(mesh(mergeColored([
      { geom: box(0.26, 0.24, 0.26), color: coat, position: [0, 0, 0] },
      { geom: box(0.14, 0.26, 0.34), color: coat, position: [-0.08, -0.05, 0] }, // cheek ruff
      { geom: box(0.16, 0.11, 0.13), color: cream, position: [0.18, -0.05, 0] }, // muzzle
      { geom: box(0.22, 0.03, 0.06), color: cream, position: [0.06, 0.12, 0] },  // white blaze
      { geom: box(0.04, 0.05, 0.06), color: nose, position: [0.27, -0.02, 0] },
      { geom: box(0.07, 0.14, 0.1, -0.5), color: ear, position: [0, 0.07, 0.14] },  // drop ears
      { geom: box(0.07, 0.14, 0.1, 0.5), color: ear, position: [0, 0.07, -0.14] },
    ])));
    this.body.add(this.head);
    this.tail.position.set(-0.4, 0.6, 0);
    this.tail.add(mesh(mergeColored([{ geom: box(0.14, 0.14, 0.16, 0, 0.5), color: coat, position: [-0.05, 0.02, 0] }]))); // bobtail
    this.body.add(this.tail);
    this.group.add(this.body);

    // Legs pivot at the hip/shoulder and swing about Z; a rotary gallop staggers each pair a little.
    for (const [x, z, phase, hind] of [[0.26, 0.1, 0, false], [0.26, -0.1, 0.35, false], [-0.26, 0.11, Math.PI, true], [-0.26, -0.11, Math.PI + 0.35, true]] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(x, LEG_TOP, z);
      pivot.add(mesh(mergeColored([
        { geom: box(hind ? 0.15 : 0.11, 0.3, 0.11), color: coat, position: [0, -0.15, 0] },
        { geom: box(0.14, 0.08, 0.12), color: cream, position: [0.02, -0.36, 0] }, // white paws
      ])));
      this.body.add(pivot);
      this.legs.push({ pivot, phase });
    }
    this.group.scale.setScalar(SCALE);

    let s = 0;
    for (let i = 0; i < LAWN_LOOP.length; i++) {
      const [x, y] = LAWN_LOOP[i];
      if (i) s += Math.hypot(x - LAWN_LOOP[i - 1][0], y - LAWN_LOOP[i - 1][1]);
      const [lx, lz] = toLocal(x, y);
      this.loop.push({ x, y, lx, lz, s });
    }
    const [x0, y0] = LAWN_LOOP[0], [xn, yn] = LAWN_LOOP[LAWN_LOOP.length - 1];
    this.length = s + Math.hypot(x0 - xn, y0 - yn);
    this.group.visible = false;
  }

  update(dt: number, tiles: readonly LoadedTile[]) {
    this.time += dt;
    // Every so often stop for a sniff and a wag, then set off again.
    if (this.stopLeft > 0) {
      this.stopLeft -= dt;
    } else if (this.time >= this.nextStop) {
      this.stopLeft = 2 + Math.random() * 2.5;
      this.nextStop = this.time + this.stopLeft + 15 + Math.random() * 30;
    }
    const target = this.stopLeft > 0 ? 0 : 1;
    this.run += (target - this.run) * Math.min(1, dt * 4);
    const speed = RUN_SPEED * this.run;
    this.s = (this.s + speed * dt) % this.length;
    this.gait += (speed * dt) / (STRIDE * SCALE) * Math.PI * 2;

    // position along the loop, projected for the terrain lookup and local for the scene
    const n = this.loop.length;
    let i = 0;
    while (i < n - 1 && this.loop[i + 1].s <= this.s) i++;
    const a = this.loop[i], b = this.loop[(i + 1) % n];
    const segEnd = i + 1 < n ? b.s : this.length;
    const f = (this.s - a.s) / Math.max(1e-6, segEnd - a.s);
    const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
    const tile = tiles.find((t) => x >= t.meta.bbox[0] && x < t.meta.bbox[2] && y >= t.meta.bbox[1] && y < t.meta.bbox[3]);
    this.group.visible = !!tile;
    if (!tile) return;
    const lx = a.lx + (b.lx - a.lx) * f, lz = a.lz + (b.lz - a.lz) * f;
    const terrain = tile.field.at(x, y);
    this.probeIn -= dt;
    if (this.probeIn <= 0 || this.groundY === null) {
      this.probeIn = PROBE_EVERY;
      const targets = tile.group.children.filter((o) => GROUND_MESHES.has(o.name));
      this.ray.set(new THREE.Vector3(lx, terrain + 20, lz), new THREE.Vector3(0, -1, 0));
      this.ray.far = 30;
      const hit = this.ray.intersectObjects(targets, false)[0];
      const surface = hit ? hit.point.y : terrain + 0.1;
      // ease small changes; snap if the surface jumps (kerb, plaza deck) so paws never sink
      this.groundY = this.groundY === null || Math.abs(surface - this.groundY) > 0.5 ? surface : this.groundY;
      this.groundTarget = surface;
    }
    this.groundY! += (this.groundTarget - this.groundY!) * Math.min(1, dt * 10);
    const bob = Math.abs(Math.sin(this.gait)) * 0.06 * this.run;
    this.group.position.set(lx, this.groundY! + GROUND_LIFT + bob * SCALE, lz);

    // heading = atan2(-dz, dx) for a +X model; ease round the corners instead of snapping
    const want = Math.atan2(-(b.lz - a.lz), b.lx - a.lx);
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 8);
    this.group.rotation.y = this.yaw;

    const swing = 0.75 * this.run;
    for (const leg of this.legs) leg.pivot.rotation.z = Math.sin(this.gait + leg.phase) * swing;
    this.body.rotation.z = Math.sin(this.gait * 2) * 0.05 * this.run;
    const still = 1 - this.run;
    this.head.rotation.z = -0.45 * still + Math.sin(this.gait * 2 + 1) * 0.06 * this.run; // nose down to sniff
    this.head.rotation.y = Math.sin(this.time * 1.7) * 0.5 * still;
    this.tail.rotation.y = Math.sin(this.time * (still > 0.5 ? 16 : 8)) * (0.25 + 0.45 * still);
  }
}
