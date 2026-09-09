/**
 * Main-thread side of the traffic worker: hands tiles over, keeps the last two pose buffers and interpolates
 * between them by wall time so 60 fps rendering stays smooth on a 20 Hz simulation.
 */
import type * as THREE from 'three';
import type { CarPathMeta } from './traffic/graph';
import { MAX_VEHICLES, POSE_STRIDE, type FromWorker, type StatsMessage, type ToWorker } from './traffic/protocol';

export interface TrafficWorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  terminate(): void;
}

export interface PoseSink {
  /** Apply interpolated poses; `alpha` blends prev -> cur (may exceed 1 slightly when the sim lags). */
  applyPoses(prev: Float32Array | null, cur: Float32Array, alpha: number): void;
}

export class TrafficClient {
  private worker: TrafficWorkerLike;
  private prev: Float32Array | null = null;
  private cur: Float32Array | null = null;
  private tPrev = 0;
  private tCur = 0;
  private lastLocal = 0;
  stats: StatsMessage = { type: 'stats', vehicles: 0, edges: 0, msPerStep: 0 };

  constructor(factory: () => TrafficWorkerLike = () => new Worker(new URL('./trafficWorker.ts', import.meta.url), { type: 'module' }) as unknown as TrafficWorkerLike) {
    this.worker = factory();
    this.worker.onmessage = (e) => this.onMessage(e.data);
  }

  private onMessage(m: FromWorker) {
    if (m.type === 'poses') {
      this.prev = this.cur; this.tPrev = this.tCur;
      this.cur = m.buf; this.tCur = m.t;
      this.lastLocal = performance.now();
    } else if (m.type === 'stats') this.stats = m;
  }

  addTile(tileId: string, paths: THREE.Vector3[][], meta: CarPathMeta[]) {
    const flat = paths.map((p) => { const a = new Float32Array(p.length * 3); p.forEach((v, i) => { a[i * 3] = v.x; a[i * 3 + 1] = v.y; a[i * 3 + 2] = v.z; }); return a; });
    this.worker.postMessage({ type: 'addTile', tileId, paths: flat, meta }, flat.map((a) => a.buffer as ArrayBuffer));
  }

  removeTile(tileId: string) { this.worker.postMessage({ type: 'removeTile', tileId }); }
  setPaused(paused: boolean) { this.worker.postMessage({ type: 'setParams', paused }); }
  setDensity(density: number) { this.worker.postMessage({ type: 'setParams', density }); }

  /** Push the current interpolated frame to the sink. */
  apply(sink: PoseSink, now = performance.now()) {
    if (!this.cur) return;
    const span = this.tCur - this.tPrev;
    const alpha = this.prev && span > 0 ? Math.min(1.25, (now - this.lastLocal) / span + 1) : 1;
    sink.applyPoses(this.prev, this.cur, alpha);
  }

  dispose() { this.worker.terminate(); }
}

export { MAX_VEHICLES, POSE_STRIDE };
