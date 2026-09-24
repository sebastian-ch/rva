import * as THREE from 'three';
import { hex, mergeColored } from './props';
import type { LoadedTile } from './tiles';
import type { V2 } from './geomutil';

/**
 * Dogs running laps of hand-picked loops (EPSG:32618), stopping now and then to sniff. Height is the top of the
 * tile's ground meshes (terrain, land drapes, paths) under the dog, raycast a few times a second, so it stands on
 * the surface rather than inside it; a dog hides while its tile is not resident. Each breed brings its own model,
 * loop and gait.
 */
export interface Breed {
  name: string;
  loop: V2[];
  runSpeed: number;  // m/s
  stride: number;    // m of ground per gait cycle (before SCALE)
  legSwing: number;  // rad at full run
  bob: number;       // body bounce per step (before SCALE)
  firstStop: number; // s until the first sniff
  build(rig: Rig, mesh: (g: THREE.BufferGeometry) => THREE.Mesh): void;
}

/** The animated parts a breed fills in. Legs swing about Z; ears flap about X; the tail wags about `wagAxis`. */
export interface Rig {
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  wagAxis: 'x' | 'y';
  legs: { pivot: THREE.Group; phase: number }[];
  ears: { pivot: THREE.Group; side: 1 | -1 }[];
}

const SCALE = 2.4;        // well over life size: a real-sized dog is a few pixels at the viewer's closest zoom
const GROUND_LIFT = 0.03; // over the surface hit
const PROBE_EVERY = 0.15; // s between ground raycasts
const GROUND_MESHES = new Set(['terrain', 'land', 'roads']);

function box(sx: number, sy: number, sz: number, rotX = 0, rotZ = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  return g;
}

/**
 * A fluffy ginger Aussie that runs laps of the lawns in the Robins Sculpture Garden behind the Virginia Museum of
 * Fine Arts. The loop stays inside the garden (osm:way/236129239), is ~80% on its lawns, crossing the garden paths
 * between them, and keeps 7 m clear of every building. The return leg stays well north-west of the museum's
 * gallery wing so the default camera (south-east, 35°) sees over it everywhere: the worst point needs ~17°.
 */
export const AUSSIE: Breed = {
  name: 'VMFA sculpture garden',
  loop: [
    [281279, 4159440], [281294, 4159460], [281307, 4159480], [281315, 4159495], [281311, 4159510], [281324, 4159535],
    [281334, 4159560], [281344, 4159585], [281369, 4159570], [281384, 4159555], [281364, 4159556], [281344, 4159546],
    [281330, 4159522], [281320, 4159492], [281306, 4159458], [281295, 4159428],
  ],
  runSpeed: 5.5, // an easy lope
  stride: 1.2,
  legSwing: 0.75,
  bob: 0.06,
  firstStop: 25,
  build(rig, mesh) {
    const LEG_TOP = 0.4; // hip/shoulder height above the paws
    const coat = hex('dog_coat'), ear = hex('dog_ear'), cream = hex('dog_cream'), collar = hex('dog_collar'), nose = hex('roof_dark');
    // Body: modelled along +X like every prop. The long coat makes a deep chest ruff and a round rump.
    rig.body.add(mesh(mergeColored([
      { geom: box(0.7, 0.34, 0.34), color: coat, position: [0, 0.52, 0] },
      { geom: box(0.3, 0.38, 0.4), color: coat, position: [-0.25, 0.53, 0] },   // fluffy hindquarters
      { geom: box(0.22, 0.34, 0.38), color: coat, position: [0.28, 0.5, 0] },   // chest ruff
      { geom: box(0.08, 0.2, 0.2), color: cream, position: [0.38, 0.42, 0] },   // cream bib
      { geom: box(0.4, 0.08, 0.3), color: cream, position: [0.02, 0.33, 0] },   // belly fringe
      { geom: box(0.07, 0.24, 0.41), color: collar, position: [0.33, 0.63, 0] }, // collar, proud of the ruff
    ])));
    rig.head.position.set(0.42, 0.72, 0);
    rig.head.add(mesh(mergeColored([
      { geom: box(0.26, 0.24, 0.26), color: coat, position: [0, 0, 0] },
      { geom: box(0.14, 0.26, 0.34), color: coat, position: [-0.08, -0.05, 0] }, // cheek ruff
      { geom: box(0.16, 0.11, 0.13), color: cream, position: [0.18, -0.05, 0] }, // muzzle
      { geom: box(0.22, 0.03, 0.06), color: cream, position: [0.06, 0.12, 0] },  // white blaze
      { geom: box(0.04, 0.05, 0.06), color: nose, position: [0.27, -0.02, 0] },
      { geom: box(0.07, 0.14, 0.1, -0.5), color: ear, position: [0, 0.07, 0.14] },  // drop ears
      { geom: box(0.07, 0.14, 0.1, 0.5), color: ear, position: [0, 0.07, -0.14] },
    ])));
    rig.tail.position.set(-0.4, 0.6, 0);
    rig.tail.add(mesh(mergeColored([{ geom: box(0.14, 0.14, 0.16, 0, 0.5), color: coat, position: [-0.05, 0.02, 0] }]))); // bobtail

    // A rotary gallop staggers each pair a little.
    for (const [x, z, phase, hind] of [[0.26, 0.1, 0, false], [0.26, -0.1, 0.35, false], [-0.26, 0.11, Math.PI, true], [-0.26, -0.11, Math.PI + 0.35, true]] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(x, LEG_TOP, z);
      pivot.add(mesh(mergeColored([
        { geom: box(hind ? 0.15 : 0.11, 0.3, 0.11), color: coat, position: [0, -0.15, 0] },
        { geom: box(0.14, 0.08, 0.12), color: cream, position: [0.02, -0.36, 0] }, // white paws
      ])));
      rig.legs.push({ pivot, phase });
    }
  },
};

