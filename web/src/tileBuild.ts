/**
 * Pure tile geometry build: runs in a worker (tileWorker.ts) or on the main thread as a fallback.
 * Produces plain typed arrays so the result can be transferred without copying.
 */
import * as THREE from 'three';
import type { AreaProps, BuildingProps, CrossingProps, FC, Feature, LineGeom, PoiProps, PointGeom, PolyGeom, RailProps, RoadProps, TerrainGrid, TileMeta } from './types';
import { HeightField, FLAT_FIELD, buildTerrainMesh } from './terrain';
import { buildBuildingsMesh, type BuildingRange } from './buildings';
import { buildRoads } from './roads';
import { buildAreas } from './areas';
import type { CarPathMeta } from './traffic/graph';
import { exaggerateLayers } from './elevation';
import { scatterTile, type Placement } from './scatter';
import type { V2 } from './geomutil';

export type Lod = 0 | 1; // 0 = full, 1 = reduced (trees only, no roof details/facades, no markings)

export interface GeomArrays { position: Float32Array; normal: Float32Array; color: Float32Array; uv?: Float32Array; facade?: Float32Array }

export interface TilePayload {
  meta: TileMeta;
  lod: Lod;
  terrain: TerrainGrid | null;
  geoms: { terrain?: GeomArrays; buildings?: GeomArrays; roads?: GeomArrays; land?: GeomArrays; water?: GeomArrays };
  ranges: BuildingRange[];
  placements: Placement[];
  /** Car paths flattened: each path is a Float32Array of xyz triples. */
  carPaths: Float32Array[];
  /** per car path: one-way, width, class, way id (see traffic/graph CarPathMeta) */
  carMeta: CarPathMeta[];
  /** Pedestrian (sidewalk + footway/pedestrian/path) centrelines, same flattening as carPaths. */
  walkPaths: Float32Array[];
  buildingFeatures: Feature<PolyGeom, BuildingProps>[];
  buildMs: number;
}

export interface TileLayers {
  terrain: TerrainGrid | null;
  buildings: FC<PolyGeom, BuildingProps> | null;
  roads: FC<LineGeom, RoadProps> | null;
  crossings: FC<PointGeom, CrossingProps> | null;
  rail: FC<LineGeom, RailProps> | null;
  landuse: FC<PolyGeom, AreaProps> | null;
  water: FC<PolyGeom, AreaProps> | null;
  pois: FC<PointGeom, PoiProps> | null;
}

async function getJSON<T>(url: string): Promise<T | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  return (await r.json()) as T;
}

export async function fetchTileLayers(meta: TileMeta, baseUrl: string, lod: Lod): Promise<TileLayers> {
  const has = (l: string) => meta.layers.includes(l);
  const u = (l: string) => `${baseUrl}/${meta.id}/${l}`;
  const [terrain, buildings, roads, crossings, rail, landuse, water, pois] = await Promise.all([
    has('terrain') ? getJSON<TerrainGrid>(u('terrain.json')) : null,
    has('buildings') ? getJSON<FC<PolyGeom, BuildingProps>>(u('buildings.geojson')) : null,
    has('roads') ? getJSON<FC<LineGeom, RoadProps>>(u('roads.geojson')) : null,
    has('crossings') && lod === 0 ? getJSON<FC<PointGeom, CrossingProps>>(u('crossings.geojson')) : null,
    has('rail') ? getJSON<FC<LineGeom, RailProps>>(u('rail.geojson')) : null,
    has('landuse') ? getJSON<FC<PolyGeom, AreaProps>>(u('landuse.geojson')) : null,
    has('water') ? getJSON<FC<PolyGeom, AreaProps>>(u('water.geojson')) : null,
    has('pois') ? getJSON<FC<PointGeom, PoiProps>>(u('pois.geojson')) : null,
  ]);
  return exaggerateLayers({ terrain, buildings, roads, crossings, rail, landuse, water, pois });
}

