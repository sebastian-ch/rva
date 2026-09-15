import * as THREE from 'three';
import entries from '../../assets/supplements/rooftops.json';
import { region } from './region';
import { MeshBuilder, centroid, cleanRing, minAreaOBB, pointInRing, triangulate, type V2 } from './geomutil';
import { addBox } from './roofDetails';

export interface RooftopAsset { kind: string; buildingId: string; crs: string; outline: number[][] }

const byBuilding = new Map<string, RooftopAsset[]>();
for (const asset of entries as RooftopAsset[]) {
  if (asset.crs !== region.crs) continue;
  const assets = byBuilding.get(asset.buildingId) ?? [];
  assets.push(asset);
  byBuilding.set(asset.buildingId, assets);
}

/** Data-backed rooftop assets persist at every building-detail level. */
export function rooftopAssetsFor(id: string): readonly RooftopAsset[] { return byBuilding.get(id) ?? []; }

export function addRooftopAssets(mb: MeshBuilder, assets: readonly RooftopAsset[], outer: V2[], holes: V2[][],
  toLocal: (x: number, y: number) => V2, top: number): number {
  const start = mb.triCount;
  for (const asset of assets) {
    if (asset.kind !== 'helipad') continue;
    const ring = cleanRing(asset.outline as V2[]).map(([x, y]) => toLocal(x, y));
    if (ring.length < 3) continue;
    const center = centroid(ring);
    // A centroid owner avoids duplicates when a roof crosses a tile seam.
    if (!pointInRing(center, outer) || holes.some((hole) => pointInRing(center, hole))) continue;

    const deck = new THREE.Color('#667b70'), paint = new THREE.Color('#f4eee0'), lamp = new THREE.Color('#e4bb52');
    const deckY = top + 0.65;
    const indices = triangulate(ring, []);
    const vertex = (p: V2, y: number) => new THREE.Vector3(p[0], y, p[1]);
    for (let i = 0; i < indices.length; i += 3) {
      const a = vertex(ring[indices[i]], deckY);
      let b = vertex(ring[indices[i + 1]], deckY), c = vertex(ring[indices[i + 2]], deckY);
      if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).y < 0) [b, c] = [c, b];
      mb.tri(a, b, c, deck);
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      addBox(mb, (a[0] + b[0]) / 2, top + 0.2, (a[1] + b[1]) / 2,
        Math.hypot(b[0] - a[0], b[1] - a[1]), 0.45, 0.12, Math.atan2(b[1] - a[1], b[0] - a[0]), deck);
    }
    const obb = minAreaOBB(ring), radius = Math.min(obb.halfShort, obb.halfLong) * 0.78;
    const angle = Math.atan2(obb.axis[1], obb.axis[0]), width = radius * 0.13;
    for (const sign of [-1, 1]) {
      const offset = radius * 0.38 * sign;
      addBox(mb, center[0] + Math.cos(angle) * offset, deckY + 0.02, center[1] + Math.sin(angle) * offset,
        width, 0.025, radius * 1.15, angle, paint);
    }
    addBox(mb, center[0], deckY + 0.02, center[1], radius * 0.86, 0.025, width, angle, paint);
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16, b = (i + 1) * Math.PI / 16, inner = radius - width * 0.45;
      const p = (r: number, t: number) => new THREE.Vector3(center[0] + Math.cos(t) * r, deckY + 0.04, center[1] + Math.sin(t) * r);
      mb.tri(p(radius, a), p(inner, b), p(radius, b), paint);
      mb.tri(p(radius, a), p(inner, a), p(inner, b), paint);
    }
    for (const corner of ring) addBox(mb, corner[0], deckY, corner[1], 0.35, 0.25, 0.35, 0, lamp);
  }
  return mb.triCount - start;
}
