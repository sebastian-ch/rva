import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildBuildingsMesh, type BuildingRange } from './buildings';
import { centroid, cleanRing, polygons } from './geomutil';
import type { LoadedTile } from './tiles';
import type { Landmark } from './types';

/**
 * Hand-modeled landmarks: when landmarks.json has a `model`, load the glTF, drop it at the matched footprint's
 * centroid/ground elevation and rebuild that tile's procedural mesh without the placeholder extrusion.
 */
export class LandmarkModels {
  private loader = new GLTFLoader();
  readonly group = new THREE.Group();
  /** models attached per tile id, so a tile swap/unload can detach them */
  private byTile = new Map<string, THREE.Object3D[]>();
  private detached = new WeakSet<object>();
  constructor(private toLocal: (x: number, y: number) => [number, number], private material: THREE.Material) {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    this.loader.setDRACOLoader(draco);
    this.group.name = 'landmark-models';
  }

  /** Remove models that were attached from this tile (tile unloaded or swapped to another LOD). */
  detachTile(tile: LoadedTile) {
    this.detached.add(tile);
    const list = this.byTile.get(tile.meta.id);
    if (!list) return;
    for (const o of list) {
      this.group.remove(o);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    this.byTile.delete(tile.meta.id);
  }

  async attach(tile: LoadedTile, landmarks: Map<string, Landmark>,
    onRebuilt: (oldMesh: THREE.Mesh, newMesh: THREE.Mesh | null, ranges: BuildingRange[]) => void): Promise<number> {
    if (!tile.buildings) return 0;
    const withModel = tile.ranges.filter((r) => r.props.landmark && landmarks.get(r.props.landmark)?.model);
    if (!withModel.length) return 0;
    // one model per landmark: building:parts inherit the slug, so pick the outline (or the largest range) for position
    const bySlug = new Map<string, BuildingRange>();
    for (const r of withModel) {
      const cur = bySlug.get(r.props.landmark!);
      if (!cur || (cur.props.is_part && !r.props.is_part) || (cur.props.is_part === r.props.is_part && r.count > cur.count)) bySlug.set(r.props.landmark!, r);
    }
    let placed = 0;
    for (const r of bySlug.values()) {
      const lm = landmarks.get(r.props.landmark!)!;
      const feat = tile.buildingFeatures.get(r.props.id);
      if (!feat) continue;
      const c = centroid(cleanRing(polygons(feat.geometry)[0][0]));
      const [lx, lz] = this.toLocal(c[0], c[1]);
      try {
        const version = (import.meta.env.VITE_LANDMARK_VERSIONS as Record<string, string>)[lm.model!];
        const url = `${import.meta.env.BASE_URL}assets/${lm.model}${version ? `?v=${version}` : ''}`;
        const gltf = await this.loader.loadAsync(url);
        if (this.detached.has(tile)) continue;
        const obj = gltf.scene;
        obj.position.set(lx, feat.properties.ground_z, lz);
        obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).material = this.material; o.castShadow = true; o.receiveShadow = true; } });
        obj.name = `landmark:${lm.slug}`;
        this.group.add(obj);
        const list = this.byTile.get(tile.meta.id) ?? [];
        list.push(obj);
        this.byTile.set(tile.meta.id, list);
        placed++;
      } catch (e) {
        console.warn('landmark model failed', lm.slug, e);
      }
    }
    if (!placed) return 0;
    const keep = [...tile.buildingFeatures.values()].filter((f) => !withModel.some((r) => r.props.id === f.properties.id));
    const old = tile.buildings;
    old.parent?.remove(old);
    old.geometry.dispose();
    let mesh: THREE.Mesh | null = null, ranges: BuildingRange[] = [];
    if (keep.length) {
      const r = buildBuildingsMesh(keep, this.toLocal, (x, y) => tile.field.at(x, y), old.material as THREE.Material);
      mesh = r.mesh; ranges = r.ranges;
      mesh.name = 'buildings';
      tile.group.add(mesh);
    }
    tile.buildings = mesh;
    tile.ranges = ranges;
    onRebuilt(old, mesh, ranges);
    return placed;
  }
}
