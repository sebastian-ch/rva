import { conformTriangle } from './drape';
import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, cleanRing, minAreaOBB, pointInRing, polygons, signedArea, triangulate, type V2 } from './geomutil';
import type { AreaProps, Feature, PolyGeom } from './types';

const UP = new THREE.Vector3(0, 1, 0);

const LANDUSE_COLOR: Record<string, [string, number]> = {
  park: ['grass', 0.08], grass: ['grass', 0.07], forest: ['canopy', 0.08], cemetery: ['grass', 0.07],
  parking: ['concrete', 0.06], plaza: ['sidewalk', 0.08], industrial: ['sand', 0.05],
  beach: ['sand', 0.08], deck: ['deck', 0.12],
};
const WATER_COLOR: Record<string, string> = { river: 'water', canal: 'water_deep', pond: 'water', ocean: 'water' };

/** Drape polygons onto terrain; interior is subdivided on a grid so big parks follow relief. */
function drape(mb: MeshBuilder, feat: Feature<PolyGeom, AreaProps>, color: THREE.Color, lift: number,
  toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, flatY: number | null, shade = 1) {
  for (const poly of polygons(feat.geometry)) {
    const rings = poly.map((r) => cleanRing(r)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const outer = signedArea(rings[0]) < 0 ? rings[0].slice().reverse() : rings[0];
    const holes = rings.slice(1).map((r) => (signedArea(r) > 0 ? r.slice().reverse() : r));
    const all = [...outer, ...holes.flat()];
    const idx = triangulate(outer, holes);
    const V = (p: V2): THREE.Vector3 => {
      const [lx, lz] = toLocal(p[0], p[1]);
      return new THREE.Vector3(lx, flatY ?? groundAt(p[0], p[1]) + lift, lz);
    };
    for (let i = 0; i < idx.length; i += 3) {
      const A = all[idx[i]], B = all[idx[i + 1]], C = all[idx[i + 2]];
      subdivideTri(A, B, C, flatY === null ? (feat.properties.kind === 'beach' ? 2.5 : 8) : 60, (a, b, c) => {
        let va = V(a), vb = V(b), vc = V(c);
        const cr = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va));
        if (cr.y < 0) [vb, vc] = [vc, vb];
        if (flatY === null) {
          const [ox, oz] = toLocal(0, 0);
          conformTriangle(va, vb, vc, (x,z) => groundAt(x-ox, oz-z)+lift,
            (a,b,c) => mb.tri(a,b,c,color,UP,shade));
        } else mb.tri(va, vb, vc, color, UP, shade);
      });
    }
  }
}

/** Recursively split triangles whose longest edge exceeds maxEdge (in meters). */
function subdivideTri(a: V2, b: V2, c: V2, maxEdge: number, emit: (a: V2, b: V2, c: V2) => void, depth = 0) {
  const ab = Math.hypot(a[0] - b[0], a[1] - b[1]), bc = Math.hypot(b[0] - c[0], b[1] - c[1]), ca = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const m = Math.max(ab, bc, ca);
  if (m <= maxEdge || depth > 8) { emit(a, b, c); return; }
  const mid = (p: V2, q: V2): V2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  if (m === ab) { const x = mid(a, b); subdivideTri(a, x, c, maxEdge, emit, depth + 1); subdivideTri(x, b, c, maxEdge, emit, depth + 1); }
  else if (m === bc) { const x = mid(b, c); subdivideTri(a, b, x, maxEdge, emit, depth + 1); subdivideTri(a, x, c, maxEdge, emit, depth + 1); }
  else { const x = mid(c, a); subdivideTri(a, b, x, maxEdge, emit, depth + 1); subdivideTri(x, b, c, maxEdge, emit, depth + 1); }
}

export function buildAreas(
  landuse: Feature<PolyGeom, AreaProps>[],
  water: Feature<PolyGeom, AreaProps>[],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
  baseWaterY: number,
  waterAt?: (x: number, y: number) => number,
): { land: THREE.BufferGeometry; water: THREE.BufferGeometry } {
  const land = new MeshBuilder(), wat = new MeshBuilder();
  for (const f of landuse) {
    if (typeof f.properties.top_z === 'number' && typeof f.properties.base_z === 'number') {
      coastalStructure(land, f, toLocal);
      continue;
    }
    const spec = LANDUSE_COLOR[f.properties.kind];
    if (!spec) continue;
    drape(land, f, hex(spec[0] as never), spec[1], toLocal, groundAt, null);
    if (f.properties.kind === 'parking') parkingStripes(land, f, toLocal, groundAt, spec[1] + 0.02);
  }
  for (const f of water) {
    const kind = f.properties.kind;
    // The DEM carries the water surface (hydro-flattened where still, sloping across the fall line), so rivers
    // follow the terrain with a small lift. Canals / ponds are flat at the pipeline's water_z (the terrain grid is
    // flattened below it); older tiles without water_z fall back to the lowest outline sample.
    let y: number | null = null;
    let lift = 0.3;
    if (kind !== 'river') {
      if (typeof f.properties.water_z === 'number') y = f.properties.water_z;
      else {
        let min = Infinity;
        for (const poly of polygons(f.geometry)) for (const [x, yy] of poly[0]) min = Math.min(min, groundAt(x, yy));
        y = (Number.isFinite(min) ? min : baseWaterY) - 0.2;
      }
      lift = 0;
    }
    const surveyed = f.properties.source === 'noaa2025' && waterAt;
    drape(wat, f, hex((WATER_COLOR[kind] ?? 'water') as never), surveyed ? 0.12 : lift, toLocal, surveyed || groundAt, y);
  }
  return { land: land.build(), water: wat.build() };
}

