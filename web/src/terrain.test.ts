import { describe, it, expect } from 'vitest';
import { HeightField, FLAT_FIELD } from './terrain';
import type { TerrainGrid } from './types';

// 3x3 grid, size 20 (step 10), origin [100,200], elev 0..8 row-major.
const grid: TerrainGrid = {
  size: 20,
  n: 3,
  origin: [100, 200],
  elev: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

describe('HeightField', () => {
  const hf = new HeightField(grid);

  it('returns exact values at grid nodes', () => {
    expect(hf.at(100, 200)).toBeCloseTo(0);
    expect(hf.at(110, 200)).toBeCloseTo(1);
    expect(hf.at(120, 200)).toBeCloseTo(2);
    expect(hf.at(100, 210)).toBeCloseTo(3);
    expect(hf.at(110, 210)).toBeCloseTo(4);
    expect(hf.at(120, 210)).toBeCloseTo(5);
    expect(hf.at(100, 220)).toBeCloseTo(6);
    expect(hf.at(110, 220)).toBeCloseTo(7);
    expect(hf.at(120, 220)).toBeCloseTo(8);
  });

  it('bilinearly interpolates the midpoint between two nodes', () => {
    // midpoint between (100,200)=0 and (110,200)=1
    expect(hf.at(105, 200)).toBeCloseTo(0.5);
    // midpoint between (100,200)=0 and (100,210)=3
    expect(hf.at(100, 205)).toBeCloseTo(1.5);
    // center of the whole 4-corner cell (100,200)=0,(120,200)=2,(100,220)=6,(120,220)=8 -> average 4
    expect(hf.at(110, 210)).toBeCloseTo(4);
  });

  it('clamps outside the grid without NaN, returning edge values', () => {
    const low = hf.at(-1000, -1000);
    expect(low).not.toBeNaN();
    expect(low).toBeCloseTo(0, 2);

    const high = hf.at(1e6, 1e6);
    expect(high).not.toBeNaN();
    expect(high).toBeGreaterThan(7.9);
    expect(high).toBeLessThanOrEqual(8);
  });
});

describe('FLAT_FIELD', () => {
  it('always returns the given constant height', () => {
    const f = FLAT_FIELD(5);
    expect(f.at(0, 0)).toBe(5);
    expect(f.at(12345, -6789)).toBe(5);
    expect(f.at(-1e9, 1e9)).toBe(5);
  });
});
