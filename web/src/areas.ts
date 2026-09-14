import { conformTriangle } from './drape';
import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, cleanRing, convexHull, minAreaOBB, pointInRing, polygons, signedArea, triangulate, type V2 } from './geomutil';
import type { AreaProps, Feature, PolyGeom } from './types';

const UP = new THREE.Vector3(0, 1, 0);

const LANDUSE_COLOR: Record<string, [string, number]> = {
  park: ['grass', 0.08], grass: ['grass', 0.07], forest: ['canopy', 0.08], cemetery: ['grass', 0.07],
  // Pitches often sit inside a mapped park/recreation polygon. Keep them above that
  // base surface or its triangles show through courts and infields.
  pitch: ['sports_turf', 0.105],
  parking: ['concrete', 0.06], plaza: ['sidewalk', 0.08], industrial: ['sand', 0.05],
  beach: ['sand', 0.08], deck: ['deck', 0.12],
  groundcover_lawn: ['rough_grass', 0.065], groundcover_paved: ['paving', 0.064],
  groundcover_bare: ['bare_ground', 0.063],
};
const WATER_COLOR: Record<string, string> = { river: 'water', canal: 'water_deep', pond: 'water', ocean: 'water' };

// Reviewed against Richmond's VGIN imagery. OSM either omits the surface on the VCU
// Cary Street courts or records the material (tartan), which does not encode its blue color.
const RICHMOND_BLUE_TENNIS_COURTS = new Set([
  'osm:way/1215879874', 'osm:way/1215879875', 'osm:way/1215879876',
  'osm:way/1432779830', 'osm:way/1432779831', 'osm:way/1432779832', 'osm:way/1432779833',
  'osm:way/1432779834', 'osm:way/1432779835', 'osm:way/1432779836', 'osm:way/1432779837',
  'osm:way/1442671113', 'osm:way/1442671114', 'osm:way/1442671115', 'osm:way/1442671116',
  'osm:way/1442671117', 'osm:way/1442671118', 'osm:way/1442671119', 'osm:way/1442671120',
  'osm:way/44740504',
]);

export function pitchSurfaceColor(p: Pick<AreaProps, 'id' | 'kind' | 'sport' | 'surface'>): string {
  if (p.kind !== 'pitch' || p.sport !== 'tennis') return LANDUSE_COLOR[p.kind]?.[0] ?? 'sports_turf';
  if (RICHMOND_BLUE_TENNIS_COURTS.has(p.id) || /blue/i.test(p.surface ?? '')) return 'court_blue';
  if (/clay|red/i.test(p.surface ?? '')) return 'court_red';
  return 'court_green';
}

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
    const pitchColor = pitchSurfaceColor(f.properties);
    drape(land, f, hex(pitchColor as never), spec[1], toLocal, groundAt, null);
    if (f.properties.kind === 'parking') parkingStripes(land, f, toLocal, groundAt, spec[1] + 0.02);
    if (f.properties.kind === 'pitch') sportsMarkings(land, f, toLocal, groundAt, spec[1] + 0.025);
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

/** A narrow terrain-following painted segment shared by parking and sports markings. */
function surfaceLine(mb: MeshBuilder, a: V2, b: V2, width: number, color: THREE.Color,
  toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const p0: V2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
    const p1: V2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
    const [lx0, lz0] = toLocal(p0[0], p0[1]), [lx1, lz1] = toLocal(p1[0], p1[1]);
    const A = new THREE.Vector3(lx0, groundAt(p0[0], p0[1]) + lift, lz0);
    const B = new THREE.Vector3(lx1, groundAt(p1[0], p1[1]) + lift, lz1);
    const side = new THREE.Vector3(-(B.z - A.z), 0, B.x - A.x).normalize().multiplyScalar(width / 2);
    const q0 = A.clone().add(side), q1 = B.clone().add(side), q2 = B.clone().sub(side), q3 = A.clone().sub(side);
    const cr = new THREE.Vector3().subVectors(q1, q0).cross(new THREE.Vector3().subVectors(q2, q0));
    if (cr.y >= 0) { mb.tri(q0, q1, q2, color, UP); mb.tri(q0, q2, q3, color, UP); }
    else { mb.tri(q0, q2, q1, color, UP); mb.tri(q0, q3, q2, color, UP); }
  }
}

function surfaceFill(mb: MeshBuilder, ring: V2[], color: THREE.Color,
  toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number) {
  if (ring.length < 3) return;
  const V = (p: V2) => { const [x, z] = toLocal(p[0], p[1]); return new THREE.Vector3(x, groundAt(p[0], p[1]) + lift, z); };
  for (let i = 1; i < ring.length - 1; i++) {
    let a = V(ring[0]), b = V(ring[i]), c = V(ring[i + 1]);
    if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).y < 0) [b, c] = [c, b];
    conformTriangle(a, b, c, (x, z) => {
      const [ox, oz] = toLocal(0, 0);
      return groundAt(x - ox, oz - z) + lift;
    }, (x, y, z) => mb.tri(x, y, z, color, UP));
  }
}

