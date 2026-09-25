/** Overhead utility wires between surveyed wooden poles (pipeline/streetlights.py `utility_spans`). */
import type { Feature, LineGeom, WireProps } from './types';
import type { V2 } from './geomutil';

/** Insulator height as a share of the pole: props.ts puts them 0.4 m under the top of the 10 m model. */
export const WIRE_ATTACH = 0.96;
/** Insulators either side of the pole along the crossarm, m. */
export const WIRE_SPREAD = 0.95;
const SEGMENTS = 10;

/**
 * Line-segment positions (x, y, z pairs in the local frame) for every span: two conductors hanging in a
 * parabolic sag. An end inside the tile stands on the tile's own terrain, exactly where the pole prop stands;
 * an end in a neighbouring tile uses the span's stored (already exaggerated) ground elevation.
 */
export function buildWires(
  wires: Feature<LineGeom, WireProps>[],
  bbox: [number, number, number, number],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
): Float32Array {
  const out: number[] = [];
  const inside = (x: number, y: number) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  for (const f of wires) {
    if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
    const [[x0, y0], [x1, y1]] = [f.geometry.coordinates[0], f.geometry.coordinates[f.geometry.coordinates.length - 1]];
    const p = f.properties;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-3) continue;
    const g0 = inside(x0, y0) ? groundAt(x0, y0) : p.z0, g1 = inside(x1, y1) ? groundAt(x1, y1) : p.z1;
    const top0 = g0 + p.h0 * WIRE_ATTACH, top1 = g1 + p.h1 * WIRE_ATTACH;
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    const sag = 0.1 + 0.02 * len;
    for (const side of [-1, 1]) {
      let prev: [number, number, number] | null = null;
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        const x = x0 + (x1 - x0) * t + nx * side * WIRE_SPREAD, y = y0 + (y1 - y0) * t + ny * side * WIRE_SPREAD;
        const [lx, lz] = toLocal(x, y);
        const pt: [number, number, number] = [lx, top0 + (top1 - top0) * t - 4 * sag * t * (1 - t), lz];
        if (prev) out.push(...prev, ...pt);
        prev = pt;
      }
    }
  }
  return new Float32Array(out);
}
