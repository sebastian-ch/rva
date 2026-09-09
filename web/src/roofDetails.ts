import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, centroid, hashStr, minAreaOBB, pointInRing, ringBounds, rng, signedArea, type V2 } from './geomutil';
import type { BuildingProps } from './types';

/** Emit a closed box (6 faces, outward normals) centered at (cx, cz) with base at cy0, rotated rotY about Y. */
export function addBox(
  mb: MeshBuilder,
  cx: number,
  cy0: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  rotY: number,
  color: THREE.Color,
): void {
  const hx = sx / 2, hz = sz / 2;
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const corner = (lx: number, lz: number, y: number) => {
    const x = cx + lx * cos - lz * sin;
    const z = cz + lx * sin + lz * cos;
    return new THREE.Vector3(x, y, z);
  };
  // 8 local corners
  const b00 = corner(-hx, -hz, cy0), b10 = corner(hx, -hz, cy0), b11 = corner(hx, hz, cy0), b01 = corner(-hx, hz, cy0);
  const t00 = corner(-hx, -hz, cy0 + sy), t10 = corner(hx, -hz, cy0 + sy), t11 = corner(hx, hz, cy0 + sy), t01 = corner(-hx, hz, cy0 + sy);

  const face = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col: THREE.Color) => {
    const centerPt = new THREE.Vector3(cx, cy0 + sy / 2, cz);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const mid = new THREE.Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25);
    const out = new THREE.Vector3().subVectors(mid, centerPt);
    if (n.dot(out) < 0) {
      mb.tri(a, c, b, col);
      mb.tri(a, d, c, col);
    } else {
      mb.tri(a, b, c, col);
      mb.tri(a, c, d, col);
    }
  };

  const top = color.clone().multiplyScalar(1.05);
  // top / bottom
  face(t00, t10, t11, t01, top);
  face(b00, b10, b11, b01, color);
  // sides
  face(b00, b10, t10, t00, color);
  face(b10, b11, t11, t10, color);
  face(b11, b01, t01, t11, color);
  face(b01, b00, t00, t01, color);
}

function ringArea(outer: V2[]): number {
  return Math.abs(signedArea(outer));
}

function distToSeg(p: V2, a: V2, b: V2): number {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * abx, qz = a[1] + t * abz;
  return Math.hypot(p[0] - qx, p[1] - qz);
}

function minDistToRing(p: V2, ring: V2[]): number {
  let d = Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % n]));
  }
  return d;
}

function addParapet(mb: MeshBuilder, outer: V2[], top: number, wallColor: THREE.Color): void {
  const n = outer.length;
  if (n > 40) return;
  for (let i = 0; i < n; i++) {
    const a = outer[i], b = outer[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) return;
  }
  const thick = 0.35;
  const h = 0.5;
  const c = centroid(outer);
  // compute per-vertex outward edge normals and inset points
  const edgeNormal = (a: V2, b: V2): V2 => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    let nx = dz / len, nz = -dx / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    // outward = away from centroid
    if ((nx * (mx - c[0]) + nz * (mz - c[1])) < 0) { nx = -nx; nz = -nz; }
    return [nx, nz];
  };
  const inset: V2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = outer[(i - 1 + n) % n];
    const cur = outer[i];
    const next = outer[(i + 1) % n];
    const n1 = edgeNormal(prev, cur);
    const n2 = edgeNormal(cur, next);
    // inward normals are negatives of outward ones
    let ix = -(n1[0] + n2[0]), iz = -(n1[1] + n2[1]);
    const len = Math.hypot(ix, iz);
    if (len > 1e-9) { ix /= len; iz /= len; } else { ix = 0; iz = 0; }
    inset.push([cur[0] + ix * thick, cur[1] + iz * thick]);
  }

  const col = wallColor.clone().multiplyScalar(0.9);
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    mb.tri(a, b, c, col, nrm);
    mb.tri(a, c, d, col, nrm);
  };

  for (let i = 0; i < n; i++) {
    const o0 = outer[i], o1 = outer[(i + 1) % n];
    const i0 = inset[i], i1 = inset[(i + 1) % n];
    const yb = top, yt = top + h;
    // outer vertical quad (outward-facing)
    const oa = new THREE.Vector3(o0[0], yb, o0[1]);
    const ob = new THREE.Vector3(o1[0], yb, o1[1]);
    const oc = new THREE.Vector3(o1[0], yt, o1[1]);
    const od = new THREE.Vector3(o0[0], yt, o0[1]);
    const [nx, nz] = edgeNormal(o0, o1);
    const outNrm = new THREE.Vector3(nx, 0, nz);
    let cross = new THREE.Vector3().subVectors(ob, oa).cross(new THREE.Vector3().subVectors(oc, oa));
    if (cross.dot(outNrm) < 0) {
      mb.tri(oa, oc, ob, col, outNrm);
      mb.tri(oa, od, oc, col, outNrm);
    } else {
      mb.tri(oa, ob, oc, col, outNrm);
      mb.tri(oa, oc, od, col, outNrm);
    }
    // inner vertical quad (inward-facing, i.e. normal points toward centroid)
    const ia = new THREE.Vector3(i0[0], yb, i0[1]);
    const ib = new THREE.Vector3(i1[0], yb, i1[1]);
    const ic = new THREE.Vector3(i1[0], yt, i1[1]);
    const id = new THREE.Vector3(i0[0], yt, i0[1]);
    const inNrm = new THREE.Vector3(-nx, 0, -nz);
    cross = new THREE.Vector3().subVectors(ib, ia).cross(new THREE.Vector3().subVectors(ic, ia));
    if (cross.dot(inNrm) < 0) {
      mb.tri(ia, ic, ib, col, inNrm);
      mb.tri(ia, id, ic, col, inNrm);
    } else {
      mb.tri(ia, ib, ic, col, inNrm);
      mb.tri(ia, ic, id, col, inNrm);
    }
    // top cap quad between outer(top) and inner(top)
    quad(od, oc, ic, id);
  }
}

