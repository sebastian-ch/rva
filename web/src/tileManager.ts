import * as THREE from 'three';
import type { TileIndex, TileMeta } from './types';
import { WorkerPool, percentile } from './workerPool';
import { wrapTilePayload, disposeTile, type LoadedTile, type Materials } from './tiles';
import { cameraFootprint, wantedTiles, type Footprint } from './streaming';
import type { Lod } from './tileBuild';
import { buildTilePayload, fetchTileLayers } from './tileBuild';

export interface TileManagerEvents {
  onAdded(tile: LoadedTile): void;
  onRemoved(tile: LoadedTile): void;
  onProgress(active: number, queued: number, resident: number): void;
}

interface Pending { cancel(): void; lod: Lod }

/** Owns resident tiles: decides what to load/unload from the camera footprint and drives the worker pool. */
export class TileManager {
  readonly tiles = new Map<string, LoadedTile>();
  private pending = new Map<string, Pending>();
  private pool: WorkerPool | null;
  private lastFp: Footprint | null = null;
  private lastZoom = 0;
  private lastCheck = 0;
  readonly stats = { firstBuildingMs: 0, wrapMs: [] as number[], t0: performance.now() };
  private metaById = new Map<string, TileMeta>();

  constructor(readonly index: TileIndex, readonly materials: Materials, readonly events: TileManagerEvents,
    readonly baseUrl = `${import.meta.env.BASE_URL}tiles`, workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (const m of index.tiles) this.metaById.set(m.id, m);
    this.pool = typeof Worker === 'undefined' ? null
      : new WorkerPool(() => new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' }), workers);
  }

  /** Call every frame; cheap unless the view moved. */
  update(camera: THREE.Camera, zoom: number, force = false) {
    const now = performance.now();
    if (!force && now - this.lastCheck < 250) return;
    const fp = cameraFootprint(camera);
    const moved = !this.lastFp || Math.hypot(fp.cx - this.lastFp.cx, fp.cz - this.lastFp.cz) > 60 || Math.abs(zoom - this.lastZoom) / Math.max(zoom, 1e-6) > 0.15;
    this.lastCheck = now;
    if (!moved && !force) return;
    this.lastFp = fp; this.lastZoom = zoom;
    this.reconcile(fp);
  }

  private currentLods(): Map<string, Lod> {
    const m = new Map<string, Lod>();
    for (const [id, t] of this.tiles) m.set(id, t.lod);
    for (const [id, p] of this.pending) m.set(id, p.lod);
    return m;
  }

  private reconcile(fp: Footprint) {
    const want = wantedTiles(this.index, fp, this.currentLods());
    for (const [id, w] of want) {
      const have = this.tiles.get(id);
      const pend = this.pending.get(id);
      if (w === null) {
        if (pend) { pend.cancel(); this.pending.delete(id); }
        if (have) this.unload(id);
        continue;
      }
      if ((have && have.lod === w.lod) || (pend && pend.lod === w.lod)) continue;
      if (pend) { pend.cancel(); this.pending.delete(id); }
      this.request(this.metaById.get(id)!, w.lod, w.priority);
    }
    this.progress();
  }

  private request(meta: TileMeta, lod: Lod, priority: number) {
    let cancelled = false;
    const done = (payload: import('./tileBuild').TilePayload) => {
      this.pending.delete(meta.id);
      if (cancelled) return;
      const t0 = performance.now();
      const tile = wrapTilePayload(payload, this.materials);
      this.stats.wrapMs.push(performance.now() - t0);
      const old = this.tiles.get(meta.id);
      if (old) this.unload(meta.id);
      this.tiles.set(meta.id, tile);
      if (!this.stats.firstBuildingMs && tile.buildings) this.stats.firstBuildingMs = performance.now() - this.stats.t0;
      this.events.onAdded(tile);
      this.progress();
    };
    const fail = (err: Error) => {
      this.pending.delete(meta.id);
      if (err.message !== 'cancelled') console.warn('tile failed', meta.id, err);
      this.progress();
    };
    if (this.pool) {
      const h = this.pool.build(meta, this.baseUrl, this.index.origin, lod, priority);
      this.pending.set(meta.id, { lod, cancel: () => { cancelled = true; h.cancel(); } });
      h.promise.then(done, fail);
    } else {
      this.pending.set(meta.id, { lod, cancel: () => { cancelled = true; } });
      fetchTileLayers(meta, this.baseUrl, lod).then((layers) => done(buildTilePayload(meta, layers, this.index.origin, lod)), fail);
    }
  }

  private unload(id: string) {
    const t = this.tiles.get(id);
    if (!t) return;
    this.tiles.delete(id);
    this.events.onRemoved(t);
    disposeTile(t);
  }

  private progress() {
    this.events.onProgress(this.pool?.active ?? this.pending.size, this.pool?.pending ?? 0, this.tiles.size);
  }

  get busy(): boolean { return this.pending.size > 0; }

  summary() {
    let full = 0, lod1 = 0, tris = 0;
    for (const t of this.tiles.values()) { if (t.lod === 0) full++; else lod1++; tris += t.triangles; }
    const b = this.pool?.stats.buildMs ?? [];
    return {
      tiles: { full, lod1 }, triangles: Math.round(tris), workers: this.pool?.size ?? 0,
      buildMs: { p50: Math.round(percentile(b, 50)), p95: Math.round(percentile(b, 95)), n: b.length },
      wrapMs: { p50: +percentile(this.stats.wrapMs, 50).toFixed(2), p95: +percentile(this.stats.wrapMs, 95).toFixed(2) },
      firstBuildingMs: Math.round(this.stats.firstBuildingMs),
    };
  }
}