const STALL = 2.7, AISLE = 6.0, ROW = 5.0 + AISLE; // stall pitch, aisle width, row pitch (two stall depths + aisle)

/** Raised coastal decks with visible sides, independent of the coarse underwater DEM. */
function coastalStructure(mb: MeshBuilder, f: Feature<PolyGeom, AreaProps>, toLocal: (x: number, y: number) => V2) {
  const top = f.properties.top_z!, base = f.properties.base_z!;
  const color = hex('concrete');
  drape(mb, f, color, 0, toLocal, () => 0, top);
  for (const poly of polygons(f.geometry)) for (const [index, raw] of poly.entries()) {
    const ring = cleanRing(raw);
    if ((signedArea(ring) > 0) !== (index === 0)) ring.reverse();
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = toLocal(...ring[i]), [bx, bz] = toLocal(...ring[(i + 1) % ring.length]);
      const a = new THREE.Vector3(ax, base, az), b = new THREE.Vector3(bx, base, bz);
      const c = new THREE.Vector3(bx, top, bz), d = new THREE.Vector3(ax, top, az);
      const normal = new THREE.Vector3(-(bz - az), 0, bx - ax).normalize();
      mb.tri(a, b, c, color, normal, 0.72);
      mb.tri(a, c, d, color, normal, 0.72);
    }
  }
}

/** Painted stall lines on surface parking: rows along the lot's long axis, stalls perpendicular to it. */
function parkingStripes(mb: MeshBuilder, feat: Feature<PolyGeom, AreaProps>, toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number) {
  const paint = hex('lane_paint');
  for (const poly of polygons(feat.geometry)) {
    const ring = cleanRing(poly[0]);
    if (ring.length < 3) continue;
    const area = Math.abs(signedArea(ring));
    if (area < 400 || area > 60000) continue;
    const holes = poly.slice(1).map(cleanRing);
    const obb = minAreaOBB(ring);
    const [ax, ay] = obb.axis, px = -ay, py = ax;
    const [cx, cy] = obb.center;
    const inside = (x: number, y: number) => pointInRing([x, y], ring) && !holes.some((h) => pointInRing([x, y], h));
    const P = (u: number, v: number) => [cx + ax * u + px * v, cy + ay * u + py * v] as V2;
    // rows of stalls: for each row band, stall lines every STALL along u, each line 5 m long across v
    for (let v = -obb.halfShort + 3; v < obb.halfShort - 3; v += ROW) {
      for (let u = -obb.halfLong + 2; u < obb.halfLong - 2; u += STALL) {
        const a = P(u, v), b = P(u, v + 5.0);
        if (!inside(a[0], a[1]) || !inside(b[0], b[1])) continue;
        const [lx0, lz0] = toLocal(a[0], a[1]), [lx1, lz1] = toLocal(b[0], b[1]);
        const y0 = groundAt(a[0], a[1]) + lift, y1 = groundAt(b[0], b[1]) + lift;
        const A = new THREE.Vector3(lx0, y0, lz0), B = new THREE.Vector3(lx1, y1, lz1);
        const side = new THREE.Vector3(-(B.z - A.z), 0, B.x - A.x).normalize().multiplyScalar(0.06);
        const q0 = A.clone().add(side), q1 = B.clone().add(side), q2 = B.clone().sub(side), q3 = A.clone().sub(side);
        const cr = new THREE.Vector3().subVectors(q1, q0).cross(new THREE.Vector3().subVectors(q2, q0));
        if (cr.y >= 0) { mb.tri(q0, q1, q2, paint, UP); mb.tri(q0, q2, q3, paint, UP); }
        else { mb.tri(q0, q2, q1, paint, UP); mb.tri(q0, q3, q2, paint, UP); }
      }
    }
  }
}
