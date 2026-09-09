import { cleanRing, hashStr, pointInRing, polygons, ringBounds, rng, signedArea, type V2 } from './geomutil';
import type { AreaProps, Feature, LineGeom, PoiProps, PointGeom, PolyGeom, RoadProps, BuildingProps } from './types';
import type { PropKind } from './props';
import { minAreaOBB } from './geomutil';

function vehicleKind(rand: () => number): PropKind {
  const r = rand();
  return r < 0.6 ? 'car' : r < 0.82 ? 'suv' : r < 0.92 ? 'pickup' : 'van';
}

export interface Placement { kind: PropKind; x: number; y: number; z: number; rot: number; scale: number }

const STREETLIGHT_SPACING = 38;
const PARK_SPACING = 7.5;  // parallel parking pitch along the curb
const STALL = 2.7, AISLE = 6.0, ROW = 5.0 + AISLE; // parking-lot stall pitch and row pitch (matches areas.ts stripes)
const TREE_DENSITY_M2 = 380; // one tree per N m^2 of park
const PERSON_SPACING = 140; // halved density: moving walkers (propPool.addWalkers) now cover most foot traffic
const STREET_TREE_SPACING = 25;
const STREET_TREE_ROAD_LENGTH_PER_TREE = 60;
const ROAD_HEADING_SEARCH_RADIUS = 20;

