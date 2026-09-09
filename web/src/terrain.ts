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
