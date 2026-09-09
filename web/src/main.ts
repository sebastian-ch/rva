import * as THREE from 'three';
import palette from '../../assets/palette.json';
import landmarksJson from '../../assets/landmarks/landmarks.json';
import { createUI, readoutText, type BuildingInfo } from './ui';
import { IsoCamera } from './camera';
import { TileWorld, type LoadedTile, type Materials } from './tiles';
import { TileManager } from './tileManager';
import { PropPool } from './propPool';
import { TrafficClient } from './trafficClient';
import { rangeForFace, type BuildingRange } from './buildings';
import { extrudeBuilding } from './buildings';
import { MeshBuilder, hashStr, rng } from './geomutil';
import { hex } from './props';
import { LandmarkModels } from './landmarkModels';
import { createDebug } from './debug';
import { createPostFX } from './postfx';
import { applyGroundDetail } from './groundDetail';
import { createFacadeMaterial } from './facade';
import { createWaterMaterial } from './water';
import { applyHeightsMode, setHeightsMode, setHeightsRange, HEIGHT_STOPS } from './heightsMode';
import { Z_SCALE, realElev } from './elevation';
import { LandmarkLabels } from './labels';
import { fetchWikiSummary } from './wiki';
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
const SUN_DIR = new THREE.Vector3(-0.5, 0.75, 0.42).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.6;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 4000;
scene.add(hemi, sun, sun.target, new THREE.AmbientLight(0xffffff, 0.28)); // lifts shadowed streets so AO + grade do not crush them
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

/** Keep the shadow frustum tight around what the orthographic camera can see. */
function updateSunShadow() {
  const t = iso.controls.target;
  sun.target.position.copy(t);
  sun.position.copy(t).addScaledVector(SUN_DIR, 1500);
  const aspect = window.innerWidth / window.innerHeight;
  const halfH = (400 / iso.camera.zoom) * 1.6, halfW = halfH * Math.max(1, aspect);
  const cam = sun.shadow.camera;
  const r = Math.max(halfW, halfH);
  if (Math.abs(cam.right - r) > 1) {
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.updateProjectionMatrix();
  }
}

