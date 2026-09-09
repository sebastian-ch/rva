import * as THREE from 'three';
import type { Ring, PolygonCoords, PolyGeom } from './types';

export type V2 = [number, number];

export function signedArea(ring: V2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Drop closing duplicate + consecutive duplicates. */
export function cleanRing(ring: Ring): V2[] {
  const out: V2[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
  }
  return out;
}

/** Ensure CCW (positive signed area). */
export function ccw(ring: V2[]): V2[] {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

export function polygons(g: PolyGeom): PolygonCoords[] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

export function centroid(ring: V2[]): V2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f; cy += (y0 + y1) * f; a += f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Earcut triangulation of an outer ring with holes -> flat index list into concat(outer, ...holes). */
export function triangulate(outer: V2[], holes: V2[][]): number[] {
  const o = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const h = holes.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
  const tris = THREE.ShapeUtils.triangulateShape(o, h);
  const out: number[] = [];
  for (const t of tris) out.push(t[0], t[1], t[2]);
  return out;
}

export function convexHull(pts: V2[]): V2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

export interface OBB { center: V2; axis: V2; /* unit long axis */ halfLong: number; halfShort: number }

/** Minimum-area oriented bounding box via rotating edges of the convex hull. */
export function minAreaOBB(pts: V2[]): OBB {
  const hull = convexHull(pts);
  let best: OBB | null = null, bestArea = Infinity;
  const n = hull.length;
  if (n < 2) return { center: pts[0] ?? [0, 0], axis: [1, 0], halfLong: 1, halfShort: 1 };
  for (let i = 0; i < n; i++) {
    const [x0, y0] = hull[i], [x1, y1] = hull[(i + 1) % n];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const center: V2 = [cu * ux - cv * uy, cu * uy + cv * ux];
      const du = (maxU - minU) / 2, dv = (maxV - minV) / 2;
      best = du >= dv
        ? { center, axis: [ux, uy], halfLong: du, halfShort: dv }
        : { center, axis: [-uy, ux], halfLong: dv, halfShort: du };
    }
  }
  return best!;
}

export function pointInRing(p: V2, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBounds(ring: V2[]): [number, number, number, number] {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
  return [minx, miny, maxx, maxy];
}

/** Deterministic PRNG (mulberry32) so scatter is stable between reloads. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Growable triangle soup with position/normal/color. */
export class MeshBuilder {
  pos: number[] = []; nrm: number[] = []; col: number[] = [];
  get triCount(): number { return this.pos.length / 9; }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, normal?: THREE.Vector3, shade = 1) {
    let n = normal;
    if (!n) n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b, c]) { this.pos.push(v.x, v.y, v.z); this.nrm.push(n.x, n.y, n.z); }
    for (let i = 0; i < 3; i++) this.col.push(color.r * shade, color.g * shade, color.b * shade);
  }
  /** Triangle with per-vertex shade (fake AO gradient). */
  triShaded(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, normal: THREE.Vector3, sa: number, sb: number, sc: number) {
    for (const v of [a, b, c]) { this.pos.push(v.x, v.y, v.z); this.nrm.push(normal.x, normal.y, normal.z); }
    for (const s of [sa, sb, sc]) this.col.push(color.r * s, color.g * s, color.b * s);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}
