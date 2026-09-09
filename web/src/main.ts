import * as THREE from 'three';
import palette from '../../assets/palette.json';
import landmarksJson from '../../assets/landmarks/landmarks.json';
import { createUI, type BuildingInfo } from './ui';
import { IsoCamera } from './camera';
import { TileWorld, type LoadedTile, type Materials } from './tiles';
import { PropPool } from './propPool';
import { rangeForFace, type BuildingRange } from './buildings';
import { extrudeBuilding } from './buildings';
import { MeshBuilder, hashStr, rng } from './geomutil';
import { hex } from './props';
import { LandmarkModels } from './landmarkModels';
import type { Landmark, TileIndex } from './types';

const landmarks = landmarksJson as Landmark[];
const landmarkBySlug = new Map(landmarks.map((l) => [l.slug, l]));

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
const DAY = { sky: hex('sky'), fog: hex('fog'), sun: hex('sun'), hemi: 0.9, dir: 1.1 };
const NIGHT = { sky: hex('night_sky'), fog: hex('night_fog'), sun: new THREE.Color('#9fb3d9'), hemi: 0.35, dir: 0.45 };
scene.background = DAY.sky.clone();
scene.fog = new THREE.Fog(DAY.fog.clone(), 1800, 5200);

const hemi = new THREE.HemisphereLight(hex('sky'), hex('ground'), DAY.hemi);
const sun = new THREE.DirectionalLight(DAY.sun, DAY.dir);
sun.position.set(-600, 900, 500);
scene.add(hemi, sun, new THREE.AmbientLight(0xffffff, 0.15));

