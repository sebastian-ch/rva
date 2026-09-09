import type { BuildRequest, BuildResponse } from './tileWorker';
import type { Lod, TilePayload } from './tileBuild';
import type { TileMeta } from './types';

/** Minimal Worker-like surface so the pool can be tested with a fake. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  terminate(): void;
}

interface Job { id: number; key: string; req: BuildRequest; resolve(p: TilePayload): void; reject(e: Error): void; cancelled: boolean }

export class WorkerPool {
  private idle: WorkerLike[] = [];
  private busy = new Map<WorkerLike, Job>();
  private queue: Job[] = [];
  private nextId = 1;
  readonly size: number;
  stats = { built: 0, buildMs: [] as number[] };

  constructor(factory: () => WorkerLike, size: number) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<BuildResponse>) => this.onMessage(w, e.data);
      this.idle.push(w);
    }
  }

  get pending(): number { return this.queue.length; }
  get active(): number { return this.busy.size; }

  /** Queue a build. `priority` lower = sooner. Returns a handle for cancellation. */
  build(meta: TileMeta, baseUrl: string, origin: [number, number], lod: Lod, priority: number): { promise: Promise<TilePayload>; cancel(): void } {
    const id = this.nextId++;
    let job!: Job;
    const promise = new Promise<TilePayload>((resolve, reject) => {
      job = { id, key: `${meta.id}:${lod}`, req: { type: 'build', jobId: id, meta, baseUrl, origin, lod }, resolve, reject, cancelled: false };
    });
    (job as Job & { priority: number }).priority = priority;
    this.queue.push(job);
    this.queue.sort((a, b) => (a as Job & { priority: number }).priority - (b as Job & { priority: number }).priority);
    this.pump();
    return {
      promise,
      cancel: () => {
        job.cancelled = true;
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); job.reject(new Error('cancelled')); }
      },
    };
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(w, job);
      w.postMessage(job.req);
    }
  }

  private onMessage(w: WorkerLike, msg: BuildResponse) {
    const job = this.busy.get(w);
    this.busy.delete(w);
    this.idle.push(w);
    if (job && job.id === msg.jobId) {
      if (msg.type === 'built') {
        this.stats.built++;
        this.stats.buildMs.push(msg.payload.buildMs);
        if (job.cancelled) job.reject(new Error('cancelled')); else job.resolve(msg.payload);
      } else job.reject(new Error(msg.message));
    }
    this.pump();
  }

  terminate() {
    for (const w of [...this.idle, ...this.busy.keys()]) w.terminate();
    this.idle = []; this.busy.clear();
    for (const j of this.queue) j.reject(new Error('terminated'));
    this.queue = [];
  }
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
