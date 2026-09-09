export interface TileMeta {
  id: string;
  x: number;
  y: number;
  bbox: [number, number, number, number];
  layers: string[];
  counts: Record<string, number>;
}
export interface TileIndex {
  crs: string;
  tile_size: number;
  origin: [number, number];
  grid: [number, number];
  bbox_wgs84: [number, number, number, number];
  bbox_proj: [number, number, number, number];
  base_elevation: number;
  tiles: TileMeta[];
}
export interface TerrainGrid {
  size: number;
  n: number;
  origin: [number, number];
  elev: number[];
}
export type Ring = [number, number][];
export type PolygonCoords = Ring[];
export interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
export interface FC<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}
export type PolyGeom = { type: 'Polygon'; coordinates: PolygonCoords } | { type: 'MultiPolygon'; coordinates: PolygonCoords[] };
export type LineGeom = { type: 'LineString'; coordinates: Ring } | { type: 'MultiLineString'; coordinates: Ring[] };
export type PointGeom = { type: 'Point'; coordinates: [number, number] };

export type RoofShape = 'flat' | 'gable' | 'hip' | 'pyramidal' | 'skillion' | 'dome';
export interface BuildingProps {
  id: string;
  name: string | null;
  height: number;
  min_height: number;
  levels: number | null;
  height_source: string;
  roof_shape: RoofShape;
  roof_height: number;
  roof_color: string;
  wall_color: string;
  type: string;
  landmark: string | null;
  addr: string | null;
  wikidata: string | null;
  website: string | null;
  ground_z: number;
}
export interface RoadProps {
  id: string; name: string | null; highway: string; lanes: number | null; width: number;
  oneway: boolean; surface: string | null; sidewalk: boolean; bridge: boolean; tunnel: boolean; layer: number;
}
export interface RailProps { id: string; name: string | null; railway: string; bridge: boolean; layer: number }
export interface AreaProps { id: string; name: string | null; kind: string }
export interface PoiProps { id: string; name: string | null; kind: string }
export interface CrossingProps { id: string; crossing: string }

export interface Landmark {
  slug: string; name: string; lat: number; lon: number; kind: string; wikidata: string | null;
  website: string | null; description: string; district: string; in_first_slice: boolean; model: string | null;
}
