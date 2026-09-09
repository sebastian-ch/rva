import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, cleanRing, type V2 } from './geomutil';
import type { CrossingProps, Feature, LineGeom, PointGeom, RailProps, RoadProps } from './types';

const UP = new THREE.Vector3(0, 1, 0);
const BRIDGE_LIFT = 6.0;

const MINOR = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'service', 'living_street']);

function lines(g: LineGeom): V2[][] {
  return g.type === 'LineString' ? [g.coordinates as V2[]] : (g.coordinates as V2[][]);
}

/** Emit a flat ribbon along a polyline with mitered joins. Points are local (x, z) + per-point y. */
function ribbon(mb: MeshBuilder, pts: THREE.Vector3[], halfW: number, color: THREE.Color, shade = 1) {
  const n = pts.length;
  if (n < 2) return;
  const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize();
    // miter: average of adjacent segment directions, clamp widening
    let nx = -d.z, nz = d.x, w = halfW;
    if (i > 0 && i < n - 1) {
      const d0 = new THREE.Vector3(pts[i].x - prev.x, 0, pts[i].z - prev.z).normalize();
      const d1 = new THREE.Vector3(next.x - pts[i].x, 0, next.z - pts[i].z).normalize();
      const m = new THREE.Vector3().addVectors(d0, d1).normalize();
      nx = -m.z; nz = m.x;
      const cos = m.dot(d0);
      w = halfW / Math.max(0.5, cos);
    }
    left.push(new THREE.Vector3(pts[i].x + nx * w, pts[i].y, pts[i].z + nz * w));
    right.push(new THREE.Vector3(pts[i].x - nx * w, pts[i].y, pts[i].z - nz * w));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = left[i], b = right[i], c = right[i + 1], d = left[i + 1];
    const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cr.y >= 0) { mb.tri(a, b, c, color, UP, shade); mb.tri(a, c, d, color, UP, shade); }
    else { mb.tri(a, c, b, color, UP, shade); mb.tri(a, d, c, color, UP, shade); }
  }
}

/** Resample a polyline so long segments follow terrain; returns local 3D points. */
function toPath(coords: V2[], toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number, maxSeg = 12): THREE.Vector3[] {
  const c = cleanRing(coords);
  if (c.length < 2) return [];
  const out: THREE.Vector3[] = [];
  const push = (x: number, y: number) => { const [lx, lz] = toLocal(x, y); out.push(new THREE.Vector3(lx, groundAt(x, y) + lift, lz)); };
  for (let i = 0; i < c.length - 1; i++) {
    const [x0, y0] = c[i], [x1, y1] = c[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / maxSeg));
    for (let s = 0; s < steps; s++) { const t = s / steps; push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); }
  }
  push(c[c.length - 1][0], c[c.length - 1][1]);
  // note: cleanRing drops a closing duplicate; re-add for loops
  if (coords.length > 2) {
    const f = coords[0], l = coords[coords.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) push(f[0], f[1]);
  }
  return out;
}

export interface RoadMeshes { roads: THREE.BufferGeometry; paths: THREE.Vector3[][]; }

export function buildRoads(
  feats: Feature<LineGeom, RoadProps>[],
  rails: Feature<LineGeom, RailProps>[],
  crossings: Feature<PointGeom, CrossingProps>[],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
): RoadMeshes {
  const mb = new MeshBuilder();
  const asphalt = hex('asphalt'), paint = hex('lane_paint'), sidewalk = hex('sidewalk'), railC = hex('rail'), concrete = hex('concrete');
  const carPaths: THREE.Vector3[][] = [];

  // sidewalks first (under roads)
  for (const f of feats) {
    const p = f.properties;
    if (p.tunnel || MINOR.has(p.highway)) continue;
    const lift = p.bridge ? BRIDGE_LIFT * Math.max(1, p.layer) : 0;
    for (const l of lines(f.geometry)) {
      const path = toPath(l, toLocal, groundAt, 0.12 + lift);
      ribbon(mb, path, p.width / 2 + 2.2, p.bridge ? concrete : sidewalk, 0.98);
    }
  }
  for (const f of feats) {
    const p = f.properties;
    if (p.tunnel) continue;
    const minor = MINOR.has(p.highway);
    const lift = p.bridge ? BRIDGE_LIFT * Math.max(1, p.layer) : 0;
    for (const l of lines(f.geometry)) {
      const path = toPath(l, toLocal, groundAt, (minor ? 0.14 : 0.18) + lift);
      if (path.length < 2) continue;
      ribbon(mb, path, p.width / 2, minor ? sidewalk : asphalt, minor ? 0.94 : 1);
      if (!minor && !p.oneway && (p.lanes ?? 2) >= 2) {
        const center = path.map((v) => new THREE.Vector3(v.x, v.y + 0.02, v.z));
        ribbon(mb, center, 0.12, paint);
      }
      if (!minor && p.highway !== 'service') carPaths.push(path);
    }
  }
  for (const f of rails) {
    const p = f.properties;
    const lift = p.bridge ? BRIDGE_LIFT * Math.max(1, p.layer) : 0;
    for (const l of lines(f.geometry)) {
      const path = toPath(l, toLocal, groundAt, 0.2 + lift);
      ribbon(mb, path, 1.6, railC, 0.95);
      ribbon(mb, path.map((v) => new THREE.Vector3(v.x, v.y + 0.02, v.z)), 0.75, hex('roof_dark'));
    }
  }
  // crosswalks: small striped squares aligned to the nearest road
  for (const c of crossings) {
    const [x, y] = c.geometry.coordinates;
    const [lx, lz] = toLocal(x, y);
    const gy = groundAt(x, y) + 0.2;
    const dir = nearestDir(carPaths, lx, lz) ?? new THREE.Vector3(1, 0, 0);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (let s = -2; s <= 2; s++) {
      const off = side.clone().multiplyScalar(s * 1.0);
      const a = new THREE.Vector3(lx, gy, lz).add(off).addScaledVector(dir, -2.2);
      const b = new THREE.Vector3(lx, gy, lz).add(off).addScaledVector(dir, 2.2);
      ribbon(mb, [a, b], 0.3, paint);
    }
  }
  return { roads: mb.build(), paths: carPaths };
}

function nearestDir(paths: THREE.Vector3[][], x: number, z: number): THREE.Vector3 | null {
  let best = 1e9, dir: THREE.Vector3 | null = null;
  for (const p of paths) {
    for (let i = 0; i < p.length - 1; i++) {
      const d = Math.hypot(p[i].x - x, p[i].z - z);
      if (d < best) { best = d; dir = new THREE.Vector3().subVectors(p[i + 1], p[i]).setY(0).normalize(); }
    }
  }
  return best < 25 ? dir : null;
}
