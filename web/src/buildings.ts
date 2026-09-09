import * as THREE from 'three';
import palette from '../../assets/palette.json';
import { hex } from './props';
import { MeshBuilder, ccw, centroid, cleanRing, minAreaOBB, polygons, signedArea, triangulate, type V2 } from './geomutil';
import type { BuildingProps, Feature, PolyGeom } from './types';

type PaletteKey = keyof typeof palette;
const pal = (k: string): THREE.Color => hex((k in palette ? k : 'cream') as PaletteKey);

export interface BuildingRange { start: number; count: number; props: BuildingProps }

const UP = new THREE.Vector3(0, 1, 0);
const AO_BOTTOM = 0.72; // darkening at ground contact
const AO_HEIGHT = 6;     // meters over which the gradient fades

/**
 * Extrude one footprint into `mb`. Coordinates are web-local (x east, z = -north). groundY is the terrain height.
 * Returns the number of triangles appended.
 */
export function extrudeBuilding(mb: MeshBuilder, feat: Feature<PolyGeom, BuildingProps>, toLocal: (x: number, y: number) => V2, groundY: number): number {
  const p = feat.properties;
  const start = mb.triCount;
  const wall = pal(p.wall_color), roof = pal(p.roof_color);
  const base = groundY - 0.3 + p.min_height; // sink slightly so slopes don't show gaps
  const top = groundY + p.height;
  const roofH = p.roof_shape === 'flat' ? 0 : p.roof_height;

  for (const poly of polygons(feat.geometry)) {
    const rings = poly.map((r) => cleanRing(r).map(([x, y]) => toLocal(x, y))).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    // in local (x, z) with z = -north, signedArea>0 means CW when viewed from above (+Y). Normalize:
    // outer ring -> positive area in (x,z); holes -> negative.
    const outer = signedArea(rings[0]) < 0 ? rings[0].slice().reverse() : rings[0];
    const holes = rings.slice(1).map((r) => (signedArea(r) > 0 ? r.slice().reverse() : r));

    // walls
    for (const ring of [outer, ...holes]) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % n];
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        // For outer ring with positive area in (x,z) space, interior lies to the right when looking along +y (screen)...
        // just compute both candidate normals and pick the one pointing away from the ring centroid.
        let nx = dz / len, nz = -dx / len;
        const c = centroid(ring);
        const mx = (x0 + x1) / 2 - c[0], mz = (z0 + z1) / 2 - c[1];
        const isHole = ring !== outer;
        if ((nx * mx + nz * mz < 0) !== isHole) { nx = -nx; nz = -nz; }
        const nrm = new THREE.Vector3(nx, 0, nz);
        const a = new THREE.Vector3(x0, base, z0), b = new THREE.Vector3(x1, base, z1);
        const c2 = new THREE.Vector3(x1, top, z1), d = new THREE.Vector3(x0, top, z0);
        const sTop = 1, sBot = p.height > AO_HEIGHT ? AO_BOTTOM : THREE.MathUtils.lerp(1, AO_BOTTOM, p.height / AO_HEIGHT);
        // sun-facing walls a touch lighter: fake directional shading baked in
        const sun = 0.92 + 0.08 * Math.max(0, nx * 0.6 + nz * 0.8);
        // winding: ensure normal matches cross
        const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c2, a));
        if (cross.dot(nrm) < 0) {
          mb.triShaded(a, c2, b, wall, nrm, sBot * sun, sTop * sun, sBot * sun);
          mb.triShaded(a, d, c2, wall, nrm, sBot * sun, sTop * sun, sTop * sun);
        } else {
          mb.triShaded(a, b, c2, wall, nrm, sBot * sun, sBot * sun, sTop * sun);
          mb.triShaded(a, c2, d, wall, nrm, sBot * sun, sTop * sun, sTop * sun);
        }
      }
    }

    // cap at roofline (always; hides roof-prism seams on non-rect footprints)
    const all = [...outer, ...holes.flat()];
    const idx = triangulate(outer, holes);
    const capColor = roofH > 0 ? wall : roof;
    for (let i = 0; i < idx.length; i += 3) {
      const A = all[idx[i]], B = all[idx[i + 1]], C = all[idx[i + 2]];
      let a = new THREE.Vector3(A[0], top, A[1]), b = new THREE.Vector3(B[0], top, B[1]), c = new THREE.Vector3(C[0], top, C[1]);
      const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (cr.y < 0) [b, c] = [c, b];
      mb.tri(a, b, c, capColor, UP, roofH > 0 ? 0.9 : 1);
    }

    if (roofH > 0) addRoof(mb, outer, top, roofH, p.roof_shape, roof, wall);
  }
  return mb.triCount - start;
}