/**
 * A black-and-white basset hound doing laps of the Carytown 7-Eleven (3301 W Cary St, osm:way/236014923). The
 * store shares its west wall with the rest of the row, so the loop is a narrow ring round its three open sides: out
 * along the Cary Street sidewalk, down the car park and across the back 2–3 m off the walls, home on a lane 3–4 m
 * further out, turning at the west end of the facade and behind the back corner. It keeps ≥ 1.8 m from every
 * building and ≥ 1 m from the Cary Street carriageway.
 */
export const BASSET: Breed = {
  name: 'Carytown 7-Eleven',
  loop: [
    [280647, 4159229], [280661, 4159223], [280662, 4159221], [280650, 4159195], [280648, 4159194], [280634, 4159201],
    [280632, 4159200], [280633, 4159198], [280648, 4159190], [280652, 4159192], [280665, 4159220], [280663.5, 4159223.5],
    [280647.5, 4159230.5], [280645.5, 4159230],
  ],
  runSpeed: 3.2,  // a determined short-legged trot
  stride: 0.55,
  legSwing: 0.6,
  bob: 0.025,
  firstStop: 12, // bassets sniff a lot
  build(rig, mesh) {
    const LEG_TOP = 0.22;
    const black = hex('basset_black'), white = hex('basset_white'), nose = hex('roof_dark');
    // Long low barrel: black saddle, white shoulders, belly and hip patch, from the reference photo.
    rig.body.add(mesh(mergeColored([
      { geom: box(0.8, 0.24, 0.28), color: black, position: [0, 0.33, 0] },
      { geom: box(0.2, 0.27, 0.3), color: white, position: [0.32, 0.33, 0] },     // white shoulders
      { geom: box(0.14, 0.11, 0.24), color: white, position: [0.38, 0.2, 0] },    // deep keel
      { geom: box(0.6, 0.05, 0.24), color: white, position: [0, 0.2, 0] },        // belly
      { geom: box(0.13, 0.1, 0.29), color: white, position: [-0.24, 0.41, 0] },   // patch over the hips
      { geom: box(0.15, 0.2, 0.18, 0, -0.5), color: white, position: [0.44, 0.44, 0] }, // neck
    ])));
    rig.head.position.set(0.52, 0.52, 0);
    rig.head.add(mesh(mergeColored([
      { geom: box(0.2, 0.16, 0.18), color: black, position: [0, 0, 0] },
      { geom: box(0.18, 0.11, 0.12), color: white, position: [0.16, -0.04, 0] },  // speckled muzzle
      { geom: box(0.03, 0.03, 0.125), color: black, position: [0.12, -0.02, 0] }, // freckles
      { geom: box(0.03, 0.03, 0.125), color: black, position: [0.19, -0.06, 0] },
      { geom: box(0.18, 0.02, 0.04), color: white, position: [0.04, 0.085, 0] },  // white blaze
      { geom: box(0.05, 0.06, 0.08), color: nose, position: [0.26, -0.01, 0] },
      { geom: box(0.08, 0.05, 0.1), color: black, position: [0.14, -0.1, 0] },    // jowls
    ])));
    // Long ears hang from the top of the skull and swing out with each step.
    for (const side of [1, -1] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(-0.01, 0.05, 0.095 * side);
      pivot.add(mesh(mergeColored([{ geom: box(0.11, 0.28, 0.03), color: black, position: [0, -0.13, 0.01 * side] }])));
      rig.head.add(pivot);
      rig.ears.push({ pivot, side });
    }
    // Tail carried high like a flag, white-tipped; it sways side to side.
    rig.tail.position.set(-0.39, 0.4, 0);
    const tail = box(0.05, 0.3, 0.05); tail.translate(0, 0.15, 0); tail.rotateZ(0.35);
    const tip = box(0.056, 0.07, 0.056); tip.translate(0, 0.28, 0); tip.rotateZ(0.35);
    rig.tail.add(mesh(mergeColored([{ geom: tail, color: black }, { geom: tip, color: white }])));
    rig.wagAxis = 'x';

    // Short legs, trotting in diagonal pairs. White forelegs; black thighs over white hocks; big white paws.
    for (const [x, z, phase, hind] of [[0.28, 0.1, 0, false], [0.28, -0.1, Math.PI, false], [-0.28, 0.1, Math.PI, true], [-0.28, -0.1, 0, true]] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(x, LEG_TOP, z);
      pivot.add(mesh(mergeColored(hind ? [
        { geom: box(0.14, 0.12, 0.1), color: black, position: [0, -0.04, 0] },
        { geom: box(0.07, 0.1, 0.07), color: white, position: [0, -0.14, 0] },
        { geom: box(0.11, 0.05, 0.1), color: white, position: [0.02, -0.195, 0] },
      ] : [
        { geom: box(0.08, 0.17, 0.08), color: white, position: [0, -0.085, 0] },
        { geom: box(0.12, 0.05, 0.11), color: white, position: [0.02, -0.195, 0] },
        { geom: box(0.03, 0.03, 0.085), color: black, position: [0, -0.1, 0] },   // spots
      ])));
      rig.legs.push({ pivot, phase });
    }
  },
};

