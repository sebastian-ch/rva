import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
// The glTF-specific decoder, served from our own origin: 64 kB gzipped against 90 kB for the
// general-purpose build three reaches for by default, and no third-party CDN.
import dracoWrapperUrl from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import { buildBuildingsMesh, type BuildingRange } from './buildings';
import { centroid, cleanRing, polygons } from './geomutil';
import type { LoadedTile } from './tiles';
import type { Landmark } from './types';

export function prepareLandmarkObject(obj: THREE.Object3D, material: THREE.Material, preserveMaterial: boolean) {
  obj.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    if (!preserveMaterial) (o as THREE.Mesh).material = material;
    o.castShadow = true; o.receiveShadow = true;
  });
}

/**
 * Per landmark slug in one tile, the range whose centroid places the model. building:parts inherit the slug
 * and can fall in a neighbouring tile, so only the tile holding the outline places it; a tile holding parts
 * whose outline lives elsewhere gets `null` (hide them, place nothing), or it would drop a second copy at
 * the parts' centroid. Parts without a parent fall back to the largest one.
 */
export function pickModelAnchors(ranges: BuildingRange[]): Map<string, BuildingRange | null> {
  const bySlug = new Map<string, BuildingRange[]>();
  for (const r of ranges) {
    if (!r.props.landmark) continue;
    const list = bySlug.get(r.props.landmark) ?? [];
    list.push(r);
    bySlug.set(r.props.landmark, list);
  }
  const anchors = new Map<string, BuildingRange | null>();
  for (const [slug, list] of bySlug) {
    const outlines = list.filter((r) => !r.props.is_part);
    const pool = outlines.length ? outlines : list.filter((r) => !r.props.parent);
    anchors.set(slug, pool.length ? pool.reduce((a, b) => (b.count > a.count ? b : a)) : null);
  }
  return anchors;
}

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
    draco.setDecoderPath({ js: dracoWrapperUrl, wasm: dracoWasmUrl });
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
    const anchors = pickModelAnchors(withModel);
    const hidden = new Set<string>();
    let placed = 0;
    for (const [slug, r] of anchors) {
      if (!r) { hidden.add(slug); continue; }
      const lm = landmarks.get(slug)!;
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
        prepareLandmarkObject(obj, this.material, Boolean(lm.preserve_material));
        obj.name = `landmark:${lm.slug}`;
        this.group.add(obj);
        const list = this.byTile.get(tile.meta.id) ?? [];
        list.push(obj);
        this.byTile.set(tile.meta.id, list);
        hidden.add(slug);
        placed++;
      } catch (e) {
        console.warn('landmark model failed', lm.slug, e);
      }
    }
    if (!hidden.size || this.detached.has(tile)) return placed;
    const drop = new Set(withModel.filter((r) => hidden.has(r.props.landmark!)).map((r) => r.props.id));
    const keep = [...tile.buildingFeatures.values()].filter((f) => !drop.has(f.properties.id));
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
