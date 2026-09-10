import * as THREE from 'three';
import palette from '../../assets/palette.json';
import { hex } from './props';
import { MeshBuilder, ccw, centroid, cleanRing, insetRing, minAreaOBB, polygons, signedArea, triangulate, type V2 } from './geomutil';
import { facadeParams } from './facade';
import { addBox, addRoofDetails } from './roofDetails';
import { hashStr } from './geomutil';
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
export interface ExtrudeOptions { details?: boolean }

export function isSevenEleven(p: Pick<BuildingProps, 'id' | 'name' | 'addr' | 'website'>): boolean {
  return p.id === 'osm:way/236014923' || /7[- ]?eleven/i.test(`${p.name ?? ''} ${p.addr ?? ''} ${p.website ?? ''}`);
}

function addSevenElevenFacade(mb: MeshBuilder, outer: V2[], ground: number): void {
  const obb = minAreaOBB(outer);
  const [ax, az] = obb.axis;
  const perp: V2 = [-az, ax];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of outer) {
    const u = x * ax + z * az, v = x * perp[0] + z * perp[1];
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const uMid = (minU + maxU) * 0.5;
  const rot = Math.atan2(az, ax);
  const point = (u: number, v: number): V2 => [u * ax + v * perp[0], u * az + v * perp[1]];
  // The store's customer-facing side is the south-facing long edge in the local map frame.
  const southAtMax = point(uMid, maxV)[1] > point(uMid, minV)[1];
  const side = southAtMax ? 1 : -1;
  const vFront = side > 0 ? maxV : minV;
  const box = (u: number, y: number, width: number, height: number, d: number, color: THREE.Color, vOffset = 0) => {
    const [x, z] = point(u, vFront + side * (d * 0.5 + vOffset));
    addBox(mb, x, ground + y, z, width, height, d, rot, color);
  };
  const orange = pal('seven_orange'), green = pal('seven_green'), red = pal('seven_red');
  const brown = pal('seven_brown'), brick = pal('seven_brick'), glass = pal('seven_glass');
  const white = pal('seven_white');
  const width = Math.max(12, Math.min(20, maxU - minU - 1.2));
  const left = uMid - width * 0.5, right = uMid + width * 0.5;
  // Brick end wings and dark storefront glazing echo the supplied reference photo.
  box(left + 2.0, 0.05, 4.0, 3.35, 0.10, brick, side * 0.02);
  box(right - 2.0, 0.05, 4.0, 3.35, 0.10, brick, side * 0.02);
  box(uMid, 0.85, width - 4.0, 1.85, 0.10, glass, side * 0.03);
  // Deep brown projecting fascia and the three signature stripe bands.
  box(uMid, 2.72, width, 0.72, 1.05, brown);
  for (const [y, color] of [[2.92, red], [3.15, green], [3.38, red]] as const) {
    const gap = 1.5;
    box(uMid - gap * 0.5 - (width - 2.1) * 0.25, y, (width - 2.1) * 0.42, 0.11, 0.08, color, side * 0.56);
    box(uMid + gap * 0.5 + (width - 2.1) * 0.25, y, (width - 2.1) * 0.42, 0.11, 0.08, color, side * 0.56);
  }
  // Central white sign with the red/green 7-Eleven color block motif.
  box(uMid, 3.03, 1.55, 1.18, 0.22, white, side * 0.58);
  box(uMid, 3.58, 0.78, 0.34, 0.04, red, side * 0.72);
  box(uMid, 2.78, 0.16, 0.34, 0.04, red, side * 0.72);
  box(uMid, 2.93, 0.64, 0.10, 0.04, green, side * 0.72);
  // Small canopy lip above the customer doors.
  box(uMid, 2.28, width - 3.2, 0.16, 0.9, orange);
  // A slim pole sign gives the store a recognizable silhouette at map scale.
  const signU = right - 0.9;
  box(signU, 3.6, 0.16, 2.0, 0.16, brown, side * 0.15);
  box(signU, 4.52, 0.9, 0.7, 0.22, white, side * 0.16);
  box(signU, 4.78, 0.46, 0.18, 0.04, red, side * 0.29);
  box(signU, 4.59, 0.10, 0.18, 0.04, red, side * 0.29);
  box(signU, 4.50, 0.40, 0.08, 0.04, green, side * 0.29);
}

