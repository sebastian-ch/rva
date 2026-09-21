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
import type { RailPathMeta } from './traffic/trains';
import { exaggerateLayers } from './elevation';
import { scatterTile, type Placement } from './scatter';
import type { V2 } from './geomutil';
import { decodePoiTable } from './poiTable';

export type Lod = 0 | 1; // 0 = full, 1 = reduced (trees only, no roof details/facades, no markings)

/** Transferable geometry streams. Terrain keeps its index instead of expanding into triangle soup. */
export interface GeomArrays { position: Float32Array; normal: Float32Array; color: Float32Array; index?: Uint16Array | Uint32Array; uv?: Float32Array; facade?: Float32Array }

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
  /** Track centrelines for the train sim, same flattening as carPaths. */
  railPaths: Float32Array[];
  railMeta: RailPathMeta[];
  buildingFeatures: Feature<PolyGeom, BuildingProps>[];
  buildMs: number;
  /** Worker fetch + decode time and bytes received, for debug performance budgets. */
  loadMs?: number;
  sourceBytes?: number;
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
  metrics?: { loadMs: number; sourceBytes: number };
}

async function getJSON<T>(url: string, metrics: { sourceBytes: number }): Promise<T | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  // Test fetch shims may implement only json(); browsers take the byte-counted path.
  const response = r as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; json: () => Promise<unknown> };
  if (!response.arrayBuffer) return (await response.json()) as T;
  const bytes = await response.arrayBuffer();
  metrics.sourceBytes += bytes.byteLength;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function getPoiTable(url: string, bbox: TileMeta['bbox'], metrics: { sourceBytes: number }): Promise<FC<PointGeom, PoiProps> | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  const bytes = await r.arrayBuffer();
  metrics.sourceBytes += bytes.byteLength;
  return decodePoiTable(bytes, bbox);
}

export async function fetchTileLayers(meta: TileMeta, baseUrl: string, lod: Lod): Promise<TileLayers> {
  const t0 = performance.now(), metrics = { sourceBytes: 0 };
  const has = (l: string) => meta.layers.includes(l);
  const u = (l: string) => `${baseUrl}/${meta.id}/${l}`;
  const [terrain, buildings, roads, crossings, rail, landuse, water, pois] = await Promise.all([
    has('terrain') ? getJSON<TerrainGrid>(u('terrain.json'), metrics) : null,
    has('buildings') ? getJSON<FC<PolyGeom, BuildingProps>>(u('buildings.geojson'), metrics) : null,
    has('roads') ? getJSON<FC<LineGeom, RoadProps>>(u('roads.geojson'), metrics) : null,
    has('crossings') && lod === 0 ? getJSON<FC<PointGeom, CrossingProps>>(u('crossings.geojson'), metrics) : null,
    has('rail') ? getJSON<FC<LineGeom, RailProps>>(u('rail.geojson'), metrics) : null,
    has('landuse') ? getJSON<FC<PolyGeom, AreaProps>>(u('landuse.geojson'), metrics) : null,
    has('water') ? getJSON<FC<PolyGeom, AreaProps>>(u('water.geojson'), metrics) : null,
    has('pois') ? getPoiTable(u('pois.bin'), meta.bbox, metrics) : null,
  ]);
  return exaggerateLayers({ terrain, buildings, roads, crossings, rail, landuse, water, pois,
    metrics: { loadMs: performance.now() - t0, sourceBytes: metrics.sourceBytes } });
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
  const index = g.getIndex();
  if (index) out.index = index.array as Uint16Array | Uint32Array;
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
  let railPaths: Float32Array[] = [];
  let railMeta: RailPathMeta[] = [];
  if (layers.terrain) geoms.terrain = arrays(buildTerrainMesh(layers.terrain, toLocal));
  const dummy = new THREE.MeshBasicMaterial();
  if (layers.buildings?.features.length) {
    const r = buildBuildingsMesh(layers.buildings.features, toLocal, groundAt, dummy, {
      details: lod === 0,
      facade: lod === 0,
      lod2: lod === 0,
      roads: lod === 0 ? layers.roads?.features : undefined,
    });
    geoms.buildings = arrays(r.mesh.geometry);
    ranges = r.ranges;
  }
  if (layers.roads?.features.length || layers.rail?.features.length) {
    const r = buildRoads(layers.roads?.features ?? [], layers.rail?.features ?? [], layers.crossings?.features ?? [], toLocal, groundAt, { markings: lod === 0, bridges: lod === 0 });
    geoms.roads = arrays(r.roads);
    carPaths = flattenPaths(r.paths);
    carMeta = r.pathMeta;
    walkPaths = flattenPaths(r.walkPaths);
    railPaths = flattenPaths(r.railPaths);
    railMeta = r.railMeta;
  }
  if (layers.landuse?.features.length || layers.water?.features.length) {
    const a = buildAreas(layers.landuse?.features ?? [], layers.water?.features ?? [], toLocal, groundAt, 0,
      hydroField ? (x, y) => hydroField.at(x, y) : undefined);
    geoms.land = arrays(a.land);
    geoms.water = arrays(a.water);
  }
  const placements = scatterTile(meta.id, layers.pois?.features ?? [], layers.landuse?.features ?? [], layers.roads?.features ?? [], layers.buildings?.features ?? [], meta.bbox, toLocal, groundAt,
      { treesOnly: lod === 1, surveyedTrees: meta.surveyed_trees, water: layers.water?.features ?? [] });
  return { meta, lod, terrain: layers.terrain, geoms, ranges, placements, carPaths, carMeta, walkPaths, railPaths, railMeta, buildingFeatures: layers.buildings?.features ?? [], buildMs: performance.now() - t0,
    loadMs: layers.metrics?.loadMs, sourceBytes: layers.metrics?.sourceBytes };
}

/** Every ArrayBuffer inside the payload, for postMessage transfer. */
export function payloadTransferables(p: TilePayload): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of Object.values(p.geoms)) {
    if (!g) continue;
    for (const a of [g.position, g.normal, g.color, g.index, g.uv, g.facade]) if (a) out.push(a.buffer as ArrayBuffer);
  }
  for (const a of p.carPaths) out.push(a.buffer as ArrayBuffer);
  for (const a of p.walkPaths) out.push(a.buffer as ArrayBuffer);
  for (const a of p.railPaths) out.push(a.buffer as ArrayBuffer);
  return [...new Set(out)];
}
