import * as THREE from 'three';
import type { AreaProps, BuildingProps, Feature, CrossingProps, FC, LineGeom, PoiProps, PointGeom, PolyGeom, RailProps, RoadProps, TerrainGrid, TileIndex, TileMeta } from './types';
import { HeightField, FLAT_FIELD, buildTerrainMesh } from './terrain';
import { buildBuildingsMesh, type BuildingRange } from './buildings';
import { buildRoads } from './roads';
import { buildAreas } from './areas';
import { scatterTile, type Placement } from './scatter';
import type { V2 } from './geomutil';

export interface LoadedTile {
  meta: TileMeta;
  group: THREE.Group;
  buildings: THREE.Mesh | null;
  ranges: BuildingRange[];
  carPaths: THREE.Vector3[][];
  placements: Placement[];
  field: HeightField;
  buildingFeatures: Map<string, Feature<PolyGeom, BuildingProps>>;
}

export interface Materials {
  terrain: THREE.Material; buildings: THREE.Material; roads: THREE.Material; land: THREE.Material; water: THREE.Material;
}

async function getJSON<T>(url: string): Promise<T | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  return (await r.json()) as T;
}

export class TileWorld {
  readonly toLocal: (x: number, y: number) => V2;
  constructor(readonly index: TileIndex, readonly materials: Materials, readonly baseUrl = '/tiles') {
    const [ox, oy] = index.origin;
    this.toLocal = (x, y) => [x - ox, -(y - oy)];
  }

  /** Center of the study area in local coords. */
  center(): THREE.Vector3 {
    const [minx, miny, maxx, maxy] = this.index.bbox_proj;
    const [lx, lz] = this.toLocal((minx + maxx) / 2, (miny + maxy) / 2);
    return new THREE.Vector3(lx, 0, lz);
  }

  async load(meta: TileMeta): Promise<LoadedTile> {
    const has = (l: string) => meta.layers.includes(l);
    const u = (l: string) => `${this.baseUrl}/${meta.id}/${l}`;
    const [terrain, buildings, roads, crossings, rail, landuse, water, pois] = await Promise.all([
      has('terrain') ? getJSON<TerrainGrid>(u('terrain.json')) : null,
      has('buildings') ? getJSON<FC<PolyGeom, BuildingProps>>(u('buildings.geojson')) : null,
      has('roads') ? getJSON<FC<LineGeom, RoadProps>>(u('roads.geojson')) : null,
      has('crossings') ? getJSON<FC<PointGeom, CrossingProps>>(u('crossings.geojson')) : null,
      has('rail') ? getJSON<FC<LineGeom, RailProps>>(u('rail.geojson')) : null,
      has('landuse') ? getJSON<FC<PolyGeom, AreaProps>>(u('landuse.geojson')) : null,
      has('water') ? getJSON<FC<PolyGeom, AreaProps>>(u('water.geojson')) : null,
      has('pois') ? getJSON<FC<PointGeom, PoiProps>>(u('pois.geojson')) : null,
    ]);
    const field = terrain ? new HeightField(terrain) : FLAT_FIELD(0);
    const groundAt = (x: number, y: number) => field.at(x, y);
    const group = new THREE.Group();
    group.name = `tile:${meta.id}`;
    const m = this.materials;

    if (terrain) {
      const g = buildTerrainMesh(terrain, this.toLocal);
      const mesh = new THREE.Mesh(g, m.terrain);
      mesh.name = 'terrain';
      group.add(mesh);
    }
    let bmesh: THREE.Mesh | null = null;
    let ranges: BuildingRange[] = [];
    if (buildings?.features.length) {
      const r = buildBuildingsMesh(buildings.features, this.toLocal, groundAt, m.buildings);
      bmesh = r.mesh; ranges = r.ranges;
      bmesh.name = 'buildings';
      group.add(bmesh);
    }
    let carPaths: THREE.Vector3[][] = [];
    if (roads?.features.length || rail?.features.length) {
      const r = buildRoads(roads?.features ?? [], rail?.features ?? [], crossings?.features ?? [], this.toLocal, groundAt);
      const mesh = new THREE.Mesh(r.roads, m.roads);
      mesh.name = 'roads';
      group.add(mesh);
      carPaths = r.paths;
    }
    if (landuse?.features.length || water?.features.length) {
      const a = buildAreas(landuse?.features ?? [], water?.features ?? [], this.toLocal, groundAt, 0);
      if (a.land.getAttribute('position')?.count) group.add(Object.assign(new THREE.Mesh(a.land, m.land), { name: 'land' }));
      if (a.water.getAttribute('position')?.count) group.add(Object.assign(new THREE.Mesh(a.water, m.water), { name: 'water' }));
    }
    const placements = scatterTile(meta.id, pois?.features ?? [], landuse?.features ?? [], roads?.features ?? [],
      buildings?.features ?? [], meta.bbox, this.toLocal, groundAt);
    const buildingFeatures = new Map((buildings?.features ?? []).map((f) => [f.properties.id, f]));
    return { meta, group, buildings: bmesh, ranges, carPaths, placements, field, buildingFeatures };
  }
}