const flat = (extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, ...extra });
const materials: Materials = {
  terrain: flat(), buildings: flat(), roads: flat({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  land: flat({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  water: flat({ roughness: 0.4, metalness: 0.05 }),
};
const propMaterial = flat();
const props = new PropPool(propMaterial);
scene.add(props.group);
let landmarkModels: LandmarkModels | null = null;

const iso = new IsoCamera(canvas, window.innerWidth / window.innerHeight);

const tiles: LoadedTile[] = [];
const buildingMeshes: THREE.Mesh[] = [];
const rangesByMesh = new Map<THREE.Mesh, BuildingRange[]>();
const landmarkTargets = new Map<string, THREE.Vector3>();

let night = false, paused = false;
const ui = createUI(document.getElementById('ui')!, {
  onToggleNight(on) { setNight(on); },
  onTogglePause(on) { paused = on; props.paused = on; },
  onToggleMap(on) { iso.setMapMode(on); },
  onTour() { nextTourStop(); },
  onCloseInfo() { clearSelection(); },
});

function setNight(on: boolean) {
  night = on;
  const t = on ? NIGHT : DAY;
  (scene.background as THREE.Color).copy(t.sky);
  scene.fog!.color.copy(t.fog);
  hemi.intensity = t.hemi;
  sun.intensity = t.dir;
  sun.color.copy(t.sun);
  ui.setNight(on);
}

// ---------------------------------------------------------------- selection
let selection: THREE.Mesh | null = null;
const selMaterial = new THREE.MeshStandardMaterial({ color: hex('landmark_accent'), emissive: hex('landmark_accent'), emissiveIntensity: 0.35, flatShading: true, transparent: true, opacity: 0.85 });
function clearSelection() {
  if (selection) { scene.remove(selection); selection.geometry.dispose(); selection = null; }
}
function select(range: BuildingRange, tile: LoadedTile) {
  clearSelection();
  // rebuild just this footprint, slightly inflated, as a highlight shell
  const mb = new MeshBuilder();
  const feat = tile.buildingFeatures.get(range.props.id);
  if (feat) {
    extrudeBuilding(mb, { ...feat, properties: { ...feat.properties, height: feat.properties.height + 0.4, roof_height: feat.properties.roof_height + 0.3 } }, world!.toLocal, feat.properties.ground_z + 0.15);
    selection = new THREE.Mesh(mb.build(), selMaterial);
    selection.scale.set(1, 1, 1);
    scene.add(selection);
  }
  const p = range.props;
  const lm = p.landmark ? landmarkBySlug.get(p.landmark) : undefined;
  const info: BuildingInfo = {
    id: p.id, name: lm?.name ?? p.name, addr: p.addr, height: p.height, levels: p.levels, type: p.type,
    landmark: p.landmark, wikidata: lm?.wikidata ?? p.wikidata, website: lm?.website ?? p.website,
    description: lm?.description ?? (p.height_source === 'default' ? 'Height estimated from building type; no OSM height or levels tag.' : null),
  };
  ui.showInfo(info);
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt: [number, number] | null = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, iso.camera);
  const hit = raycaster.intersectObjects(buildingMeshes, false)[0];
  if (!hit || hit.faceIndex == null) { clearSelection(); ui.hideInfo(); return; }
  const mesh = hit.object as THREE.Mesh;
  const range = rangeForFace(rangesByMesh.get(mesh)!, hit.faceIndex);
  const tile = tiles.find((t) => t.buildings === mesh);
  if (range && tile) select(range, tile);
});

// ---------------------------------------------------------------- tour
const tourStops = landmarks.filter((l) => l.in_first_slice);
let tourIdx = -1;
function nextTourStop() {
  const avail = tourStops.filter((l) => landmarkTargets.has(l.slug));
  if (!avail.length) { ui.setTourLabel('Tour: no landmarks loaded'); return; }
  tourIdx = (tourIdx + 1) % avail.length;
  const lm = avail[tourIdx];
  iso.flyTo(landmarkTargets.get(lm.slug)!, 3.2);
  ui.setTourLabel(`Tour: ${lm.name} (${tourIdx + 1}/${avail.length})`);
  // select it too
  for (const t of tiles) {
    const r = t.ranges.find((r) => r.props.landmark === lm.slug);
    if (r) { select(r, t); break; }
  }
}

// ---------------------------------------------------------------- loading
let world: TileWorld | null = null;
async function boot() {
  ui.setLoading(true, 'Loading index…');
  const index = (await (await fetch('/tiles/index.json')).json()) as TileIndex;
  world = new TileWorld(index, materials);
  landmarkModels = new LandmarkModels(world.toLocal, materials.buildings);
  scene.add(landmarkModels.group);
  const center = world.center();
  iso.lookAt(center, 1800);
  iso.camera.zoom = 1.1;
  iso.camera.updateProjectionMatrix();

  // load nearest tiles first
  const metas = index.tiles.slice().sort((a, b) => {
    const da = dist2(a.bbox, center), db = dist2(b.bbox, center);
    return da - db;
  });
  const rand = rng(hashStr('cars'));
  let done = 0;
  const CONC = 6;
  const queue = metas.slice();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const meta = queue.shift()!;
      try {
        const t = await world!.load(meta);
        scene.add(t.group);
        tiles.push(t);
        if (t.buildings) { buildingMeshes.push(t.buildings); rangesByMesh.set(t.buildings, t.ranges); }
        props.add(t.placements);
        props.addCars(t.carPaths, rand);
        await landmarkModels!.attach(t, landmarkBySlug, (oldMesh, newMesh, ranges) => {
          const i = buildingMeshes.indexOf(oldMesh);
          if (i >= 0) buildingMeshes.splice(i, 1);
          rangesByMesh.delete(oldMesh);
          if (newMesh) { buildingMeshes.push(newMesh); rangesByMesh.set(newMesh, ranges); }
        });
        for (const r of t.ranges) {
          if (r.props.landmark) {
            const box = new THREE.Box3().setFromBufferAttribute(t.buildings!.geometry.getAttribute('position') as THREE.BufferAttribute);
            // approximate: use tile-level box center offset by feature centroid via ranges (cheap and good enough for camera targets)
            const c = featureCenter(t, r) ?? box.getCenter(new THREE.Vector3());
            landmarkTargets.set(r.props.landmark, c);
          }
        }
      } catch (err) {
        console.warn('tile failed', meta.id, err);
      }
      done++;
      ui.setLoading(true, `Loading tiles… ${done}/${metas.length}`);
    }
  }));
  ui.setLoading(false);
  console.info(`loaded ${tiles.length} tiles, ${buildingMeshes.length} building meshes`);
}

function dist2(b: [number, number, number, number], c: THREE.Vector3): number {
  const [lx, lz] = world!.toLocal((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  return (lx - c.x) ** 2 + (lz - c.z) ** 2;
}

function featureCenter(t: LoadedTile, r: BuildingRange): THREE.Vector3 | null {
  const pos = t.buildings!.geometry.getAttribute('position') as THREE.BufferAttribute;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = r.start * 3; i < (r.start + r.count) * 3; i++) box.expandByPoint(v.fromBufferAttribute(pos, i));
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

// ---------------------------------------------------------------- loop
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  iso.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  iso.update(dt);
  if (!paused) props.update(dt);
  renderer.render(scene, iso.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
boot().catch((e) => { console.error(e); ui.setLoading(true, 'Failed to load tiles. Run the pipeline first.'); });

// expose for debugging
Object.assign(window, { __iso: { scene, tiles, iso, props, palette, night: () => night } });