function addHvac(mb: MeshBuilder, outer: V2[], top: number, rand: () => number): void {
  const area = ringArea(outer);
  if (area <= 400) return;
  const n = 1 + Math.floor(rand() * 3);
  const [minx, minz, maxx, maxz] = ringBounds(outer);
  const steel = hex('steel');
  for (let k = 0; k < n; k++) {
    let placed: V2 | null = null;
    for (let tries = 0; tries < 20; tries++) {
      const px = minx + rand() * (maxx - minx);
      const pz = minz + rand() * (maxz - minz);
      const p: V2 = [px, pz];
      if (!pointInRing(p, outer)) continue;
      if (minDistToRing(p, outer) < 2.5) continue;
      placed = p;
      break;
    }
    if (!placed) continue;
    const sx = 2 + rand() * 2;
    const sy = 1 + rand() * 0.8;
    const sz = 1.5 + rand() * 1.5;
    const rotY = rand() * Math.PI * 2;
    addBox(mb, placed[0], top, placed[1], sx, sy, sz, rotY, steel);
  }
}

function addChimney(mb: MeshBuilder, outer: V2[], top: number, props: BuildingProps): void {
  let axis: V2;
  let center: V2;
  let halfLong: number;
  if (props.roof_azimuth != null && Number.isFinite(props.roof_azimuth)) {
    const rad = THREE.MathUtils.degToRad(props.roof_azimuth);
    axis = [Math.sin(rad), -Math.cos(rad)];
    const obb = minAreaOBB(outer);
    center = obb.center;
    halfLong = obb.halfLong;
  } else {
    const obb = minAreaOBB(outer);
    axis = obb.axis;
    center = obb.center;
    halfLong = obb.halfLong;
  }
  const cx = center[0] + axis[0] * (halfLong * 0.4);
  const cz = center[1] + axis[1] * (halfLong * 0.4);
  const brick = hex('brick_dark');
  const sy = props.roof_height + 0.8;
  addBox(mb, cx, top, cz, 0.6, sy, 0.6, 0, brick);
}

export function addRoofDetails(
  mb: MeshBuilder,
  outer: V2[],
  top: number,
  props: BuildingProps,
  wallColor: THREE.Color,
  _roofColor: THREE.Color,
): void {
  const rand = rng(hashStr(props.id));

  if (props.roof_shape === 'flat' && props.height > 12) {
    addParapet(mb, outer, top, wallColor);
  }
  if (props.roof_shape === 'flat' && ringArea(outer) > 400) {
    addHvac(mb, outer, top, rand);
  }
  if (props.roof_shape === 'gable' && props.height < 12) {
    addChimney(mb, outer, top, props);
  }
}
