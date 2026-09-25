import { describe, expect, it } from 'vitest';
import { WIRE_ATTACH, WIRE_SPREAD, buildWires } from './wires';
import type { Feature, LineGeom, WireProps } from './types';
import type { V2 } from './geomutil';

const identity = (x: number, y: number): V2 => [x, y];
const span = (x1: number, z1 = 30): Feature<LineGeom, WireProps> => ({ type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[10, 50], [x1, 50]] },
  properties: { id: 'wire:1-2', h0: 10, h1: 12, z0: 99, z1: z1 } });

describe('buildWires', () => {
  it('hangs two sagging conductors from the insulators at both poles', () => {
    const pos = buildWires([span(50)], [0, 0, 100, 100], identity, () => 2);
    expect(pos.length).toBe(2 * 10 * 2 * 3); // two conductors x ten segments x two ends x xyz
    const first = [pos[0], pos[1], pos[2]];
    expect(first[0]).toBeCloseTo(10);
    expect(Math.abs(first[2] - 50)).toBeCloseTo(WIRE_SPREAD);
    expect(first[1]).toBeCloseTo(2 + 10 * WIRE_ATTACH); // inside the tile: stands on the tile's own ground
    const mid = pos[5 * 6 + 1]; // start of the sixth segment = t 0.5 on the first conductor
    expect(mid).toBeLessThan(2 + 11 * WIRE_ATTACH);
  });

  it('uses the stored ground elevation for an end in the neighbouring tile', () => {
    const pos = buildWires([span(130, 30)], [0, 0, 100, 100], identity, () => 2);
    const last = pos.length - 3;
    expect(pos[last]).toBeCloseTo(130);
    expect(pos[last + 1]).toBeCloseTo(30 + 12 * WIRE_ATTACH);
  });
});
