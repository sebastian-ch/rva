import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

export const ELEVATION_DEG = 35;
export const AZIMUTH_DEG = 45;

export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;
  readonly controls: MapControls;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; fromZoom: number; toZoom: number; t: number; dur: number } | null = null;
  private mapMode = false;
  private savedPolar = 0;

  constructor(canvas: HTMLCanvasElement, aspect: number) {
    const half = 400;
    this.camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 1, 6000);
    this.camera.zoom = 1;
    this.controls = new MapControls(this.camera, canvas);
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false;
    c.minZoom = 0.35;
    c.maxZoom = 12;
    c.zoomSpeed = 1.2;
    c.rotateSpeed = 0.5;
    const polar = THREE.MathUtils.degToRad(90 - ELEVATION_DEG);
    c.minPolarAngle = polar;
    c.maxPolarAngle = polar;
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.savedPolar = polar;
  }

  lookAt(target: THREE.Vector3, distance = 1500) {
    const az = THREE.MathUtils.degToRad(AZIMUTH_DEG), el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    this.controls.target.copy(target);
    this.camera.position.set(
      target.x + Math.cos(el) * Math.sin(az) * distance,
      target.y + Math.sin(el) * distance,
      target.z + Math.cos(el) * Math.cos(az) * distance,
    );
    this.camera.lookAt(target);
    this.controls.update();
  }

  resize(w: number, h: number) {
    const aspect = w / h, half = 400;
    this.camera.left = -half * aspect; this.camera.right = half * aspect;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  /** Smoothly move the target (and zoom) — used by the tour. */
  flyTo(target: THREE.Vector3, zoom: number, dur = 1.6) {
    this.anim = { from: this.controls.target.clone(), to: target.clone(), fromZoom: this.camera.zoom, toZoom: zoom, t: 0, dur };
  }

  setMapMode(on: boolean) {
    this.mapMode = on;
    const c = this.controls;
    if (on) { c.minPolarAngle = 0; c.maxPolarAngle = 0; }
    else { c.minPolarAngle = this.savedPolar; c.maxPolarAngle = this.savedPolar; }
    c.update();
  }
  get isMap() { return this.mapMode; }

  update(dt: number) {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(a.dur, a.t + dt);
      const k = a.t / a.dur, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const delta = new THREE.Vector3().lerpVectors(a.from, a.to, e).sub(this.controls.target);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.camera.zoom = THREE.MathUtils.lerp(a.fromZoom, a.toZoom, e);
      this.camera.updateProjectionMatrix();
      if (a.t >= a.dur) this.anim = null;
    }
    this.controls.update();
  }
}
