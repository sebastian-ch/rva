/// <reference lib="webworker" />
import { buildTilePayload, fetchTileLayers, payloadTransferables, type Lod } from './tileBuild';
import type { TileMeta } from './types';

export interface BuildRequest { type: 'build'; jobId: number; meta: TileMeta; baseUrl: string; origin: [number, number]; lod: Lod }
export type BuildResponse = { type: 'built'; jobId: number; payload: import('./tileBuild').TilePayload } | { type: 'error'; jobId: number; message: string };

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const req = e.data;
  if (req.type !== 'build') return;
  try {
    const layers = await fetchTileLayers(req.meta, req.baseUrl, req.lod);
    const payload = buildTilePayload(req.meta, layers, req.origin, req.lod);
    const msg: BuildResponse = { type: 'built', jobId: req.jobId, payload };
    (self as unknown as Worker).postMessage(msg, payloadTransferables(payload));
  } catch (err) {
    const msg: BuildResponse = { type: 'error', jobId: req.jobId, message: (err as Error).message ?? String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