export class Dog {
  readonly group = new THREE.Group();
  readonly name: string;
  private readonly rig: Rig = {
    body: new THREE.Group(), head: new THREE.Group(), tail: new THREE.Group(), wagAxis: 'y', legs: [], ears: [],
  };
  private readonly loop: { x: number; y: number; lx: number; lz: number; s: number }[] = [];
  private readonly length: number;
  private s = 0;
  private gait = 0;           // stride phase (rad)
  private run = 1;            // 1 running, 0 stopped; eased
  private yaw = 0;
  private time = 0;
  private nextStop: number;
  private stopLeft = 0;
  private probeIn = 0;
  private groundY: number | null = null;
  private groundTarget = 0;
  private readonly ray = new THREE.Raycaster();

  constructor(private readonly breed: Breed, material: THREE.Material, toLocal: (x: number, y: number) => V2) {
    this.name = breed.name;
    this.nextStop = breed.firstStop;
    const mesh = (g: THREE.BufferGeometry) => { const m = new THREE.Mesh(g, material); m.castShadow = true; m.receiveShadow = true; return m; };
    const rig = this.rig;
    breed.build(rig, mesh);
    rig.body.add(rig.head, rig.tail, ...rig.legs.map((l) => l.pivot));
    this.group.add(rig.body);
    this.group.scale.setScalar(SCALE);

    let s = 0;
    const pts = breed.loop;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (i) s += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
      const [lx, lz] = toLocal(x, y);
      this.loop.push({ x, y, lx, lz, s });
    }
    const [x0, y0] = pts[0], [xn, yn] = pts[pts.length - 1];
    this.length = s + Math.hypot(x0 - xn, y0 - yn);
    this.group.visible = false;
  }

  /**
   * Where the camera should look: the dog itself once its tile is resident, else its place on the loop at y = 0, the
   * plane tile streaming measures the camera footprint on, so looking there always loads the dog's tile.
   */
  lookTarget(): THREE.Vector3 {
    if (this.group.visible) return this.group.position.clone();
    const { lx, lz } = this.where();
    return new THREE.Vector3(lx, this.groundY ?? 0, lz);
  }

  /** Position along the loop, projected for the terrain lookup and local for the scene. */
  private where() {
    const n = this.loop.length;
    let i = 0;
    while (i < n - 1 && this.loop[i + 1].s <= this.s) i++;
    const a = this.loop[i], b = this.loop[(i + 1) % n];
    const segEnd = i + 1 < n ? b.s : this.length;
    const f = (this.s - a.s) / Math.max(1e-6, segEnd - a.s);
    return { a, b, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, lx: a.lx + (b.lx - a.lx) * f, lz: a.lz + (b.lz - a.lz) * f };
  }

  update(dt: number, tiles: readonly LoadedTile[]) {
    const { breed, rig } = this;
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
    const speed = breed.runSpeed * this.run;
    this.s = (this.s + speed * dt) % this.length;
    this.gait += (speed * dt) / (breed.stride * SCALE) * Math.PI * 2;

    const { x, y, lx, lz, a, b } = this.where();
    const tile = tiles.find((t) => x >= t.meta.bbox[0] && x < t.meta.bbox[2] && y >= t.meta.bbox[1] && y < t.meta.bbox[3]);
    this.group.visible = !!tile;
    if (!tile) return;
    const terrain = tile.field.at(x, y);
    this.probeIn -= dt;
    if (this.probeIn <= 0 || this.groundY === null) {
      this.probeIn = PROBE_EVERY;
      const targets = tile.group.children.filter((o) => GROUND_MESHES.has(o.name));
      this.ray.set(new THREE.Vector3(lx, terrain + 20, lz), new THREE.Vector3(0, -1, 0));
      this.ray.far = 30;
      const hit = this.ray.intersectObjects(targets, false)[0];
      const surface = hit && Number.isFinite(hit.point.y) ? hit.point.y : terrain + 0.1;
      // ease small changes; snap if the surface jumps (kerb, plaza deck) so paws never sink
      this.groundY = this.groundY === null || Math.abs(surface - this.groundY) > 0.5 ? surface : this.groundY;
      this.groundTarget = surface;
    }
    this.groundY! += (this.groundTarget - this.groundY!) * Math.min(1, dt * 10);
    const bob = Math.abs(Math.sin(this.gait)) * breed.bob * this.run;
    this.group.position.set(lx, this.groundY! + GROUND_LIFT + bob * SCALE, lz);

    // heading = atan2(-dz, dx) for a +X model; ease round the corners instead of snapping
    const want = Math.atan2(-(b.lz - a.lz), b.lx - a.lx);
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 8);
    this.group.rotation.y = this.yaw;

    const swing = breed.legSwing * this.run;
    for (const leg of rig.legs) leg.pivot.rotation.z = Math.sin(this.gait + leg.phase) * swing;
    rig.body.rotation.z = Math.sin(this.gait * 2) * 0.05 * this.run;
    const still = 1 - this.run;
    rig.head.rotation.z = -0.45 * still + Math.sin(this.gait * 2 + 1) * 0.06 * this.run; // nose down to sniff
    rig.head.rotation.y = Math.sin(this.time * 1.7) * 0.5 * still;
    for (const ear of rig.ears) ear.pivot.rotation.x = -ear.side * (0.15 + 0.35 * Math.abs(Math.sin(this.gait)) * this.run);
    const wag = Math.sin(this.time * (still > 0.5 ? 16 : 8)) * (0.25 + 0.45 * still);
    if (rig.wagAxis === 'x') rig.tail.rotation.x = wag; else rig.tail.rotation.y = wag;
  }
}