function addRoof(mb: MeshBuilder, outer: V2[], top: number, roofH: number, shape: string, roof: THREE.Color, wall: THREE.Color) {
  const obb = minAreaOBB(outer);
  const inset = 0.97;
  const [ax, az] = obb.axis;
  const px = -az, pz = ax; // perpendicular (short axis)
  const L = obb.halfLong * inset, S = obb.halfShort * inset;
  const [cx, cz] = obb.center;
  const P = (u: number, v: number, y: number) => new THREE.Vector3(cx + ax * u + px * v, y, cz + az * u + pz * v);
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col: THREE.Color, shade = 1) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.y < 0) { n.negate(); mb.tri(a, c, b, col, n, shade); mb.tri(a, d, c, col, n, shade); }
    else { mb.tri(a, b, c, col, n, shade); mb.tri(a, c, d, col, n, shade); }
  };
  const triUp = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color, shade = 1) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.y < 0) { n.negate(); mb.tri(a, c, b, col, n, shade); } else mb.tri(a, b, c, col, n, shade);
  };
  const ridgeY = top + roofH;
  // corners at eave
  const c00 = P(-L, -S, top), c10 = P(L, -S, top), c11 = P(L, S, top), c01 = P(-L, S, top);
  switch (shape) {
    case 'gable': {
      const r0 = P(-L, 0, ridgeY), r1 = P(L, 0, ridgeY);
      quad(c00, c10, r1, r0, roof, 1.0);
      quad(c01, c11, r1, r0, roof, 0.88);
      // gable ends (vertical triangles) in wall color
      gableEnd(mb, c00, c01, r0, wall);
      gableEnd(mb, c10, c11, r1, wall);
      break;
    }
    case 'hip': {
      const ins = Math.min(S, L * 0.6);
      const r0 = P(-L + ins, 0, ridgeY), r1 = P(L - ins, 0, ridgeY);
      quad(c00, c10, r1, r0, roof, 1.0);
      quad(c01, c11, r1, r0, roof, 0.88);
      triUp(c00, c01, r0, roof, 0.94);
      triUp(c10, c11, r1, roof, 0.94);
      break;
    }
    case 'skillion': {
      const h0 = P(-L, -S, top), h1 = P(L, -S, top), h2 = P(L, S, ridgeY), h3 = P(-L, S, ridgeY);
      quad(h0, h1, h2, h3, roof);
      // back wall + side triangles
      quad(P(-L, S, top), P(L, S, top), h2, h3, wall, 0.9);
      gableEnd(mb, P(-L, -S, top), P(-L, S, top), h3, wall);
      gableEnd(mb, P(L, -S, top), P(L, S, top), h2, wall);
      break;
    }
    case 'pyramidal': {
      const apex = P(0, 0, ridgeY);
      triUp(c00, c10, apex, roof, 1.0); triUp(c10, c11, apex, roof, 0.9);
      triUp(c11, c01, apex, roof, 0.86); triUp(c01, c00, apex, roof, 0.94);
      break;
    }
    case 'dome': {
      const seg = 8, rings = 4;
      const r = Math.min(L, S);
      const pt = (i: number, j: number) => {
        const th = (i / seg) * Math.PI * 2, ph = (j / rings) * (Math.PI / 2);
        return P(Math.cos(th) * Math.cos(ph) * r * (L / r), Math.sin(th) * Math.cos(ph) * r * (S / r), top + Math.sin(ph) * roofH);
      };
      for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        if (j === rings - 1) triUp(a, b, P(0, 0, top + roofH), roof); else quad(a, b, c, d, roof);
      }
      break;
    }
  }
}

function gableEnd(mb: MeshBuilder, a: THREE.Vector3, b: THREE.Vector3, apex: THREE.Vector3, col: THREE.Color) {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(apex, a)).normalize();
  // outward = away from the roof center (approximate with mid of a,b vs apex projection)
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const toMid = new THREE.Vector3(mid.x - apex.x, 0, mid.z - apex.z);
  if (n.dot(toMid) < 0) { n.negate(); mb.tri(a, apex, b, col, n, 0.85); } else mb.tri(a, b, apex, col, n, 0.85);
}

/** Build a whole tile's buildings as one mesh + face-range table for picking. */
export function buildBuildingsMesh(
  feats: Feature<PolyGeom, BuildingProps>[],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
  material: THREE.Material,
): { mesh: THREE.Mesh; ranges: BuildingRange[] } {
  const mb = new MeshBuilder();
  const ranges: BuildingRange[] = [];
  for (const f of feats) {
    const outer = ccw(cleanRing(polygons(f.geometry)[0][0]));
    if (outer.length < 3) continue;
    const c = centroid(outer);
    const g = Number.isFinite(f.properties.ground_z) ? f.properties.ground_z : groundAt(c[0], c[1]);
    const start = mb.triCount;
    const count = extrudeBuilding(mb, f, toLocal, g);
    if (count > 0) ranges.push({ start, count, props: f.properties });
  }
  const mesh = new THREE.Mesh(mb.build(), material);
  mesh.matrixAutoUpdate = false;
  return { mesh, ranges };
}

export function rangeForFace(ranges: BuildingRange[], faceIndex: number): BuildingRange | null {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = ranges[mid];
    if (faceIndex < r.start) hi = mid - 1;
    else if (faceIndex >= r.start + r.count) lo = mid + 1;
    else return r;
  }
  return null;
}
