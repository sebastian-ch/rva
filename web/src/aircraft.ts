import * as THREE from 'three';
import type { TileIndex } from './types';

const KNOT_MPS = 0.514444;
const PREDICT_MS = 45_000;
const POLL_MS = 30_000;
const BLEND_MS = 2_000;
const DISPLAY_FLOOR = 160;

export interface AircraftItem {
  id: string;
  type: 'aircraft';
  title: string;
  coords: [number, number] | null;
  when: string;
  expiresAt?: string;
  groundSpeed?: number;
  heading?: number;
  aircraftKind?: 'airplane' | 'helicopter' | 'unknown';
  details?: [string, string][];
  altitudeFeet?: number;
  altitudeBaroFeet?: number;
  altitudeGeomFeet?: number;
  onGround?: boolean;
}

interface Track {
  item: AircraftItem;
  model: THREE.Group;
  rotor?: THREE.Object3D;
  blendFrom: [number, number] | null;
  blendAt: number;
}

export function altitudeFeet(item: AircraftItem): number | null {
  if (item.onGround) return null;
  for (const value of [item.altitudeGeomFeet, item.altitudeBaroFeet, item.altitudeFeet]) {
    if (Number.isFinite(value) && value! >= -1000 && value! <= 70_000) return value!;
  }
  // Compatibility with the current rva-live response. Prefer numeric fields when the API exposes them.
  const text = item.details?.find(([key]) => key === 'Altitude')?.[1];
  const match = text?.match(/^(-?[\d,]+(?:\.\d+)?) ft \((?:barometric|geometric|GNSS)\)$/i);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) && value >= -1000 && value <= 70_000 ? value : null;
}

/** Compress real flight levels into a readable city-scale display band. */
export function displayAltitude(feet: number, floor = DISPLAY_FLOOR): number {
  return floor + 130 * (1 - Math.exp(-Math.max(0, feet) / 12_000));
}

/** Short great-circle dead reckoning from the source position. */
export function predictedCoords(item: AircraftItem, now: number, reducedMotion = false): [number, number] | null {
  if (!item.coords || !Number.isFinite(item.coords[0]) || !Number.isFinite(item.coords[1])) return null;
  const received = Date.parse(item.when);
  if (!Number.isFinite(received)) return null;
  const suppliedExpiry = Date.parse(item.expiresAt ?? '');
  const expires = Number.isFinite(suppliedExpiry) ? suppliedExpiry : received + 90_000;
  if (now >= expires) return null;
  if (reducedMotion || !Number.isFinite(item.groundSpeed) || !Number.isFinite(item.heading)) return item.coords;
  const elapsed = Math.max(0, Math.min(PREDICT_MS, now - received)) / 1000;
  if (elapsed === 0 || item.groundSpeed! <= 0) return item.coords;
  const distance = item.groundSpeed! * KNOT_MPS * elapsed / 6_371_000;
  const bearing = THREE.MathUtils.degToRad(item.heading!);
  const lat1 = THREE.MathUtils.degToRad(item.coords[1]);
  const lon1 = THREE.MathUtils.degToRad(item.coords[0]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2));
  return [THREE.MathUtils.radToDeg(lon2), THREE.MathUtils.radToDeg(lat2)];
}

/** WGS84 longitude/latitude to UTM metres. */
export function toUtm(lon: number, lat: number, zone: number): [number, number] {
  const a = 6378137, ecc = 0.00669437999014, k0 = 0.9996;
  const phi = THREE.MathUtils.degToRad(lat), lambda = THREE.MathUtils.degToRad(lon);
  const lambda0 = THREE.MathUtils.degToRad((zone - 1) * 6 - 180 + 3);
  const ep2 = ecc / (1 - ecc), n = a / Math.sqrt(1 - ecc * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2, c = ep2 * Math.cos(phi) ** 2, aa = Math.cos(phi) * (lambda - lambda0);
  const m = a * ((1 - ecc / 4 - 3 * ecc ** 2 / 64 - 5 * ecc ** 3 / 256) * phi
    - (3 * ecc / 8 + 3 * ecc ** 2 / 32 + 45 * ecc ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * ecc ** 2 / 256 + 45 * ecc ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * ecc ** 3 / 3072) * Math.sin(6 * phi));
  const x = 500_000 + k0 * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120);
  let y = k0 * (m + n * Math.tan(phi) * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24
    + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720));
  if (lat < 0) y += 10_000_000;
  return [x, y];
}

function material(color: string) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.08, flatShading: true });
}