function arrays(g: THREE.BufferGeometry): GeomArrays | undefined {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) return undefined;
  const out: GeomArrays = {
    position: pos.array as Float32Array,
    normal: (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array,
    color: (g.getAttribute('color') as THREE.BufferAttribute).array as Float32Array,
  };
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const fac = g.getAttribute('facade') as THREE.BufferAttribute | undefined;
  if (uv) out.uv = uv.array as Float32Array;
  if (fac) out.facade = fac.array as Float32Array;
  return out;
}

/** Flatten Vector3 polylines into per-path Float32Arrays of xyz triples. */
function flattenPaths(paths: THREE.Vector3[][]): Float32Array[] {
  return paths.map((p) => {
    const a = new Float32Array(p.length * 3);
    p.forEach((v, i) => { a[i * 3] = v.x; a[i * 3 + 1] = v.y; a[i * 3 + 2] = v.z; });
    return a;
  });
}

/** Terrain grids are indexed; expand to a triangle soup so every layer shares one wrap path. */
function soup(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return g.getIndex() ? g.toNonIndexed() : g;
}

export function buildTilePayload(meta: TileMeta, layers: TileLayers, origin: [number, number], lod: Lod): TilePayload {
  const t0 = performance.now();
  const toLocal = (x: number, y: number): V2 => [x - origin[0], -(y - origin[1])];
  const field = layers.terrain ? new HeightField(layers.terrain) : FLAT_FIELD(0);
  const groundAt = (x: number, y: number) => field.at(x, y);
  const hydroField = layers.terrain?.water_elev ? new HeightField({ ...layers.terrain, elev: layers.terrain.water_elev }) : null;
  const geoms: TilePayload['geoms'] = {};
  let ranges: BuildingRange[] = [];
  let carPaths: Float32Array[] = [];
  let carMeta: CarPathMeta[] = [];
  let walkPaths: Float32Array[] = [];
  if (layers.terrain) geoms.terrain = arrays(soup(buildTerrainMesh(layers.terrain, toLocal)));
  const dummy = new THREE.MeshBasicMaterial();
  if (layers.buildings?.features.length) {
    const r = buildBuildingsMesh(layers.buildings.features, toLocal, groundAt, dummy, { details: lod === 0, facade: lod === 0 });
    geoms.buildings = arrays(r.mesh.geometry);
    ranges = r.ranges;
  }
  if (layers.roads?.features.length || layers.rail?.features.length) {
    const r = buildRoads(layers.roads?.features ?? [], layers.rail?.features ?? [], layers.crossings?.features ?? [], toLocal, groundAt, { markings: lod === 0, bridges: lod === 0 });
    geoms.roads = arrays(r.roads);
    carPaths = flattenPaths(r.paths);
    carMeta = r.pathMeta;
    walkPaths = flattenPaths(r.walkPaths);
  }
  if (layers.landuse?.features.length || layers.water?.features.length) {
    const a = buildAreas(layers.landuse?.features ?? [], layers.water?.features ?? [], toLocal, groundAt, 0,
      hydroField ? (x, y) => hydroField.at(x, y) : undefined);
    geoms.land = arrays(a.land);
    geoms.water = arrays(a.water);
  }
  const placements = scatterTile(meta.id, layers.pois?.features ?? [], layers.landuse?.features ?? [], layers.roads?.features ?? [], layers.buildings?.features ?? [], meta.bbox, toLocal, groundAt,
      { treesOnly: lod === 1, surveyedTrees: meta.surveyed_trees, water: layers.water?.features ?? [] });
  return { meta, lod, terrain: layers.terrain, geoms, ranges, placements, carPaths, carMeta, walkPaths, buildingFeatures: layers.buildings?.features ?? [], buildMs: performance.now() - t0 };
}

/** Every ArrayBuffer inside the payload, for postMessage transfer. */
export function payloadTransferables(p: TilePayload): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of Object.values(p.geoms)) {
    if (!g) continue;
    for (const a of [g.position, g.normal, g.color, g.uv, g.facade]) if (a) out.push(a.buffer as ArrayBuffer);
  }
  for (const a of p.carPaths) out.push(a.buffer as ArrayBuffer);
  for (const a of p.walkPaths) out.push(a.buffer as ArrayBuffer);
  return [...new Set(out)];
}
