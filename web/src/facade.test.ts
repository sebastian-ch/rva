import { describe, it, expect } from 'vitest';
import { facadeParams } from './facade';
import type { BuildingProps } from './types';

function props(overrides: Partial<BuildingProps>): BuildingProps {
  return {
    id: 'b1',
    name: null,
    height: 10,
    min_height: 0,
    levels: null,
    height_source: 'test',
    roof_shape: 'flat' as BuildingProps['roof_shape'],
    roof_height: 0,
    roof_color: '#888888',
    wall_color: '#cccccc',
    type: 'yes',
    landmark: null,
    addr: null,
    wikidata: null,
    website: null,
    ground_z: 0,
    ...overrides,
  } as BuildingProps;
}

describe('facadeParams', () => {
  it('office, height 40, levels 10 -> style 2, floor 4.0', () => {
    const r = facadeParams(props({ type: 'office', height: 40, levels: 10 }));
    expect(r.style).toBe(2);
    expect(r.floor).toBeCloseTo(4.0, 6);
  });

  it('house, height 7 -> style 1, floor 3.2', () => {
    const r = facadeParams(props({ type: 'house', height: 7 }));
    expect(r.style).toBe(1);
    expect(r.floor).toBeCloseTo(3.2, 6);
  });

  it('retail, height 9 -> style 3', () => {
    const r = facadeParams(props({ type: 'retail', height: 9 }));
    expect(r.style).toBe(3);
  });

  it('warehouse, height 4 -> style 0, floor 0', () => {
    const r = facadeParams(props({ type: 'warehouse', height: 4 }));
    expect(r.style).toBe(0);
    expect(r.floor).toBe(0);
  });

  it("'yes' height 20 -> style 2 (office, tall)", () => {
    const r = facadeParams(props({ type: 'yes', height: 20 }));
    expect(r.style).toBe(2);
  });

  it("'yes' height 10 -> style 3 (retail range)", () => {
    const r = facadeParams(props({ type: 'yes', height: 10 }));
    expect(r.style).toBe(3);
  });

  it("'yes' height 6 -> style 1 (residential fallback)", () => {
    const r = facadeParams(props({ type: 'yes', height: 6 }));
    expect(r.style).toBe(1);
  });

  it('height 3 (any type) -> style 0', () => {
    const r = facadeParams(props({ type: 'office', height: 3 }));
    expect(r.style).toBe(0);
  });

  it('implausible levels-derived floor height falls back to the default', () => {
    // height 10 / levels 1 = 10 m/floor, outside the plausible (2.4, 5.5) range
    const r = facadeParams(props({ type: 'yes', height: 10, levels: 1 }));
    expect(r.style).toBe(3);
    expect(r.floor).toBeCloseTo(3.2, 6);
  });
});