export function extrudeBuilding(mb: MeshBuilder, feat: Feature<PolyGeom, BuildingProps>, toLocal: (x: number, y: number) => V2, groundY: number, opts: ExtrudeOptions = {}): number {
  const p = feat.properties;
  const start = mb.triCount;
  const wall = pal(p.wall_color), roof = pal(isSevenEleven(p) ? 'concrete' : p.roof_color);
  // outlines covered by their building:parts become a low plinth: still pickable, no facade, no roof
  const hidden = p.hidden === true;
  const base = groundY - 0.3 + p.min_height; // sink slightly so slopes don't show gaps
  const top = groundY + (hidden ? 0.6 : p.height);
  const roofH = hidden || p.roof_shape === 'flat' ? 0 : p.roof_height;

  for (const poly of polygons(feat.geometry)) {
    const rings = poly.map((r) => cleanRing(r).map(([x, y]) => toLocal(x, y))).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    // in local (x, z) with z = -north, signedArea>0 means CW when viewed from above (+Y). Normalize:
    // outer ring -> positive area in (x,z); holes -> negative.
    const outer = signedArea(rings[0]) < 0 ? rings[0].slice().reverse() : rings[0];
    const holes = rings.slice(1).map((r) => (signedArea(r) > 0 ? r.slice().reverse() : r));

    // walls
    const fp = hidden ? { floor: 0, style: 0 } : facadeParams(p);
    const seed = (hashStr(p.id) % 1000) / 1000;
    for (const ring of [outer, ...holes]) {
      const n = ring.length;
      let uOff = 0;
      for (let i = 0; i < n; i++) {
        const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % n];
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        // Rings are oriented: outer has positive signed area in (x, z), holes negative. For both, the building
        // mass lies to the LEFT of the edge direction, so the outward wall normal is the right-hand side.
        // (A centroid-based test breaks on concave U/L footprints and culled courtyard walls.)
        const nx = dz / len, nz = -dx / len;
        const nrm = new THREE.Vector3(nx, 0, nz);
        const a = new THREE.Vector3(x0, base, z0), b = new THREE.Vector3(x1, base, z1);
        const c2 = new THREE.Vector3(x1, top, z1), d = new THREE.Vector3(x0, top, z0);
        const sTop = 1, sBot = p.height > AO_HEIGHT ? AO_BOTTOM : THREE.MathUtils.lerp(1, AO_BOTTOM, p.height / AO_HEIGHT);
        // sun-facing walls a touch lighter: fake directional shading baked in
        const sun = 0.92 + 0.08 * Math.max(0, nx * 0.6 + nz * 0.8);
        // winding: ensure normal matches cross
        const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c2, a));
        // facade uv: u along the wall (m), v above the roofline base (m); walls under 2.5 m get no windows
        const wallH = top - base;
        const fac: [number, number, number, number] = [len < 2.5 ? 0 : fp.floor, wallH - 0.3, fp.style, seed];
        const ua: V2 = [uOff, 0], ub: V2 = [uOff + len, 0], uc: V2 = [uOff + len, wallH], ud: V2 = [uOff, wallH];
        if (cross.dot(nrm) < 0) {
          mb.triFacade(a, c2, b, wall, nrm, [sBot * sun, sTop * sun, sBot * sun], [ua, uc, ub], fac);
          mb.triFacade(a, d, c2, wall, nrm, [sBot * sun, sTop * sun, sTop * sun], [ua, ud, uc], fac);
        } else {
          mb.triFacade(a, b, c2, wall, nrm, [sBot * sun, sBot * sun, sTop * sun], [ua, ub, uc], fac);
          mb.triFacade(a, c2, d, wall, nrm, [sBot * sun, sTop * sun, sTop * sun], [ua, uc, ud], fac);
        }
        uOff += len;
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

    if (roofH > 0) {
      const done = (p.roof_shape === 'hip' || p.roof_shape === 'pyramidal') && addInsetRoof(mb, outer, top, roofH, roof, p.roof_shape === 'pyramidal');
      if (!done) addRoof(mb, outer, top, roofH, p.roof_shape, roof, wall, p.roof_azimuth ?? null, holes);
    }
    if (opts.details !== false && !hidden) {
      if (isSevenEleven(p)) addSevenElevenFacade(mb, outer, groundY);
      addRoofDetails(mb, outer, top, p, wall, roof);
    }
  }
  return mb.triCount - start;
}