/** Clip a convex decoration to the tile-clipped feature bounds. Pitch decorations are already inside the
 * full source polygon; this preserves fills when that polygon is split at a tile edge. */
function clipPolygonBox(poly: V2[], minX: number, minY: number, maxX: number, maxY: number): V2[] {
  type Edge = { inside: (p: V2) => boolean; intersect: (a: V2, b: V2) => V2 };
  const edges: Edge[] = [
    { inside: (p) => p[0] >= minX, intersect: (a, b) => [minX, a[1] + (b[1] - a[1]) * (minX - a[0]) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= maxX, intersect: (a, b) => [maxX, a[1] + (b[1] - a[1]) * (maxX - a[0]) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= minY, intersect: (a, b) => [a[0] + (b[0] - a[0]) * (minY - a[1]) / (b[1] - a[1]), minY] },
    { inside: (p) => p[1] <= maxY, intersect: (a, b) => [a[0] + (b[0] - a[0]) * (maxY - a[1]) / (b[1] - a[1]), maxY] },
  ];
  let out = poly;
  for (const edge of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      const ai = edge.inside(a), bi = edge.inside(b);
      if (ai !== bi) out.push(edge.intersect(a, b));
      if (bi) out.push(b);
    }
    if (!out.length) break;
  }
  return out;
}

/** Draw recognizable field geometry inside the mapped pitch instead of treating every sport as plain grass. */
function sportsMarkings(mb: MeshBuilder, feat: Feature<PolyGeom, AreaProps>,
  toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number) {
  const sport = (feat.properties.sport ?? '').split(';')[0];
  if (!['tennis', 'baseball', 'american_football', 'soccer'].includes(sport)) return;
  const paint = hex('field_paint');
  for (const poly of polygons(feat.geometry)) {
    const ring = cleanRing(poly[0]);
    if (ring.length < 3) continue;
    const holes = poly.slice(1).map(cleanRing);
    const inside = (p: V2) => pointInRing(p, ring) && !holes.some((h) => pointInRing(p, h));
    const line = (a: V2, b: V2, width = 0.14) => {
      // Clip the full-field segment into this tile's polygon. End-point checks alone drop any line that
      // crosses a tile with both ends outside it.
      const ts = [0, 1], dx = b[0] - a[0], dy = b[1] - a[1];
      for (const boundary of [ring, ...holes]) for (let i = 0; i < boundary.length; i++) {
        const c = boundary[i], d = boundary[(i + 1) % boundary.length];
        const ex = d[0] - c[0], ey = d[1] - c[1], den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-8) continue;
        const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
        const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.sort((x, y) => x - y);
      for (let i = 0; i < ts.length - 1; i++) {
        const t0 = ts[i], t1 = ts[i + 1];
        if (t1 - t0 < 1e-5) continue;
        const mid: V2 = [a[0] + dx * (t0 + t1) / 2, a[1] + dy * (t0 + t1) / 2];
        if (inside(mid)) surfaceLine(mb, [a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1], width, paint, toLocal, groundAt, lift);
      }
    };
    let obb = minAreaOBB(ring);
    let layout: Record<string, number> | null = null;
    if (feat.properties.pitch_layout) {
      try { layout = JSON.parse(feat.properties.pitch_layout) as Record<string, number>; } catch { layout = null; }
      if (layout && ['cx', 'cy', 'ax', 'ay', 'hl', 'hs'].every((k) => Number.isFinite(layout![k]))) {
        obb = { center: [layout.cx, layout.cy], axis: [layout.ax, layout.ay], halfLong: layout.hl, halfShort: layout.hs };
      }
    }
    const [ux, uy] = obb.axis, vx = -uy, vy = ux;
    const P = (u: number, v: number): V2 => [obb.center[0] + ux * u + vx * v, obb.center[1] + uy * u + vy * v];
    const rect = (u0: number, u1: number, v0: number, v1: number, width = 0.14) => {
      line(P(u0, v0), P(u1, v0), width); line(P(u1, v0), P(u1, v1), width);
      line(P(u1, v1), P(u0, v1), width); line(P(u0, v1), P(u0, v0), width);
    };

    if (sport === 'tennis') {
      const nu = Math.max(1, Math.min(4, Math.floor((obb.halfLong * 2 + 2) / 26)));
      const nv = Math.max(1, Math.min(3, Math.floor((obb.halfShort * 2 + 2) / 14)));
      const cellU = obb.halfLong * 2 / nu, cellV = obb.halfShort * 2 / nv;
      for (let iu = 0; iu < nu; iu++) for (let iv = 0; iv < nv; iv++) {
        const cu = -obb.halfLong + cellU * (iu + 0.5), cv = -obb.halfShort + cellV * (iv + 0.5);
        const hl = Math.min(11.89, cellU / 2 - 0.45), hs = Math.min(5.49, cellV / 2 - 0.45);
        if (hl < 6.5 || hs < 3) continue;
        const Q = (u: number, v: number) => P(cu + u, cv + v);
        const qline = (u0: number, v0: number, u1: number, v1: number, width = 0.10) => line(Q(u0, v0), Q(u1, v1), width);
        qline(-hl, -hs, hl, -hs); qline(hl, -hs, hl, hs); qline(hl, hs, -hl, hs); qline(-hl, hs, -hl, -hs);
        qline(0, -hs, 0, hs, 0.13); // net
        const service = Math.min(6.4, hl - 0.5), singles = Math.min(4.12, hs - 0.35);
        qline(-service, -singles, -service, singles); qline(service, -singles, service, singles);
        qline(-hl, -singles, hl, -singles); qline(-hl, singles, hl, singles);
        qline(-service, 0, service, 0);
      }
    } else if (sport === 'american_football') {
      const hl = obb.halfLong - 2, hs = obb.halfShort - 2;
      if (hl < 25 || hs < 10) continue;
      rect(-hl, hl, -hs, hs, 0.18);
      for (let i = 1; i < 10; i++) line(P(-hl + (2 * hl * i) / 10, -hs), P(-hl + (2 * hl * i) / 10, hs), i === 5 ? 0.22 : 0.11);
      line(P(-hl * 0.8, -hs), P(-hl * 0.8, hs), 0.2); line(P(hl * 0.8, -hs), P(hl * 0.8, hs), 0.2);
    } else if (sport === 'soccer') {
      const hl = obb.halfLong - 2, hs = obb.halfShort - 2;
      if (hl < 15 || hs < 8) continue;
      rect(-hl, hl, -hs, hs, 0.16); line(P(0, -hs), P(0, hs), 0.14);
      const radius = Math.min(9.15, hs * 0.35), steps = 20;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2, b = ((i + 1) / steps) * Math.PI * 2;
        line(P(Math.cos(a) * radius, Math.sin(a) * radius), P(Math.cos(b) * radius, Math.sin(b) * radius), 0.12);
      }
    } else {
      const hull = convexHull(ring);
      let H: V2, A: V2, B: V2, da: V2, db: V2, maxA: number, maxB: number;
      if (layout && ['hx', 'hy', 'dax', 'day', 'dbx', 'dby', 'la', 'lb'].every((k) => Number.isFinite(layout![k]))) {
        H = [layout.hx, layout.hy]; da = [layout.dax, layout.day]; db = [layout.dbx, layout.dby];
        maxA = layout.la; maxB = layout.lb;
        A = [H[0] + da[0] * maxA, H[1] + da[1] * maxA]; B = [H[0] + db[0] * maxB, H[1] + db[1] * maxB];
      } else {
        if (hull.length < 3) continue;
        let home = 0, best = Infinity;
        for (let i = 0; i < hull.length; i++) {
          const p = hull[i], a = hull[(i - 1 + hull.length) % hull.length], b = hull[(i + 1) % hull.length];
          const ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1];
          const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))))) || Math.PI;
          if (angle < best) { best = angle; home = i; }
        }
        H = hull[home]; A = hull[(home - 1 + hull.length) % hull.length]; B = hull[(home + 1) % hull.length];
        const norm = (p: V2): V2 => { const d = Math.hypot(p[0], p[1]); return [p[0] / d, p[1] / d]; };
        da = norm([A[0] - H[0], A[1] - H[1]]); db = norm([B[0] - H[0], B[1] - H[1]]);
        maxA = Math.hypot(A[0] - H[0], A[1] - H[1]); maxB = Math.hypot(B[0] - H[0], B[1] - H[1]);
      }
      const base = Math.min(27.43, maxA * 0.65, maxB * 0.65);
      // Youth diamonds and clipped source outlines can have a surveyed foul-line
      // run just under 15 m. Keep those small infields instead of dropping all
      // baseball detail; shorter geometry is too ambiguous to decorate safely.
      if (base < 7) continue;
      const first: V2 = [H[0] + da[0] * base, H[1] + da[1] * base];
      const third: V2 = [H[0] + db[0] * base, H[1] + db[1] * base];
      const second: V2 = [first[0] + db[0] * base, first[1] + db[1] * base];
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      // A baseball skin follows an arc between the foul lines. The former four-corner
      // fill looked like a square and left conspicuous turf wedges around second base.
      const angleA = Math.atan2(da[1], da[0]), angleB = Math.atan2(db[1], db[0]);
      let sweep = angleB - angleA;
      while (sweep <= -Math.PI) sweep += Math.PI * 2;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      const skinRadius = Math.min(base * 1.12, maxA * 0.72, maxB * 0.72);
      const skin: V2[] = [H];
      for (let i = 0; i <= 12; i++) {
        const a = angleA + sweep * (i / 12);
        skin.push([H[0] + Math.cos(a) * skinRadius, H[1] + Math.sin(a) * skinRadius]);
      }
      const dirt = clipPolygonBox(skin, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      if (dirt.length >= 3) surfaceFill(mb, dirt, hex('baseball_dirt'), toLocal, groundAt, lift - 0.008);
      line(H, A, 0.16); line(H, B, 0.16); line(H, first, 0.11); line(first, second, 0.11); line(second, third, 0.11); line(third, H, 0.11);
    }
  }
}

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
        surfaceLine(mb, a, b, 0.12, paint, toLocal, groundAt, lift);
      }
    }
  }
}
