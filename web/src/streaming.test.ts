import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cameraFootprint, tileLocalBox, wantedTiles, type Footprint } from './streaming';
import type { TileIndex, TileMeta } from './types';
import type { Lod } from './tileBuild';

const ORIGIN: [number, number] = [1000, 2000];

function makeMeta(x: number, y: number): TileMeta {
  return {
    id: `${x}_${y}`,
    x,
    y,
    bbox: [1000 + 250 * x, 2000 + 250 * y, 1000 + 250 * (x + 1), 2000 + 250 * (y + 1)],
    layers: [],
    counts: {},
  };
}

function makeIndex(n = 5): TileIndex {
  const tiles: TileMeta[] = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) tiles.push(makeMeta(x, y));
  return {
    crs: 'EPSG:2284',
    tile_size: 250,
    origin: ORIGIN,
    grid: [n, n],
    bbox_wgs84: [0, 0, 0, 0],
    bbox_proj: [1000, 2000, 1000 + 250 * n, 2000 + 250 * n],
    base_elevation: 0,
    tiles,
  };
}

describe('tileLocalBox', () => {
  it('maps proj bbox to local space (z = -north)', () => {
    expect(tileLocalBox(makeMeta(0, 0), ORIGIN)).toEqual([0, -250, 250, -0]);
    expect(tileLocalBox(makeMeta(2, 3), ORIGIN)).toEqual([500, -1000, 750, -750]);
  });
});

describe('wantedTiles', () => {
  const index = makeIndex();
  // Footprint covering exactly tile 2_2's local box [500,-750,750,-500], inset by 10.
  const fp: Footprint = { minX: 510, maxX: 740, minZ: -740, maxZ: -510, cx: 625, cz: -625 };

  it('centre tile is lod0, all others (within default 600m radius) are lod1', () => {
    const out = wantedTiles(index, fp, new Map());
    expect(out.get('2_2')).toEqual({ lod: 0, priority: 0 });

    let lod0 = 0, lod1 = 0;
    const lod1Priorities: number[] = [];
    for (const want of out.values()) {
      if (want === null) continue;
      if (want.lod === 0) lod0++;
      else { lod1++; lod1Priorities.push(want.priority); expect(want.priority).toBeGreaterThanOrEqual(1e5); }
    }
    expect(lod0).toBe(1);
    expect(lod1).toBe(24);
    expect(out.get('2_2')!.priority).toBeLessThan(1e5);

    // priority increases with distance from centre: a direct neighbour is closer than a corner tile.
    const neighbour = out.get('2_1')!; // distance 10
    const corner = out.get('0_0')!; // distance ~368
    expect(neighbour.priority).toBeLessThan(corner.priority);
  });

  it('with a small lod1Radius, only the 8 neighbours are lod1 and the rest unload', () => {
    const out = wantedTiles(index, fp, new Map(), { lod1Radius: 100 });
    const neighbours = ['1_1', '1_2', '1_3', '2_1', '2_3', '3_1', '3_2', '3_3'];
    for (const id of neighbours) expect(out.get(id)!.lod).toBe(1);
    expect(out.get('2_2')).toEqual({ lod: 0, priority: 0 });
    // outer ring (distance >= 260) unloads
    for (const id of ['0_0', '0_2', '2_0', '4_4', '2_4']) expect(out.get(id)).toBeNull();
  });

  it('hysteresis keeps a boundary tile at its current lod', () => {
    // Shift the footprint so 2_2's box [500,-750,750,-500] sits 50m outside it (dx = 800-750 = 50).
    const shifted: Footprint = { minX: 800, maxX: 1000, minZ: -500, maxZ: -300, cx: 900, cz: -400 };

    const withCurrent = wantedTiles(index, shifted, new Map([['2_2', 0 as Lod]]), { hysteresis: 80 });
    expect(withCurrent.get('2_2')!.lod).toBe(0);

    const withoutCurrent = wantedTiles(index, shifted, new Map(), { hysteresis: 80 });
    expect(withoutCurrent.get('2_2')!.lod).toBe(1);
  });

  it('maxResident evicts the farthest tiles, keeping the nearest N', () => {
    const out = wantedTiles(index, fp, new Map(), { maxResident: 5 });
    let resident = 0;
    for (const want of out.values()) if (want !== null) resident++;
    expect(resident).toBe(5);
    expect(out.get('2_2')).not.toBeNull();
  });
});

describe('cameraFootprint', () => {
  function makeCamera(): THREE.OrthographicCamera {
    const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 1000);
    cam.position.set(0, 500, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return cam;
  }

  it('expands the ground footprint by the margin', () => {
    const fp = cameraFootprint(makeCamera(), 150);
    // small numerical slop from the unproject round-trip (~0.05m on a 150m margin)
    expect(fp.minX).toBeCloseTo(-250, 0);
    expect(fp.maxX).toBeCloseTo(250, 0);
    expect(fp.minZ).toBeCloseTo(-250, 0);
    expect(fp.maxZ).toBeCloseTo(250, 0);
  });

  it('with margin 0 matches the camera frustum exactly', () => {
    const fp = cameraFootprint(makeCamera(), 0);
    expect(fp.minX).toBeCloseTo(-100, 0);
    expect(fp.maxX).toBeCloseTo(100, 0);
    expect(fp.minZ).toBeCloseTo(-100, 0);
    expect(fp.maxZ).toBeCloseTo(100, 0);
  });
});