function model(kind: 'airplane' | 'helicopter' | 'unknown'): { group: THREE.Group; rotor?: THREE.Object3D } {
  const group = new THREE.Group();
  // True-scale aircraft disappear at the default city view. This layer uses map symbols.
  group.scale.setScalar(2.5);
  const body = material(kind === 'helicopter' ? '#d4533b' : kind === 'unknown' ? '#e4cc8c' : '#e9e4d8');
  const dark = material('#3d4650');
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, position: [number, number, number], rotation?: [number, number, number]) => {
    const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation); mesh.castShadow = true; group.add(mesh); return mesh;
  };
  if (kind === 'helicopter') {
    add(new THREE.SphereGeometry(1.35, 8, 5), body, [0.8, 0, 0]).scale.set(1.5, 0.9, 0.9);
    add(new THREE.BoxGeometry(4.2, 0.38, 0.38), body, [-1.7, 0.15, 0]);
    add(new THREE.BoxGeometry(0.25, 1.5, 1.8), body, [-3.7, 0.4, 0]);
    const rotor = new THREE.Group(); rotor.position.set(0.5, 1.25, 0);
    const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 8), dark);
    const blade2 = new THREE.Mesh(new THREE.BoxGeometry(8, 0.08, 0.12), dark);
    blade1.castShadow = true; blade2.castShadow = true; rotor.add(blade1, blade2); group.add(rotor);
    return { group, rotor };
  }
  if (kind === 'unknown') {
    add(new THREE.OctahedronGeometry(1.8, 0), body, [0, 0, 0]);
    return { group };
  }
  add(new THREE.CylinderGeometry(0.55, 0.72, 8, 8), body, [0, 0, 0], [0, 0, -Math.PI / 2]);
  add(new THREE.ConeGeometry(0.55, 1.7, 8), body, [4.75, 0, 0], [0, 0, -Math.PI / 2]);
  add(new THREE.BoxGeometry(3.2, 0.18, 11), body, [-0.5, 0, 0]);
  add(new THREE.BoxGeometry(1.9, 0.16, 4), body, [-3.25, 0.35, 0]);
  add(new THREE.BoxGeometry(1.25, 1.8, 0.16), body, [-3.6, 0.85, 0]);
  return { group };
}

function utmZone(crs: string): number | null {
  const match = crs.match(/EPSG:326(\d{2})$/);
  return match ? Number(match[1]) : null;
}

export class AircraftLayer {
  readonly group = new THREE.Group();
  private tracks = new Map<string, Track>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;
  private paused = false;
  private pausedAt = 0;
  private refreshing = false;
  private night = false;
  private zone: number | null;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private index: TileIndex, private endpoint: string) {
    this.group.name = 'live-aircraft';
    this.zone = utmZone(index.crs);
  }

  start() { void this.refresh(); this.timer ??= setInterval(() => void this.refresh(), POLL_MS); }
  setEnabled(on: boolean) { this.enabled = on; this.group.visible = on; if (on) void this.refresh(); }
  setPaused(on: boolean) { this.paused = on; if (on) this.pausedAt = Date.now(); }
  setNight(on: boolean) {
    this.night = on;
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
      mesh.material.emissive.set(on ? '#303942' : '#000000'); mesh.material.emissiveIntensity = on ? 0.32 : 0;
    });
  }

  async refresh() {
    if (!this.enabled || document.hidden || this.refreshing) return;
    this.refreshing = true;
    try {
      const url = new URL(this.endpoint, location.href); url.searchParams.set('types', 'aircraft');
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { items?: AircraftItem[] };
      const now = Date.now();
      for (const item of payload.items ?? []) {
        if (item.type !== 'aircraft' || !item.coords || altitudeFeet(item) === null) continue;
        const existing = this.tracks.get(item.id);
        if (existing) {
          existing.blendFrom = predictedCoords(existing.item, now, this.reducedMotion);
          existing.blendAt = now; existing.item = item;
        } else {
          const made = model(item.aircraftKind === 'helicopter' ? 'helicopter' : item.aircraftKind === 'airplane' ? 'airplane' : 'unknown');
          made.group.userData.aircraftId = item.id; this.group.add(made.group);
          this.tracks.set(item.id, { item, model: made.group, rotor: made.rotor, blendFrom: null, blendAt: now });
          this.setNight(this.night);
        }
      }
      this.removeExpired(now);
    } catch (error) {
      console.warn('aircraft feed unavailable', error);
    } finally {
      this.refreshing = false;
    }
  }

  private removeExpired(now: number) {
    for (const [id, track] of this.tracks) {
      const expired = predictedCoords(track.item, now, this.reducedMotion) === null;
      if (!expired) continue;
      this.group.remove(track.model); track.model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.geometry.dispose(); if (mesh.material instanceof THREE.Material) mesh.material.dispose(); }
      });
      this.tracks.delete(id);
    }
  }

  update(now: number, dt: number) {
    if (!this.enabled) return;
    this.removeExpired(now);
    if (!this.zone) return;
    const [ox, oy] = this.index.origin;
    const [minx, miny, maxx, maxy] = this.index.bbox_proj;
    for (const track of this.tracks.values()) {
      let coords = predictedCoords(track.item, this.paused ? this.pausedAt : now, this.reducedMotion);
      if (!coords) continue;
      if (track.blendFrom) {
        const k = Math.min(1, (now - track.blendAt) / BLEND_MS);
        coords = [THREE.MathUtils.lerp(track.blendFrom[0], coords[0], k), THREE.MathUtils.lerp(track.blendFrom[1], coords[1], k)];
        if (k === 1) track.blendFrom = null;
      }
      const [x, y] = toUtm(coords[0], coords[1], this.zone);
      const visible = x >= minx && x <= maxx && y >= miny && y <= maxy;
      track.model.visible = visible;
      if (!visible) continue;
      track.model.position.set(x - ox, displayAltitude(altitudeFeet(track.item)!), -(y - oy));
      if (Number.isFinite(track.item.heading)) track.model.rotation.y = Math.PI / 2 - THREE.MathUtils.degToRad(track.item.heading!);
      if (!this.paused && track.rotor) track.rotor.rotation.y += dt * 16;
    }
  }

  stats() { return { received: this.tracks.size, visible: [...this.tracks.values()].filter((track) => track.model.visible).length, enabled: this.enabled }; }
}