/**
 * Straight-skeleton-style roof from successive mitred insets. Each annulus between ring k and ring k+1 is
 * triangulated with earcut; the last ring is capped flat (hip) or collapsed to the centroid (pyramidal).
 * Returns false when the footprint cannot be inset (then the caller falls back to the prism).
 */
function addInsetRoof(mb: MeshBuilder, outer: V2[], top: number, roofH: number, roof: THREE.Color, pyramid: boolean): boolean {
  const obb = minAreaOBB(outer);
  const maxInset = Math.max(0.5, obb.halfShort * 0.98);
  const steps = 4;
  const rings: V2[][] = [outer];
  for (let k = 1; k <= steps; k++) {
    const r = insetRing(outer, (maxInset * k) / steps);
    if (!r) break;
    rings.push(r);
  }
  if (rings.length < 2) return false;
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, shade: number) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.y < 0) { n.negate(); mb.tri(a, c, b, roof, n, shade); } else mb.tri(a, b, c, roof, n, shade);
  };
  const yAt = (k: number) => top + (roofH * k) / (rings.length - 1);
  for (let k = 0; k < rings.length - 1; k++) {
    const a = rings[k], b = rings[k + 1];
    const all = [...a, ...b];
    let idx: number[];
    try { idx = triangulate(a, [b]); } catch { return false; }
    if (!idx.length) return false;
    const y0 = yAt(k), y1 = yAt(k + 1);
    for (let i = 0; i < idx.length; i += 3) {
      const P = (j: number) => { const q = all[j]; return new THREE.Vector3(q[0], j < a.length ? y0 : y1, q[1]); };
      // slope shading by facing: light from -x/+z-ish
      const A = P(idx[i]), B = P(idx[i + 1]), C = P(idx[i + 2]);
      const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
      const shade = 0.86 + 0.14 * Math.max(0, -n.x * 0.5 + n.z * 0.5 + 0.5);
      tri(A, B, C, shade);
    }
  }
  const last = rings[rings.length - 1];
  const yTop = yAt(rings.length - 1);
  if (pyramid || last.length < 3) {
    const c = centroid(last);
    const apex = new THREE.Vector3(c[0], top + roofH, c[1]);
    for (let i = 0; i < last.length; i++) {
      const p0 = last[i], p1 = last[(i + 1) % last.length];
      tri(new THREE.Vector3(p0[0], yTop, p0[1]), new THREE.Vector3(p1[0], yTop, p1[1]), apex, 0.92);
    }
  } else {
    const idx = triangulate(last, []);
    for (let i = 0; i < idx.length; i += 3) {
      const P = (j: number) => new THREE.Vector3(last[j][0], yTop, last[j][1]);
      tri(P(idx[i]), P(idx[i + 1]), P(idx[i + 2]), 1);
    }
  }
  return true;
}

/** Oriented box of `pts` along a fixed axis direction (unit vector in local x,z). */
function boxAlongAxis(pts: V2[], ax: number, az: number): { center: V2; halfLong: number; halfShort: number } {
  const px = -az, pz = ax;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of pts) {
    const u = x * ax + z * az, v = x * px + z * pz;
    if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  return { center: [cu * ax + cv * px, cu * az + cv * pz], halfLong: (maxU - minU) / 2, halfShort: (maxV - minV) / 2 };
}

