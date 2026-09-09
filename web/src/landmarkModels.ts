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
  constructor(private toLocal: (x: number, y: number) => [number, number], private material: THREE.Material) {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    this.loader.setDRACOLoader(draco);
    this.group.name = 'landmark-models';
  }

  async attach(tile: LoadedTile, landmarks: Map<string, Landmark>,
    onRebuilt: (oldMesh: THREE.Mesh, newMesh: THREE.Mesh | null, ranges: BuildingRange[]) => void): Promise<number> {
    if (!tile.buildings) return 0;
    const withModel = tile.ranges.filter((r) => r.props.landmark && landmarks.get(r.props.landmark)?.model);
    if (!withModel.length) return 0;
    let placed = 0;
    for (const r of withModel) {
      const lm = landmarks.get(r.props.landmark!)!;
      const feat = tile.buildingFeatures.get(r.props.id);
      if (!feat) continue;
      const c = centroid(cleanRing(polygons(feat.geometry)[0][0]));
      const [lx, lz] = this.toLocal(c[0], c[1]);
      try {
        const gltf = await this.loader.loadAsync(`/assets/${lm.model}`);
        const obj = gltf.scene;
        obj.position.set(lx, feat.properties.ground_z, lz);
        obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = this.material; });
        obj.name = `landmark:${lm.slug}`;
        this.group.add(obj);
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
