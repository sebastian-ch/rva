import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TileManager } from './tileManager';
import type { Materials } from './tiles';
import type { TileIndex } from './types';
import { persistView, type ViewState } from './navigation';

function index(layers: string[] = []): TileIndex {
  return {
    crs: 'EPSG:32618', tile_size: 250, origin: [0, 0], grid: [1, 1], bbox_wgs84: [0, 0, 0, 0],
    bbox_proj: [0, 0, 250, 250], base_elevation: 0,
    tiles: [{ id: '0_0', x: 0, y: 0, bbox: [0, 0, 250, 250], layers, counts: {} }],
  };
}

/** No Worker in node, so the manager builds on the main thread through global fetch. */
function stubFetch(served: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = served[url];
    return { ok: body !== undefined, json: async () => body } as Response;
  }));
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('TileManager.refresh', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('re-requests a resident tile and swaps it in without unloading first', async () => {
    const calls = stubFetch({ 'tiles/index.json': index() });
    const added: string[] = [], removed: string[] = [];
    const m = new TileManager(index(), {} as Materials, {
      onAdded: (t) => added.push(t.meta.id), onRemoved: (t) => removed.push(t.meta.id), onProgress: () => {},
    }, 'tiles');
    // load the tile the ordinary way, then refresh it
    (m as unknown as { request(meta: unknown, lod: number, p: number): void }).request(index().tiles[0], 0, 0);
    await settle(); await settle();
    expect(added).toEqual(['0_0']);
    expect(m.tiles.has('0_0')).toBe(true);

    const ids = await m.refresh();
    expect(ids).toEqual(['0_0']);
    expect(m.busy).toBe(true);          // the old tile is still resident while the new one builds
    expect(m.tiles.has('0_0')).toBe(true);
    await settle(); await settle();
    expect(added).toEqual(['0_0', '0_0']);
    expect(removed).toEqual(['0_0']);   // old mesh disposed once the new one landed
    expect(calls.filter((u) => u.endsWith('index.json'))).toHaveLength(1);
  });

  it('re-reads index.json so a layer that appeared in the tile is fetched', async () => {
    stubFetch({ 'tiles/index.json': index(['roads']), 'tiles/0_0/roads.geojson': { type: 'FeatureCollection', features: [] } });
    const m = new TileManager(index(), {} as Materials, { onAdded: () => {}, onRemoved: () => {}, onProgress: () => {} }, 'tiles');
    await m.refresh('0_0');
    expect(m.index.tiles[0].layers).toEqual(['roads']);
    await settle(); await settle();
    expect(m.tiles.get('0_0')?.meta.layers).toEqual(['roads']);
  });

  it('warns and skips an unknown id, and unloads a resident tile the index dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch({ 'tiles/index.json': { ...index(), tiles: [] } });
    const removed: string[] = [];
    const m = new TileManager(index(), {} as Materials, { onAdded: () => {}, onRemoved: (t) => removed.push(t.meta.id), onProgress: () => {} }, 'tiles');
    (m as unknown as { request(meta: unknown, lod: number, p: number): void }).request(index().tiles[0], 0, 0);
    await settle(); await settle();
    expect(await m.refresh('9_9')).toEqual([]);
    expect(warn).toHaveBeenCalledWith('refresh: unknown tile', '9_9');
    expect(await m.refresh()).toEqual([]);
    expect(removed).toEqual(['0_0']);
    warn.mockRestore();
  });
});

describe('persistView', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const view: ViewState = { region: 'richmond', x: 1, y: 2, z: 3, zoom: 2, az: 0, distance: 1000, night: false, map: false, style: 'classic' };

  it('writes the hash when the view changes and stays quiet otherwise', () => {
    const writes: string[] = [];
    let current: ViewState | null = null;
    const stop = persistView(() => current, 100, (h) => writes.push(h));
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([]);            // nothing to persist before the scene exists
    current = view;
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^#view=1&region=richmond/);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);        // unchanged view: no churn
    current = { ...view, zoom: 3 };
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(2);
    stop();
    current = { ...view, zoom: 4 };
    vi.advanceTimersByTime(300);
    expect(writes).toHaveLength(2);
  });
});
