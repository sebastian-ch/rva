/// <reference lib="webworker" />
import { buildTilePayload, fetchTileLayers, payloadTransferables, type Lod } from './tileBuild';
import type { TileMeta } from './types';
import { decodeLod1 } from './lod1Bake';

export interface BuildRequest { type: 'build'; jobId: number; meta: TileMeta; baseUrl: string; origin: [number, number]; lod: Lod }
export type BuildResponse = { type: 'built'; jobId: number; payload: import('./tileBuild').TilePayload } | { type: 'error'; jobId: number; message: string };

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const req = e.data;
  if (req.type !== 'build') return;
  try {
    let payload;
    if (req.lod === 1) {
      const baked = await fetch(`${req.baseUrl}/${req.meta.id}/lod1.meshopt`);
      if (baked.ok) payload = await decodeLod1(await baked.arrayBuffer(), req.meta);
    }
    if (!payload) {
      const layers = await fetchTileLayers(req.meta, req.baseUrl, req.lod);
      payload = buildTilePayload(req.meta, layers, req.origin, req.lod);
    }
    const msg: BuildResponse = { type: 'built', jobId: req.jobId, payload };
    (self as unknown as Worker).postMessage(msg, payloadTransferables(payload));
  } catch (err) {
    const msg: BuildResponse = { type: 'error', jobId: req.jobId, message: (err as Error).message ?? String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
