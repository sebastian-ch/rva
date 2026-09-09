import * as THREE from 'three';
import type { PoseSink } from './trafficClient';
import { MAX_VEHICLES, POSE_STRIDE } from './traffic/protocol';

const SAMPLES = 16, INTERVAL = 0.1;

/** World-space 1.5-second exposure: follows turns and stays put when the camera moves. */
export class TrafficTrails implements PoseSink {
  readonly lines: THREE.LineSegments;
  private history = new Float32Array(MAX_VEHICLES * SAMPLES * 3);
  private lengths = new Uint8Array(MAX_VEHICLES);
  private kinds = new Int8Array(MAX_VEHICLES).fill(-1);
  private positions = new Float32Array(MAX_VEHICLES * (SAMPLES - 1) * 6);
  private colors = new Float32Array(this.positions.length);
  private elapsed = 0;
  private due = false;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.lines.name = 'traffic-light-trails';
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  setEnabled(on: boolean) {
    this.lines.visible = on;
    this.lengths.fill(0); this.kinds.fill(-1);
    this.lines.geometry.setDrawRange(0, 0);
    this.elapsed = 0; this.due = false;
  }

  update(dt: number) {
    if (!this.lines.visible) return;
    // A suspended tab must not connect old traffic to a new simulation state.
    if (dt > 0.5) this.lengths.fill(0);
    this.elapsed += dt;
    this.due = this.elapsed >= INTERVAL;
    if (this.due) this.elapsed %= INTERVAL;
  }

  applyPoses(_prev: Float32Array | null, cur: Float32Array, _alpha: number) {
    if (!this.lines.visible || !this.due) return;
    this.due = false;
    let count = 0;
    for (let slot = 0; slot < MAX_VEHICLES; slot++) {
      const o = slot * POSE_STRIDE, h = slot * SAMPLES * 3, kind = cur[o + 4];
      if (kind < 0) { this.lengths[slot] = 0; this.kinds[slot] = -1; continue; }
      const x = cur[o], y = cur[o + 1] + 0.9, z = cur[o + 2];
      const dx = x - this.history[h], dz = z - this.history[h + 2];
      if (kind !== this.kinds[slot] || dx * dx + dz * dz > 400) this.lengths[slot] = 0;
      this.kinds[slot] = kind;
      const n = Math.min(SAMPLES, this.lengths[slot] + 1);
      this.history.copyWithin(h + 3, h, h + (n - 1) * 3);
      this.history.set([x, y, z], h); this.lengths[slot] = n;
      for (let j = 0; j < n - 1; j++) {
        for (let end = 0; end < 2; end++) {
          const k = j + end, p = count * 3;
          this.positions.set(this.history.subarray(h + k * 3, h + k * 3 + 3), p);
          const fade = (1 - k / (SAMPLES - 1)) * 2;
          this.colors.set(slot % 2 ? [fade, fade * 0.045, fade * 0.32] : [fade * 0.035, fade * 0.78, fade], p);
          count++;
        }
      }
    }
    this.lines.geometry.setDrawRange(0, count);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
