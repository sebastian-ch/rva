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

/** Growable triangle soup with position/normal/color, optionally uv + facade attributes for the facade shader. */
export class MeshBuilder {
  pos: number[] = []; nrm: number[] = []; col: number[] = [];
  uv: number[] = []; fac: number[] = [];
  constructor(readonly withFacade = false) {}
  get triCount(): number { return this.pos.length / 9; }
  private pad() {
    if (!this.withFacade) return;
    for (let i = 0; i < 6; i++) this.uv.push(0);
    for (let i = 0; i < 12; i++) this.fac.push(0);
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, normal?: THREE.Vector3, shade = 1) {
    let n = normal;
    if (!n) n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b, c]) { this.pos.push(v.x, v.y, v.z); this.nrm.push(n.x, n.y, n.z); }
    for (let i = 0; i < 3; i++) this.col.push(color.r * shade, color.g * shade, color.b * shade);
    this.pad();
  }
  /** Triangle with per-vertex shade (fake AO gradient). */
  triShaded(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, normal: THREE.Vector3, sa: number, sb: number, sc: number) {
    for (const v of [a, b, c]) { this.pos.push(v.x, v.y, v.z); this.nrm.push(normal.x, normal.y, normal.z); }
    for (const s of [sa, sb, sc]) this.col.push(color.r * s, color.g * s, color.b * s);
    this.pad();
  }
  /** Facade wall triangle: per-vertex uv (meters along wall, meters up) and a shared facade vec4. */
  triFacade(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, normal: THREE.Vector3,
    shades: [number, number, number], uvs: [V2, V2, V2], facade: [number, number, number, number]) {
    for (const v of [a, b, c]) { this.pos.push(v.x, v.y, v.z); this.nrm.push(normal.x, normal.y, normal.z); }
    for (const s of shades) this.col.push(color.r * s, color.g * s, color.b * s);
    if (this.withFacade) {
      for (const u of uvs) this.uv.push(u[0], u[1]);
      for (let i = 0; i < 3; i++) this.fac.push(facade[0], facade[1], facade[2], facade[3]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.withFacade) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 4));
    }
    return g;
  }
}

/**
 * Inset a simple ring by distance d with mitred joins. Returns null when the result is degenerate
 * (self-intersecting, an edge flipped direction, or area not shrinking). Works in the (x, z) plane.
 */
export function insetRing(ring: V2[], d: number): V2[] | null {
  const n = ring.length;
  if (n < 3 || d <= 0) return null;
  const area0 = signedArea(ring);
  if (Math.abs(area0) < 1e-6) return null;
  const sign = area0 > 0 ? 1 : -1; // inward normal side depends on orientation
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i - 1 + n) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    const e0 = [p1[0] - p0[0], p1[1] - p0[1]], e1 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l0 = Math.hypot(e0[0], e0[1]), l1 = Math.hypot(e1[0], e1[1]);
    if (l0 < 1e-9 || l1 < 1e-9) return null;
    // inward normals (for positive-area ring the interior is to the left of the edge direction)
    const n0: V2 = [-e0[1] / l0 * sign, e0[0] / l0 * sign];
    const n1: V2 = [-e1[1] / l1 * sign, e1[0] / l1 * sign];
    const bx = n0[0] + n1[0], bz = n0[1] + n1[1];
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-6) return null; // 180° turn
    const cosHalf = bl / 2; // |bisector| = 2 cos(theta/2)
    const miter = d / Math.max(cosHalf, 0.2); // clamp very sharp corners
    out.push([p1[0] + (bx / bl) * miter, p1[1] + (bz / bl) * miter]);
  }
  // validity: same orientation, smaller area, no edge reversed
  const area1 = signedArea(out);
  if (area1 * area0 <= 0 || Math.abs(area1) >= Math.abs(area0)) return null;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], a2 = out[i], b2 = out[(i + 1) % n];
    if ((b[0] - a[0]) * (b2[0] - a2[0]) + (b[1] - a[1]) * (b2[1] - a2[1]) <= 0) return null;
  }
  if (selfIntersects(out)) return null;
  return out;
}

function segIntersect(a: V2, b: V2, c: V2, d: V2): boolean {
  const o = (p: V2, q: V2, r: V2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

export function selfIntersects(ring: V2[]): boolean {
  const n = ring.length;
  if (n > 60) return false; // skip the O(n^2) test on big rings
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
