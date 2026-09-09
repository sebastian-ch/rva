import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshBuilder, ringBounds, type V2 } from './geomutil';
import { addRoofDetails } from './roofDetails';
import type { BuildingProps } from './types';

function makeProps(overrides: Partial<BuildingProps>): BuildingProps {
  return {
    id: 'test-id',
    name: null,
    height: 10,
    min_height: 0,
    levels: null,
    height_source: 'test',
    roof_shape: 'flat',
    roof_height: 0,
    roof_azimuth: null,
    roof_color: 'roof_dark',
    wall_color: 'concrete',
    type: 'building',
    landmark: null,
    addr: null,
    wikidata: null,
    website: null,
    ground_z: 0,
    ...overrides,
  };
}

function rect(w: number, h: number): V2[] {
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

describe('addRoofDetails', () => {
  it('flat building 30x20 height 20 has details within bounds', () => {
    const mb = new MeshBuilder();
    const outer = rect(30, 20);
    const top = 20;
    const props = makeProps({ id: 'flat-big', height: 20, roof_shape: 'flat' });
    addRoofDetails(mb, outer, top, props, new THREE.Color('#888888'), new THREE.Color('#333333'));

    expect(mb.triCount).toBeGreaterThan(0);
    const [minx, minz, maxx, maxz] = ringBounds(outer);
    for (let i = 0; i < mb.pos.length; i += 3) {
      const x = mb.pos[i], y = mb.pos[i + 1], z = mb.pos[i + 2];
      expect(Number.isNaN(x)).toBe(false);
      expect(Number.isNaN(y)).toBe(false);
      expect(Number.isNaN(z)).toBe(false);
      expect(y).toBeGreaterThanOrEqual(top - 0.01);
      expect(y).toBeLessThanOrEqual(top + 2.0);
      expect(x).toBeGreaterThanOrEqual(minx - 0.01);
      expect(x).toBeLessThanOrEqual(maxx + 0.01);
      expect(z).toBeGreaterThanOrEqual(minz - 0.01);
      expect(z).toBeLessThanOrEqual(maxz + 0.01);
    }
  });

  it('gable house 10x8 height 6 roof_height 2.5 has exactly one chimney', () => {
    const mb = new MeshBuilder();
    const outer = rect(10, 8);
    const top = 6;
    const props = makeProps({ id: 'gable-house', height: 6, roof_shape: 'gable', roof_height: 2.5 });
    addRoofDetails(mb, outer, top, props, new THREE.Color('#aaaaaa'), new THREE.Color('#552211'));

    expect(mb.triCount).toBe(12);
    let maxY = -Infinity;
    for (let i = 1; i < mb.pos.length; i += 3) {
      maxY = Math.max(maxY, mb.pos[i]);
    }
    expect(maxY).toBeCloseTo(top + 2.5 + 0.8, 2);
  });

  it('flat building height 8 area 100 has no details', () => {
    const mb = new MeshBuilder();
    const outer = rect(10, 10);
    const top = 8;
    const props = makeProps({ id: 'flat-small', height: 8, roof_shape: 'flat' });
    addRoofDetails(mb, outer, top, props, new THREE.Color('#888888'), new THREE.Color('#333333'));

    expect(mb.triCount).toBe(0);
  });
});