function addRoof(mb: MeshBuilder, outer: V2[], top: number, roofH: number, shape: string, roof: THREE.Color, wall: THREE.Color, azimuthDeg: number | null, holes: V2[][] = []) {
  let ax: number, az: number, L: number, S: number, cx: number, cz: number;
  const inset = 0.97;
  if (azimuthDeg != null && Number.isFinite(azimuthDeg)) {
    // LiDAR ridge azimuth: degrees clockwise from north. Local frame: x = east, z = -north.
    const rad = THREE.MathUtils.degToRad(azimuthDeg);
    ax = Math.sin(rad); az = -Math.cos(rad);
    const b = boxAlongAxis(outer, ax, az);
    L = b.halfLong * inset; S = b.halfShort * inset; [cx, cz] = b.center;
  } else {
    const obb = minAreaOBB(outer);
    [ax, az] = obb.axis;
    L = obb.halfLong * inset; S = obb.halfShort * inset; [cx, cz] = obb.center;
  }
  const px = -az, pz = ax; // perpendicular (short axis)
  if (shape === 'gable' || shape === 'skillion') {
    // The fitted bounding box supplies an axis, never the roof outline. Clip the
    // roof to the actual footprint, including concave corners and courtyards.
    const all = [...outer, ...holes.flat()], indices = triangulate(outer, holes);
    const across = (p: V2) => (p[0]-cx)*px+(p[1]-cz)*pz;
    const distances = outer.map(across), low = Math.min(...distances), high = Math.max(...distances);
    const rise = (p: V2) => {
      const v=across(p);
      return roofH * (shape==='skillion' ? (v-low)/(high-low || 1) : Math.max(0,1-Math.abs(v)/(v<0 ? -low : high || 1)));
    };
    const vertex = (p: V2) => new THREE.Vector3(p[0],top+rise(p),p[1]);
    const clip = (ring: V2[], side: number) => {
      const out: V2[]=[];
      for(let i=0;i<ring.length;i++) {
        const a=ring[i],b=ring[(i+1)%ring.length], da=across(a)*side,db=across(b)*side;
        if(da>=0) out.push(a);
        if((da>=0)!==(db>=0)) {const t=da/(da-db);out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
      }
      return out;
    };
    for(let i=0;i<indices.length;i+=3) {
      const tri=[all[indices[i]],all[indices[i+1]],all[indices[i+2]]];
      const pieces=shape==='gable' ? [clip(tri,1),clip(tri,-1)] : [tri];
      for(const piece of pieces) for(let j=1;j<piece.length-1;j++) {
        const a=vertex(piece[0]); let b=vertex(piece[j]),c=vertex(piece[j+1]);
        if(new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).y<0) [b,c]=[c,b];
        mb.tri(a,b,c,roof);
      }
    }
    for(const ring of [outer,...holes]) for(let i=0;i<ring.length;i++) {
      const a=ring[i],b=ring[(i+1)%ring.length];
      const points=[a];
      if(shape==='gable' && across(a)*across(b)<0) {const t=across(a)/(across(a)-across(b));points.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
      points.push(b);
      for(let j=0;j<points.length-1;j++) {
        const u=points[j],v=points[j+1],u0=new THREE.Vector3(u[0],top,u[1]),v0=new THREE.Vector3(v[0],top,v[1]);
        const u1=vertex(u),v1=vertex(v),n=new THREE.Vector3(v[1]-u[1],0,u[0]-v[0]).normalize();
        if(rise(v)>1e-6) mb.tri(u0,v1,v0,wall,n,0.85);
        if(rise(u)>1e-6) mb.tri(u0,u1,v1,wall,n,0.85);
      }
    }
    return;
  }
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
  opts: { details?: boolean; facade?: boolean } = {},
): { mesh: THREE.Mesh; ranges: BuildingRange[] } {
  const mb = new MeshBuilder(opts.facade !== false);
  const ranges: BuildingRange[] = [];
  for (const f of feats) {
    const outer = ccw(cleanRing(polygons(f.geometry)[0][0]));
    if (outer.length < 3) continue;
    const c = centroid(outer);
    const g = Number.isFinite(f.properties.ground_z) ? f.properties.ground_z : groundAt(c[0], c[1]);
    const start = mb.triCount;
    const count = extrudeBuilding(mb, f, toLocal, g, { details: opts.details });
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
