import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, cleanRing, polygons, signedArea, triangulate, type V2 } from './geomutil';
import type { AreaProps, Feature, PolyGeom } from './types';

const UP = new THREE.Vector3(0, 1, 0);

const LANDUSE_COLOR: Record<string, [string, number]> = {
  park: ['grass', 0.1], grass: ['grass', 0.09], forest: ['canopy', 0.1], cemetery: ['grass', 0.09],
  parking: ['concrete', 0.08], plaza: ['sidewalk', 0.1], industrial: ['sand', 0.05],
};
const WATER_COLOR: Record<string, string> = { river: 'water', canal: 'water_deep', pond: 'water' };

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
      subdivideTri(A, B, C, flatY === null ? 20 : 60, (a, b, c) => {
        let va = V(a), vb = V(b), vc = V(c);
        const cr = new THREE.Vector3().subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va));
        if (cr.y < 0) [vb, vc] = [vc, vb];
        mb.tri(va, vb, vc, color, UP, shade);
      });
    }
  }
}

/** Recursively split triangles whose longest edge exceeds maxEdge (in meters). */
function subdivideTri(a: V2, b: V2, c: V2, maxEdge: number, emit: (a: V2, b: V2, c: V2) => void, depth = 0) {
  const ab = Math.hypot(a[0] - b[0], a[1] - b[1]), bc = Math.hypot(b[0] - c[0], b[1] - c[1]), ca = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const m = Math.max(ab, bc, ca);
  if (m <= maxEdge || depth > 6) { emit(a, b, c); return; }
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
): { land: THREE.BufferGeometry; water: THREE.BufferGeometry } {
  const land = new MeshBuilder(), wat = new MeshBuilder();
  for (const f of landuse) {
    const spec = LANDUSE_COLOR[f.properties.kind];
    if (!spec) continue;
    drape(land, f, hex(spec[0] as never), spec[1], toLocal, groundAt, null);
  }
  for (const f of water) {
    const kind = f.properties.kind;
    // rivers sit at the base plane; canals/ponds at the lowest terrain sample around their outline, minus a bit
    let y = baseWaterY + 0.25;
    if (kind !== 'river') {
      let min = Infinity;
      for (const poly of polygons(f.geometry)) for (const [x, yy] of poly[0]) min = Math.min(min, groundAt(x, yy));
      y = (Number.isFinite(min) ? min : baseWaterY) - 0.2;
    }
    drape(wat, f, hex((WATER_COLOR[kind] ?? 'water') as never), 0, toLocal, groundAt, y);
  }
  return { land: land.build(), water: wat.build() };
}
