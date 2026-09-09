import { describe, it, expect, vi } from 'vitest';
import { WorkerPool, percentile, type WorkerLike } from './workerPool';
import type { BuildRequest, BuildResponse } from './tileWorker';
import type { TilePayload } from './tileBuild';
import type { TileMeta } from './types';

class FakeWorker implements WorkerLike {
  postMessage = vi.fn((req: unknown) => { this.lastReq = req as BuildRequest; });
  onmessage: ((e: MessageEvent) => void) | null = null;
  terminate = vi.fn();
  lastReq: BuildRequest | null = null;

  reply(msg: BuildResponse) {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}

function payloadFor(req: BuildRequest): TilePayload {
  return {
    meta: req.meta,
    lod: req.lod,
    terrain: null,
    geoms: {},
    ranges: [],
    placements: [],
    carPaths: [],
    walkPaths: [], carMeta: [],
    buildingFeatures: [],
    buildMs: 5,
  };
}

const META: TileMeta = { id: 't', x: 0, y: 0, bbox: [0, 0, 250, 250], layers: [], counts: {} };

function makePool(size: number) {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, size);
  return { pool, workers };
}

// The worker currently holding the request for a given jobId (its most recent dispatch).
function workerForJob(workers: FakeWorker[], jobId: number): FakeWorker {
  const w = workers.find((w) => w.lastReq?.jobId === jobId);
  if (!w) throw new Error(`no worker dispatched for job ${jobId}`);
  return w;
}

describe('WorkerPool', () => {
  it('dispatches immediately as workers free up, sorted by priority', () => {
    const { pool, workers } = makePool(2);
    const jobs = [5, 1, 3, 2, 4].map((priority) => pool.build(META, '/tiles', [0, 0], 0, priority));

    // build() pumps synchronously after each push; the first two calls dispatch immediately
    // (priorities 5 and 1), the rest queue and get sorted by priority.
    expect(pool.active).toBe(2);
    expect(pool.pending).toBe(3);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    expect(workers[1].postMessage).toHaveBeenCalledTimes(1);

    const dispatchedPriorities = workers.map((w) => w.lastReq!.jobId).sort((a, b) => a - b);
    // jobIds are assigned in call order 1..5 for priorities [5,1,3,2,4]; jobs 1 and 2 (priorities 5,1) dispatch first.
    expect(dispatchedPriorities).toEqual([1, 2]);

    // Reply to job 1 (priority 5, dispatched first); the lowest-priority remaining job (priority 2, jobId 4) dispatches next.
    const w1 = workerForJob(workers, 1);
    w1.reply({ type: 'built', jobId: 1, payload: payloadFor(w1.lastReq!) });
    expect(pool.pending).toBe(2);
    expect(w1.lastReq!.jobId).toBe(4);

    void jobs; // suppress unused warning; promises are exercised in other tests
  });

  it('cancelling a queued job rejects it and it is never dispatched', async () => {
    const { pool, workers } = makePool(1);
    const first = pool.build(META, '/tiles', [0, 0], 0, 1); // dispatched immediately
    const second = pool.build(META, '/tiles', [0, 0], 0, 2); // queued

    second.cancel();
    await expect(second.promise).rejects.toThrow('cancelled');
    expect(pool.pending).toBe(0);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1); // only `first` was ever dispatched

    void first;
  });

  it('cancelling an in-flight job rejects on reply but still counts as built', async () => {
    const { pool, workers } = makePool(1);
    const job = pool.build(META, '/tiles', [0, 0], 0, 1);
    job.cancel();

    const w = workers[0];
    w.reply({ type: 'built', jobId: w.lastReq!.jobId, payload: payloadFor(w.lastReq!) });

    await expect(job.promise).rejects.toThrow('cancelled');
    expect(pool.stats.built).toBe(1);
  });

  it('an error reply rejects the promise and frees the worker for the next job', async () => {
    const { pool, workers } = makePool(1);
    const failing = pool.build(META, '/tiles', [0, 0], 0, 1);
    const queued = pool.build(META, '/tiles', [0, 0], 0, 2);

    const w = workers[0];
    const failingJobId = w.lastReq!.jobId;
    w.reply({ type: 'error', jobId: failingJobId, message: 'boom' });

    await expect(failing.promise).rejects.toThrow('boom');
    expect(pool.stats.built).toBe(0);
    // the queued job should now have been dispatched
    expect(w.lastReq!.jobId).not.toBe(failingJobId);
    expect(pool.pending).toBe(0);

    void queued;
  });

  it('terminate() rejects queued jobs and terminates every worker', async () => {
    const { pool, workers } = makePool(2);
    pool.build(META, '/tiles', [0, 0], 0, 1);
    pool.build(META, '/tiles', [0, 0], 0, 2);
    const queued = pool.build(META, '/tiles', [0, 0], 0, 3); // both workers busy, this one queues

    pool.terminate();

    await expect(queued.promise).rejects.toThrow('terminated');
    for (const w of workers) expect(w.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('percentile', () => {
  it('computes the p-th percentile', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });
});
