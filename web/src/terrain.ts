import * as THREE from 'three';
import type { TerrainGrid } from './types';
import { hex } from './props';

/** Triangle-matched height lookup over a tile's elevation grid, in tile-local projected meters. */
export class HeightField {
  readonly n: number;
  readonly step: number;
  constructor(readonly grid: TerrainGrid) {
    this.n = grid.n;
    this.step = grid.size / (grid.n - 1);
  }
  /** x, y in projected CRS meters (not web-local). */
  at(x: number, y: number): number {
    const g = this.grid;
    const fx = THREE.MathUtils.clamp((x - g.origin[0]) / this.step, 0, this.n - 1.0001);
    const fy = THREE.MathUtils.clamp((y - g.origin[1]) / this.step, 0, this.n - 1.0001);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const e = g.elev, n = this.n;
    const a = e[iy * n + ix], b = e[iy * n + ix + 1], c = e[(iy + 1) * n + ix], d = e[(iy + 1) * n + ix + 1];
    // Match buildTerrainMesh's a-b-c / b-d-c diagonal. Bilinear interpolation
    // described a different surface and exposed terrain through parks and roads.
    return tx + ty <= 1 ? a + (b-a)*tx + (c-a)*ty : d + (c-d)*(1-tx) + (b-d)*(1-ty);
  }
  /** Cut triangle abc (projected metres) along the rendered terrain triangles. Each convex piece lies on one of
   * them, so its corners' `at` heights describe the surface exactly. Pieces past the grid edge stay attached to the
   * outermost cells rather than being dropped. */
  clipToCells(tri: [number, number][]): [number, number][][] {
    const g = this.grid, s = this.step, m = this.n - 1;
    const p = tri.map(([x, y]): [number, number] => [(x - g.origin[0]) / s, (y - g.origin[1]) / s]);
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const cx0 = Math.max(0, Math.floor(Math.min(...xs))), cx1 = Math.min(m - 1, Math.ceil(Math.max(...xs)) - 1);
    const cy0 = Math.max(0, Math.floor(Math.min(...ys))), cy1 = Math.min(m - 1, Math.ceil(Math.max(...ys)) - 1);
    const out: [number, number][][] = [];
    for (let iy = cy0; iy <= cy1; iy++) for (let ix = cx0; ix <= cx1; ix++) {
      let cell = p;
      if (ix > 0) cell = clipHalf(cell, 1, 0, -ix);
      if (ix < m - 1) cell = clipHalf(cell, -1, 0, ix + 1);
      if (iy > 0) cell = clipHalf(cell, 0, 1, -iy);
      if (iy < m - 1) cell = clipHalf(cell, 0, -1, iy + 1);
      if (cell.length < 3) continue;
      // buildTerrainMesh splits each cell along its b-c diagonal, x + y = ix + iy + 1 in grid units.
      for (const side of [1, -1]) {
        const piece = clipHalf(cell, -side, -side, side * (ix + iy + 1));
        if (piece.length >= 3 && Math.abs(ringArea(piece)) > 1e-9) out.push(piece.map(([x, y]) => [g.origin[0] + x * s, g.origin[1] + y * s]));
      }
    }
    return out;
  }
}

/** Sutherland-Hodgman: keep the part of a convex polygon where a·x + b·y + c >= 0. */
function clipHalf(poly: [number, number][], a: number, b: number, c: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const u = poly[i], v = poly[(i + 1) % poly.length];
    const fu = a * u[0] + b * u[1] + c, fv = a * v[0] + b * v[1] + c;
    if (fu >= 0) out.push(u);
    if ((fu >= 0) !== (fv >= 0)) { const t = fu / (fu - fv); out.push([u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t]); }
  }
  return out;
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const u = r[i], v = r[(i + 1) % r.length]; a += u[0] * v[1] - v[0] * u[1]; }
  return a / 2;
}

export const FLAT_FIELD = (z = 0): HeightField =>
  new HeightField({ size: 250, n: 2, origin: [-1e9, -1e9], elev: [z, z, z, z] });

/** Build the ground mesh for one tile. toLocal maps projected (x,y) -> [lx, lz]. */
export function buildTerrainMesh(grid: TerrainGrid, toLocal: (x: number, y: number) => [number, number]): THREE.BufferGeometry {
  const n = grid.n, step = grid.size / (n - 1);
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const ground = hex('ground'), grass = hex('grass');
  const tmp = new THREE.Color();
  let zmin = Infinity, zmax = -Infinity;
  for (const z of grid.elev) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iy * n + ix;
      const [lx, lz] = toLocal(grid.origin[0] + ix * step, grid.origin[1] + iy * step);
      const z = grid.elev[i];
      pos[i * 3] = lx; pos[i * 3 + 1] = z; pos[i * 3 + 2] = lz;
      // subtle tint: lower ground a touch greener (river flats), higher a touch sandier
      const t = zmax > zmin ? (z - zmin) / (zmax - zmin) : 0.5;
      tmp.copy(grass).lerp(ground, 0.75 + 0.25 * t);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
  }
  const idx: number[] = [];
  for (let iy = 0; iy < n - 1; iy++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      // lz = -northing, so rows increase toward -Z: wind so normals face +Y
      idx.push(a, b, c, b, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  // if normals came out downward, flip winding
  const ny = (geom.getAttribute('normal') as THREE.BufferAttribute).getY(0);
  if (ny < 0) {
    const arr = geom.getIndex()!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; }
    geom.computeVertexNormals();
  }
  return geom;
}