const flat = (extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, ...extra });
const heightsRange = { min: 0, max: 120 };
const facade = createFacadeMaterial();
const water = createWaterMaterial();
const materials: Materials = {
  terrain: flat(), buildings: facade.material, roads: flat({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  land: flat({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  water: water.material,
};
// elevation cues: contour lines on the ground layers, hypsometric tint on everything in Heights mode
applyGroundDetail(materials.terrain, 0.05);
applyGroundDetail(materials.land, 0.09);
applyHeightsMode(materials.terrain, { contours: true });
applyHeightsMode(materials.land, { contours: true });
applyHeightsMode(materials.roads);
applyHeightsMode(materials.buildings);
applyHeightsMode(materials.water);
setHeightsRange(heightsRange.min, heightsRange.max, 5 * Z_SCALE);
const propMaterial = flat();
const props = new PropPool(propMaterial);
const traffic = new TrafficClient();
props.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
scene.add(props.group);
let landmarkModels: LandmarkModels | null = null;

const iso = new IsoCamera(canvas, window.innerWidth / window.innerHeight);
const postfx = createPostFX(renderer, scene, iso.camera);

const tiles: LoadedTile[] = [];
const buildingMeshes: THREE.Mesh[] = [];
const rangesByMesh = new Map<THREE.Mesh, BuildingRange[]>();
const landmarkTargets = new Map<string, THREE.Vector3>();
const landmarkTileOf = new Map<string, string>();
const labels = new LandmarkLabels();
scene.add(labels.group);

let night = false, paused = false, heightsOn = false;
const ui = createUI(document.getElementById('ui')!, {
  onToggleNight(on) { setNight(on); },
  onTogglePause(on) { paused = on; props.paused = on; traffic.setPaused(on); },
  onToggleMap(on) { iso.setMapMode(on); },
  onTour() { nextTourStop(); },
  onToggleHeights(on) {
    heightsOn = on;
    setHeightsMode(on);
    ui.setHeights(on);
    ui.setHeightsLegend(on ? { minElev: realElev(heightsRange.min), maxElev: realElev(heightsRange.max), contour: 5, stops: HEIGHT_STOPS } : null);
  },
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
  facade.setNight(on);
  water.setNight(on);
  postfx.setNight(on);
  ui.setNight(on);
}

// ---------------------------------------------------------------- selection
let selection: THREE.Mesh | null = null;
let selectedId: string | null = null;
let selectionSeq = 0;
const selMaterial = new THREE.MeshStandardMaterial({ color: hex('landmark_accent'), emissive: hex('landmark_accent'), emissiveIntensity: 0.35, flatShading: true, transparent: true, opacity: 0.85 });
function clearSelection() {
  if (selection) { scene.remove(selection); selection.geometry.dispose(); selection = null; }
  selectedId = null;
}
function select(range: BuildingRange, tile: LoadedTile) {
  clearSelection();
  if (hoverId === range.props.id) clearHover();
  selectedId = range.props.id;
  const seq = ++selectionSeq;
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
  if (info.wikidata) {
    void fetchWikiSummary(info.wikidata).then((wiki) => {
      if (!wiki || seq !== selectionSeq) return; // selection changed since the fetch started
      ui.showInfo({ ...info, summary: wiki.summary, thumbnail: wiki.thumbnail, wikipediaUrl: wiki.url });
    });
  }
}

// ------------------------------------------------------------------- hover
let hoverMesh: THREE.Mesh | null = null;
let hoverId: string | null = null;
const hoverMaterial = new THREE.MeshStandardMaterial({ color: hex('landmark_accent'), flatShading: true, transparent: true, opacity: 0.45 });
function clearHover() {
  if (hoverMesh) { scene.remove(hoverMesh); hoverMesh.geometry.dispose(); hoverMesh = null; }
  hoverId = null;
}
function showHover(range: BuildingRange, tile: LoadedTile) {
  const mb = new MeshBuilder();
  const feat = tile.buildingFeatures.get(range.props.id);
  if (!feat) { clearHover(); return; }
  extrudeBuilding(mb, { ...feat, properties: { ...feat.properties, height: feat.properties.height + 0.4, roof_height: feat.properties.roof_height + 0.3 } }, world!.toLocal, feat.properties.ground_z + 0.15);
  clearHover();
  hoverMesh = new THREE.Mesh(mb.build(), hoverMaterial);
  scene.add(hoverMesh);
  hoverId = range.props.id;
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

let moveCount = 0;
let lastMoveAt = 0;
canvas.addEventListener('pointermove', (e) => {
  moveCount++;
  const now = performance.now();
  if (moveCount % 3 !== 0 && now - lastMoveAt < 50) return;
  lastMoveAt = now;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, iso.camera);
  const hit = raycaster.intersectObjects(buildingMeshes, false)[0];
  updateReadout(hit);
  if (!hit || hit.faceIndex == null) { clearHover(); canvas.style.cursor = ''; return; }
  const mesh = hit.object as THREE.Mesh;
  const range = rangeForFace(rangesByMesh.get(mesh)!, hit.faceIndex);
  if (!range || !range.props.landmark || range.props.id === selectedId) { clearHover(); canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'pointer';
  if (range.props.id === hoverId) return;
  const tile = tiles.find((t) => t.buildings === mesh);
  if (tile) showHover(range, tile);
});

/** Elevation under the cursor (terrain hit) and, when over a building, its height. */
function updateReadout(buildingHit: THREE.Intersection | undefined) {
  if (buildingHit && buildingHit.faceIndex != null) {
    const mesh = buildingHit.object as THREE.Mesh;
    const range = rangeForFace(rangesByMesh.get(mesh)!, buildingHit.faceIndex);
    if (range) { ui.setReadout(readoutText(realElev(range.props.ground_z), range.props.height)); return; }
  }
  const terrainMeshes: THREE.Object3D[] = [];
  for (const t of tiles) { const m = t.group.getObjectByName('terrain'); if (m) terrainMeshes.push(m); }
  const th = raycaster.intersectObjects(terrainMeshes, false)[0];
  ui.setReadout(th ? readoutText(realElev(th.point.y), null) : null);
}

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
let manager: TileManager | null = null;
let loggedFirst = false;
async function boot() {
  ui.setLoading(true, 'Loading index…');
  const index = (await (await fetch(`${import.meta.env.BASE_URL}tiles/index.json`)).json()) as TileIndex;
  world = new TileWorld(index, materials);
  landmarkModels = new LandmarkModels(world.toLocal, materials.buildings);
  scene.add(landmarkModels.group);
  // open on downtown rather than the geometric centre (which sits over the river): 400 m north of it
  const center = world.center();
  center.z -= 400; // local z = -north
  iso.lookAt(center, 1800);
  iso.camera.zoom = 1.1;
  iso.camera.updateProjectionMatrix();

  const rand = rng(hashStr('cars'));
  manager = new TileManager(index, materials, {
    onAdded(t) {
      scene.add(t.group);
      let maxY = -Infinity;
      for (const name of ['terrain', 'buildings']) {
        const m = t.group.getObjectByName(name) as THREE.Mesh | undefined;
        if (!m) continue;
        m.geometry.computeBoundingBox();
        maxY = Math.max(maxY, m.geometry.boundingBox!.max.y);
      }
      if (Number.isFinite(maxY) && maxY > heightsRange.max - 10) {
        heightsRange.max = Math.ceil((maxY + 10) / 10) * 10;
        setHeightsRange(heightsRange.min, heightsRange.max, 5 * Z_SCALE);
        if (heightsOn) ui.setHeightsLegend({ minElev: realElev(heightsRange.min), maxElev: realElev(heightsRange.max), contour: 5, stops: HEIGHT_STOPS });
      }
      tiles.push(t);
      if (t.buildings) { buildingMeshes.push(t.buildings); rangesByMesh.set(t.buildings, t.ranges); }
      props.beginTile(t.meta.id);
      props.add(t.placements);
      if (t.lod === 0) { traffic.addTile(t.meta.id, t.carPaths, t.carMeta); props.addWalkers(t.walkPaths, rand); }
      for (const r of t.ranges) {
        if (r.props.landmark) {
          const c = featureCenter(t, r);
          if (c) {
            landmarkTargets.set(r.props.landmark, c);
            landmarkTileOf.set(r.props.landmark, t.meta.id);
            const lm = landmarkBySlug.get(r.props.landmark);
            labels.set(r.props.landmark, lm?.name ?? r.props.name ?? r.props.landmark, c);
          }
        }
      }
      void landmarkModels!.attach(t, landmarkBySlug, (oldMesh, newMesh, ranges) => {
        const i = buildingMeshes.indexOf(oldMesh);
        if (i >= 0) buildingMeshes.splice(i, 1);
        rangesByMesh.delete(oldMesh);
        if (newMesh) { buildingMeshes.push(newMesh); rangesByMesh.set(newMesh, ranges); }
      });
    },
    onRemoved(t) {
      landmarkModels?.detachTile(t);
      const i = tiles.indexOf(t);
      if (i >= 0) tiles.splice(i, 1);
      if (t.buildings) { const j = buildingMeshes.indexOf(t.buildings); if (j >= 0) buildingMeshes.splice(j, 1); rangesByMesh.delete(t.buildings); }
      props.removeTile(t.meta.id);
      traffic.removeTile(t.meta.id);
      for (const [slug, tileId] of landmarkTileOf) {
        if (tileId === t.meta.id) { labels.remove(slug); landmarkTileOf.delete(slug); }
      }
    },
    onProgress(active, queued, resident) {
      const busy = active + queued;
      ui.setLoading(busy > 0, busy > 0 ? `Building tiles… ${busy} left (${resident} loaded)` : '');
      if (busy === 0 && !loggedFirst) { loggedFirst = true; console.info('iso stats', JSON.stringify(manager!.summary())); }
    },
  });
  manager.update(iso.camera, iso.camera.zoom, true);
  void loadLandmarkTargets(index);
}

interface LandmarkTarget { name: string; kind: string; x: number; y: number; ground_z: number; how: string | null; in_first_slice: boolean }

/** Pipeline-resolved positions for every landmark (buildings and non-buildings alike). */
async function loadLandmarkTargets(index: TileIndex) {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}tiles/landmarks.json`);
    if (!r.ok) return;
    const data = (await r.json()) as Record<string, LandmarkTarget>;
    for (const [slug, t] of Object.entries(data)) {
      if (!t.how || landmarkTargets.has(slug)) continue; // building targets from tiles are more precise
      const [lx, lz] = world!.toLocal(t.x, t.y);
      const pos = new THREE.Vector3(lx, t.ground_z * Z_SCALE + 6, lz);
      landmarkTargets.set(slug, pos);
      labels.set(slug, t.name, pos);
      landmarkTileOf.set(slug, '*');
    }
    void index;
  } catch (e) {
    console.warn('landmarks.json failed', e);
  }
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
  postfx.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('keydown', (e) => { if (e.key === 'o' && !(e.target instanceof HTMLInputElement)) postfx.enabled = !postfx.enabled; });
const clock = new THREE.Clock();
let waterTime = 0;
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  iso.update(dt);
  if (!paused) { props.update(dt); traffic.apply(props); waterTime += dt; water.update(waterTime); }
  updateSunShadow();
  manager?.update(iso.camera, iso.camera.zoom);
  labels.update(iso.camera.zoom, night);
  if (postfx.enabled) { postfx.update(iso.camera, window.innerHeight); postfx.composer.render(); } else renderer.render(scene, iso.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
boot().catch((e) => { console.error(e); ui.setLoading(true, 'Failed to load tiles. Run the pipeline first.'); });

// expose for debugging
const debug = createDebug({ iso, tiles, manager: () => manager, landmarkTargets, propCounts: () => props.counts_(), traffic: () => ({ ...traffic.stats, drawn: props.trafficCount() }) });
Object.assign(window, { __iso: { scene, tiles, iso, props, traffic, palette, night: () => night, stats: () => manager?.summary(), manager: () => manager, postfx, ...debug } });
