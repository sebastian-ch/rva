import * as THREE from 'three';
import type { CarPathMeta } from './traffic/graph';
import type { BuildingProps, Feature, PolyGeom, TileIndex, TileMeta } from './types';
import { HeightField, FLAT_FIELD } from './terrain';
import type { BuildingRange } from './buildings';
import type { Placement } from './scatter';
import type { GeomArrays, Lod, TilePayload } from './tileBuild';
import type { V2 } from './geomutil';

export interface LoadedTile {
  meta: TileMeta;
  lod: Lod;
  group: THREE.Group;
  buildings: THREE.Mesh | null;
  ranges: BuildingRange[];
  carPaths: THREE.Vector3[][];
  carMeta: CarPathMeta[];
  walkPaths: THREE.Vector3[][];
  placements: Placement[];
  field: HeightField;
  buildingFeatures: Map<string, Feature<PolyGeom, BuildingProps>>;
  triangles: number;
}

export interface Materials {
  terrain: THREE.Material; buildings: THREE.Material; roads: THREE.Material; land: THREE.Material; water: THREE.Material;
}

export function geometryFromArrays(g: GeomArrays): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(g.color, 3));
  if (g.uv) geom.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
  if (g.facade) geom.setAttribute('facade', new THREE.BufferAttribute(g.facade, 4));
  return geom;
}

/** Main-thread side: turn a worker payload into meshes. Cheap (no geometry math). */
export function wrapTilePayload(p: TilePayload, materials: Materials): LoadedTile {
  const group = new THREE.Group();
  group.name = `tile:${p.meta.id}`;
  let triangles = 0;
  const add = (name: string, g: GeomArrays | undefined, mat: THREE.Material, shadows: 'cast' | 'receive'): THREE.Mesh | null => {
    if (!g || g.position.length === 0) return null;
    const mesh = new THREE.Mesh(geometryFromArrays(g), mat);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    if (shadows === 'cast') mesh.castShadow = true;
    group.add(mesh);
    triangles += g.position.length / 9;
    return mesh;
  };
  add('terrain', p.geoms.terrain, materials.terrain, 'receive');
  const buildings = add('buildings', p.geoms.buildings, materials.buildings, 'cast');
  add('roads', p.geoms.roads, materials.roads, 'receive');
  add('land', p.geoms.land, materials.land, 'receive');
  add('water', p.geoms.water, materials.water, 'receive');
  const toVec3Paths = (arrs: Float32Array[]) => arrs.map((a) => { const out: THREE.Vector3[] = []; for (let i = 0; i < a.length; i += 3) out.push(new THREE.Vector3(a[i], a[i + 1], a[i + 2])); return out; });
  const carPaths = toVec3Paths(p.carPaths);
  const walkPaths = toVec3Paths(p.walkPaths);
  return {
    meta: p.meta, lod: p.lod, group, buildings, ranges: p.ranges, carPaths, carMeta: p.carMeta ?? [], walkPaths, placements: p.placements,
    field: p.terrain ? new HeightField(p.terrain) : FLAT_FIELD(0),
    buildingFeatures: new Map(p.buildingFeatures.map((f) => [f.properties.id, f])),
    triangles,
  };
}

export function disposeTile(t: LoadedTile) {
  t.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  t.group.parent?.remove(t.group);
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
}
