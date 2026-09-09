import * as THREE from 'three';
import type { TileIndex, TileMeta } from './types';
import type { Lod } from './tileBuild';

export type Want = { lod: Lod; priority: number } | null;

export interface Footprint { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number }

/** Ground footprint (y = 0 plane) of either camera, expanded by `margin` meters. */
export function cameraFootprint(camera: THREE.Camera, margin = 150): Footprint {
  const pts: THREE.Vector3[] = [];
  const ray = new THREE.Vector3(), origin = new THREE.Vector3();
  for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
    origin.set(nx, ny, -1).unproject(camera);
    ray.set(nx, ny, 1).unproject(camera).sub(origin).normalize();
    // intersect with y = 0 (fall back to a far point when the ray is parallel)
    const hit = Math.abs(ray.y) > 1e-6 ? -origin.y / ray.y : -1;
    // A low perspective view includes sky. Never project those rays behind the camera.
    const t = hit >= 0 ? Math.min(hit, 6000) : 6000;
    pts.push(origin.clone().addScaledVector(ray, t));
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/** Local-space bbox of a tile: [minX, minZ, maxX, maxZ] (z = -north). */
export function tileLocalBox(meta: TileMeta, origin: [number, number]): [number, number, number, number] {
  const [minx, miny, maxx, maxy] = meta.bbox;
  return [minx - origin[0], -(maxy - origin[1]), maxx - origin[0], -(miny - origin[1])];
}

function boxDistance(b: [number, number, number, number], fp: Footprint): number {
  const dx = Math.max(fp.minX - b[2], b[0] - fp.maxX, 0);
  const dz = Math.max(fp.minZ - b[3], b[1] - fp.maxZ, 0);
  return Math.hypot(dx, dz);
}

export interface WantOptions { lod1Radius?: number; hysteresis?: number; maxResident?: number }

/**
 * Decide the desired LOD per tile. Tiles intersecting the footprint are full; within `lod1Radius` of it are lod1;
 * the rest unload. `current` provides hysteresis so a tile on a boundary keeps its LOD until it is clearly past it.
 */
export function wantedTiles(index: TileIndex, fp: Footprint, current: Map<string, Lod>, opts: WantOptions = {}): Map<string, Want> {
  const lod1Radius = opts.lod1Radius ?? 600, hyst = opts.hysteresis ?? 80, maxResident = opts.maxResident ?? 260;
  const out = new Map<string, Want>();
  const resident: { id: string; d: number }[] = [];
  for (const meta of index.tiles) {
    const box = tileLocalBox(meta, index.origin);
    const d = boxDistance(box, fp);
    const cur = current.get(meta.id);
    const centerD = Math.hypot((box[0] + box[2]) / 2 - fp.cx, (box[1] + box[3]) / 2 - fp.cz);
    let lod: Lod | null;
    if (d <= 0 || (cur === 0 && d <= hyst)) lod = 0;
    else if (d <= lod1Radius || (cur === 1 && d <= lod1Radius + hyst)) lod = 1;
    else lod = null;
    out.set(meta.id, lod === null ? null : { lod, priority: centerD + (lod === 1 ? 1e5 : 0) });
    if (lod !== null) resident.push({ id: meta.id, d });
  }
  if (resident.length > maxResident) {
    resident.sort((a, b) => b.d - a.d);
    for (const r of resident.slice(0, resident.length - maxResident)) out.set(r.id, null);
  }
  return out;
}
