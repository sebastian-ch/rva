/**
 * Vertical exaggeration of the terrain. Richmond's relief (river at ~0 m, Church Hill and Oregon Hill at ~40 m
 * above it) reads flat from an orthographic isometric camera, so every pipeline elevation is stretched by
 * Z_SCALE when a tile is loaded: the terrain grid, building ground levels, bridge deck anchors and still-water
 * levels. Building heights are not scaled (they stand true-height on the stretched ground). Anything shown to
 * the user in metres goes back through `realElev`.
 */
import type { TileLayers } from './tileBuild';

export const Z_SCALE = 1.6;

export const realElev = (y: number): number => y / Z_SCALE;

/** Scale every elevation in freshly fetched tile layers in place and return them. */
export function exaggerateLayers(l: TileLayers, k = Z_SCALE): TileLayers {
  if (k === 1) return l;
  if (l.terrain) l.terrain.elev = l.terrain.elev.map((z) => z * k);
  if (l.buildings) for (const f of l.buildings.features) if (Number.isFinite(f.properties.ground_z)) f.properties.ground_z *= k;
  for (const fc of [l.roads, l.rail]) {
    if (!fc) continue;
    for (const f of fc.features) {
      const d = f.properties.deck;
      if (Array.isArray(d) && d.length === 6) { d[2] *= k; d[5] *= k; }
      else if (typeof d === 'string') {
        try { const a = JSON.parse(d) as number[]; if (a.length === 6) { a[2] *= k; a[5] *= k; f.properties.deck = a; } } catch { /* leave */ }
      }
    }
  }
  if (l.water) for (const f of l.water.features) if (typeof f.properties.water_z === 'number') f.properties.water_z *= k;
  return l;
}