/** Perpendicular distance from p to segment ab, for finding the nearest road to a POI. */
function distToSegment(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx, py = a[1] + t * dy;
  return Math.hypot(p[0] - px, p[1] - py);
}

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

  // Cheap "nearest road direction" lookup for orienting POI-placed props (e.g. traffic lights).
  const roadSegments: { a: V2; b: V2; heading: number; clearance: number }[] = [];
  for (const f of roads) {
    const coords = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of coords) {
      const c = cleanRing(line);
      for (let i = 0; i < c.length - 1; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-6) continue;
        const dx = (x1 - x0) / len, dy = (y1 - y0) / len;
        roadSegments.push({ a: c[i], b: c[i + 1], heading: Math.atan2(dx, -dy), clearance: f.properties.width / 2 + 2 });
      }
    }
  }
  const nearestRoadHeading = (x: number, y: number): number | undefined => {
    let best = Infinity, heading: number | undefined;
    for (const s of roadSegments) {
      const d = distToSegment([x, y], s.a, s.b);
      if (d < best) { best = d; heading = s.heading; }
    }
    return best <= ROAD_HEADING_SEARCH_RADIUS ? heading : undefined;
  };

  // Extra street trees are only added when OSM-surveyed tree POIs are sparse relative to
  // the amount of residential/living-street frontage in this tile.
  let residentialLen = 0;
  for (const f of roads) {
    const p = f.properties;
    if (p.tunnel || p.bridge) continue;
    if (p.highway !== 'residential' && p.highway !== 'living_street') continue;
    const coords = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of coords) {
      const c = cleanRing(line);
      for (let i = 0; i < c.length - 1; i++) residentialLen += Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
    }
  }

  // 1. surveyed POIs
  let osmTreeCount = 0;
  for (const p of pois) {
    const [x, y] = p.geometry.coordinates;
    const k = p.properties.kind;
    if (k === 'tree') {
      osmTreeCount++;
      place(rand() < 0.5 ? 'tree' : 'tree_round', x, y, undefined, 0.85 + rand() * 0.5);
    } else if (k === 'streetlight') place('streetlight', x, y);
    else if (k === 'bench') place('bench', x, y);
    else if (k === 'bus_stop') place('person', x, y);
    else if (k === 'traffic_signals') place('traffic_light', x, y, nearestRoadHeading(x, y));
    else if (k === 'fountain') place('fountain', x, y);
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
      const density = f.properties.coastal ? 110
        : kind === 'forest' ? TREE_DENSITY_M2 / 3 : kind === 'grass' ? TREE_DENSITY_M2 * 3 : TREE_DENSITY_M2;
      const n = Math.min(400, Math.floor(area / density));
      const [minx, miny, maxx, maxy] = ringBounds(outer);
      let tries = 0;
      for (let i = 0; i < n && tries < n * 8; tries++) {
        const x = minx + rand() * (maxx - minx), y = miny + rand() * (maxy - miny);
        if (!pointInRing([x, y], outer) || holes.some((h) => pointInRing([x, y], h))) continue;
        if (f.properties.coastal && roadSegments.some((s) => distToSegment([x, y], s.a, s.b) < s.clearance)) continue;
        place(rand() < 0.6 ? 'tree_round' : 'tree', x, y, undefined, 0.8 + rand() * 0.7);
        i++;
      }
    }
  }

  // 2b. parked cars in surface lots, in the stalls painted by areas.ts (rows along the lot's long axis)
  for (const f of landuse) {
    if (f.properties.kind !== 'parking') continue;
    for (const poly of polygons(f.geometry)) {
      const outer = cleanRing(poly[0]);
      if (outer.length < 3) continue;
      const area = Math.abs(signedArea(outer));
      if (area < 400 || area > 60000) continue;
      const holes = poly.slice(1).map(cleanRing);
      const obb = minAreaOBB(outer);
      const [ax, ay] = obb.axis, px = -ay, py = ax;
      const [cx, cy] = obb.center;
      const rowHeading = Math.atan2(py, px); // cars park across the row, nose toward the aisle
      let placed = 0;
      for (let v = -obb.halfShort + 3; v < obb.halfShort - 3 && placed < 60; v += ROW) {
        for (let u = -obb.halfLong + 2 + STALL / 2; u < obb.halfLong - 2; u += STALL) {
          if (rand() > 0.3) continue;
          const x = cx + ax * u + px * (v + 2.5), y = cy + ay * u + py * (v + 2.5);
          if (!pointInRing([x, y], outer) || holes.some((h) => pointInRing([x, y], h))) continue;
          place(vehicleKind(rand), x, y, rowHeading + (rand() < 0.5 ? 0 : Math.PI));
          placed++;
        }
      }
    }
  }

  // 3. along roads: streetlights on the sidewalk edge, parked cars at the curb, a few pedestrians,
  //    and (when tree POIs are sparse) extra street trees on residential streets
  const addStreetTrees = osmTreeCount < residentialLen / STREET_TREE_ROAD_LENGTH_PER_TREE;
  for (const f of roads) {
    const p = f.properties;
    if (p.tunnel || p.bridge) continue;
    const major = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'trunk'].includes(p.highway);
    const walk = p.highway === 'footway' || p.highway === 'pedestrian';
    const isStreetTreeRoad = addStreetTrees && (p.highway === 'residential' || p.highway === 'living_street');
    if (!major && !walk && !isStreetTreeRoad) continue;
    const coords = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of coords) {
      const c = cleanRing(line);
      let acc = rand() * STREETLIGHT_SPACING, accCar = rand() * PARK_SPACING, accP = rand() * PERSON_SPACING;
      let accTree = rand() * STREET_TREE_SPACING;
      let treeSide: 1 | -1 = rand() < 0.5 ? 1 : -1;
      for (let i = 0; i < c.length - 1; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1e-6) continue;
        const dx = (x1 - x0) / len, dy = (y1 - y0) / len;
        const nx = -dy, ny = dx;
        // local frame: x = east, z = -north. Rotation about Y that maps +X to the travel direction (dx, dz=-dy):
        const heading = Math.atan2(dy, dx); // = atan2(-dz, dx)
        let t = 0;
        while (t < len) {
          const step = Math.min(len - t, 5);
          t += step; acc += step; accCar += step; accP += step; accTree += step;
          const x = x0 + dx * t, y = y0 + dy * t;
          if (major && acc >= STREETLIGHT_SPACING) {
            acc = 0;
            const side = rand() < 0.5 ? 1 : -1;
            place('streetlight', x + nx * side * (p.width / 2 + 0.8), y + ny * side * (p.width / 2 + 0.8), heading + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
          }
          // parked cars: only at the curb of roads wide enough for a parking lane (traffic uses the inner lanes)
          if (major && p.width >= 9 && accCar >= PARK_SPACING && rand() < 0.4) {
            accCar = 0;
            const side = rand() < 0.5 ? 1 : -1;
            const off = p.width / 2 - 1.1;
            place(vehicleKind(rand), x + nx * side * off, y + ny * side * off, heading + (side > 0 ? 0 : Math.PI));
          }
          if ((major || walk) && accP >= PERSON_SPACING && rand() < 0.5) {
            accP = 0;
            const side = rand() < 0.5 ? 1 : -1;
            const off = walk ? 0 : p.width / 2 + 1.5;
            place('person', x + nx * side * off, y + ny * side * off);
          }
          if (isStreetTreeRoad && accTree >= STREET_TREE_SPACING) {
            accTree = 0;
            const off = p.width / 2 + 2.5;
            place(rand() < 0.6 ? 'tree_round' : 'tree', x + nx * treeSide * off, y + ny * treeSide * off, undefined, 0.8 + rand() * 0.5);
            treeSide = treeSide > 0 ? -1 : 1; // alternate sides
          }
        }
      }
    }
  }
  return out;
}
