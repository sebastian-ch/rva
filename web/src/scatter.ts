import { cleanRing, hashStr, pointInRing, polygons, ringBounds, rng, signedArea, type V2 } from './geomutil';
import type { AreaProps, Feature, LineGeom, PoiProps, PointGeom, PolyGeom, RoadProps, BuildingProps } from './types';
import type { PropKind } from './props';

export interface Placement { kind: PropKind; x: number; y: number; z: number; rot: number; scale: number }

const STREETLIGHT_SPACING = 38;
const CAR_SPACING = 55;
const TREE_DENSITY_M2 = 380; // one tree per N m^2 of park
const PERSON_SPACING = 70;

/** Decide where props go for one tile. Everything is deterministic per tile id. */
export function scatterTile(
  tileId: string,
  pois: Feature<PointGeom, PoiProps>[],
  landuse: Feature<PolyGeom, AreaProps>[],
  roads: Feature<LineGeom, RoadProps>[],
  buildings: Feature<PolyGeom, BuildingProps>[],
  bbox: [number, number, number, number],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
): Placement[] {
  const rand = rng(hashStr(tileId));
  const out: Placement[] = [];
  const footprints = buildings.flatMap((b) => polygons(b.geometry).map((p) => cleanRing(p[0])));
  const fpBounds = footprints.map(ringBounds);
  const inBuilding = (x: number, y: number) => {
    for (let i = 0; i < footprints.length; i++) {
      const b = fpBounds[i];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRing([x, y], footprints[i])) return true;
    }
    return false;
  };
  const inTile = (x: number, y: number) => x >= bbox[0] && x < bbox[2] && y >= bbox[1] && y < bbox[3];
  const place = (kind: PropKind, x: number, y: number, rot = rand() * Math.PI * 2, scale = 1) => {
    if (!inTile(x, y) || inBuilding(x, y)) return;
    const [lx, lz] = toLocal(x, y);
    out.push({ kind, x: lx, y: groundAt(x, y), z: lz, rot, scale });
  };

  // 1. surveyed POIs
  for (const p of pois) {
    const [x, y] = p.geometry.coordinates;
    const k = p.properties.kind;
    if (k === 'tree') place(rand() < 0.5 ? 'tree' : 'tree_round', x, y, undefined, 0.85 + rand() * 0.5);
    else if (k === 'streetlight') place('streetlight', x, y);
    else if (k === 'bench') place('bench', x, y);
    else if (k === 'bus_stop') place('person', x, y);
  }

  // 2. trees in parks/cemeteries/forests
  for (const f of landuse) {
    const kind = f.properties.kind;
    if (!['park', 'cemetery', 'forest', 'grass'].includes(kind)) continue;
    for (const poly of polygons(f.geometry)) {
      const outer = cleanRing(poly[0]);
      if (outer.length < 3) continue;
      const holes = poly.slice(1).map(cleanRing);
      const area = Math.abs(signedArea(outer));
      const density = kind === 'forest' ? TREE_DENSITY_M2 / 3 : kind === 'grass' ? TREE_DENSITY_M2 * 3 : TREE_DENSITY_M2;
      const n = Math.min(400, Math.floor(area / density));
      const [minx, miny, maxx, maxy] = ringBounds(outer);
      let tries = 0;
      for (let i = 0; i < n && tries < n * 8; tries++) {
        const x = minx + rand() * (maxx - minx), y = miny + rand() * (maxy - miny);
        if (!pointInRing([x, y], outer) || holes.some((h) => pointInRing([x, y], h))) continue;
        place(rand() < 0.6 ? 'tree_round' : 'tree', x, y, undefined, 0.8 + rand() * 0.7);
        i++;
      }
    }
  }

  // 3. along roads: streetlights on the sidewalk edge, cars in lanes, a few pedestrians
  for (const f of roads) {
    const p = f.properties;
    if (p.tunnel || p.bridge) continue;
    const major = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'trunk'].includes(p.highway);
    const walk = p.highway === 'footway' || p.highway === 'pedestrian';
    if (!major && !walk) continue;
    const coords = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of coords) {
      const c = cleanRing(line);
      let acc = rand() * STREETLIGHT_SPACING, accCar = rand() * CAR_SPACING, accP = rand() * PERSON_SPACING;
      for (let i = 0; i < c.length - 1; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-6) continue;
        const dx = (x1 - x0) / len, dy = (y1 - y0) / len;
        const nx = -dy, ny = dx;
        const heading = Math.atan2(dx, -dy); // local rotation about Y (z = -north)
        let t = 0;
        while (t < len) {
          const step = Math.min(len - t, 5);
          t += step; acc += step; accCar += step; accP += step;
          const x = x0 + dx * t, y = y0 + dy * t;
          if (major && acc >= STREETLIGHT_SPACING) {
            acc = 0;
            const side = rand() < 0.5 ? 1 : -1;
            place('streetlight', x + nx * side * (p.width / 2 + 0.8), y + ny * side * (p.width / 2 + 0.8), heading + (side > 0 ? Math.PI : 0));
          }
          if (major && accCar >= CAR_SPACING && rand() < 0.55) {
            accCar = 0;
            const side = p.oneway ? 1 : rand() < 0.5 ? 1 : -1;
            const off = Math.min(p.width / 2 - 1.2, 1.7);
            place('car', x + nx * side * off, y + ny * side * off, heading + (side > 0 ? 0 : Math.PI));
          }
          if ((major || walk) && accP >= PERSON_SPACING && rand() < 0.5) {
            accP = 0;
            const side = rand() < 0.5 ? 1 : -1;
            const off = walk ? 0 : p.width / 2 + 1.5;
            place('person', x + nx * side * off, y + ny * side * off);
          }
        }
      }
    }
  }
  return out;
}
