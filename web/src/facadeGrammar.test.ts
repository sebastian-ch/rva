import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FACADE_TRI_BUDGET, addStreetFacade, buildStreetIndex, streetFrontages } from './facadeGrammar';
import { buildBuildingsMesh } from './buildings';
import { MeshBuilder, signedArea, type V2 } from './geomutil';
import type { BuildingProps, Feature, LineGeom, PolyGeom, RoadProps } from './types';

// 30 x 20 m footprint; projected coords, centre (1000, 2000). Cary Street runs along its south edge.
function footprint(x = 1000, y = 2000): [number, number][] {
  return [[x - 15, y - 10], [x + 15, y - 10], [x + 15, y + 10], [x - 15, y + 10], [x - 15, y - 10]];
}

function building(over: Partial<BuildingProps> = {}, at: [number, number] = [1000, 2000]): Feature<PolyGeom, BuildingProps> {
  const props: BuildingProps = {
    id: 'b1', name: null, height: 12, min_height: 0, levels: null, height_source: 'osm',
    roof_shape: 'flat', roof_height: 0, roof_color: 'roof_flat', wall_color: 'brick',
    type: 'retail', landmark: null, addr: null, wikidata: null, website: null, ground_z: 0, ...over,
  };
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [footprint(at[0], at[1])] }, properties: props };
}

function street(coords: [number, number][]): Feature<LineGeom, RoadProps> {
  const props = { id: 'r1', name: null, highway: 'secondary', lanes: 2, width: 9, oneway: false,
    surface: null, sidewalk: true, bridge: false, tunnel: false, layer: 0 } as RoadProps;
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props };
}

const toLocal = (x: number, y: number): V2 => [x - 1000, -(y - 2000)];
const groundAt = () => 0;
const material = () => new THREE.MeshBasicMaterial();
// Local ring, wound as extrudeBuilding orients it: positive signed area, mass left of each edge.
const ring: V2[] = [[-15, -10], [15, -10], [15, 10], [-15, 10]];

describe('streetFrontages', () => {
  it('uses the same ring orientation as the extruder', () => {
    expect(signedArea(ring)).toBeGreaterThan(0);
  });

  it('takes only the wall the street is in front of', () => {
    // The street is 14 m south of the footprint: local z = +10 is the south edge.
    const index = buildStreetIndex([street([[980, 1976], [1020, 1976]])], toLocal);
    const fronts = streetFrontages(ring, index);
    expect(fronts).toHaveLength(1);
    expect(fronts[0].nrm[1]).toBeCloseTo(1, 5);
    expect(fronts[0].len).toBeCloseTo(30, 5);
  });

  it('finds nothing without a street in reach', () => {
    const far = buildStreetIndex([street([[980, 1900], [1020, 1900]])], toLocal);
    expect(streetFrontages(ring, far)).toHaveLength(0);
    expect(streetFrontages(ring, buildStreetIndex([], toLocal))).toHaveLength(0);
  });

  it('keeps both frontages of a corner building, longest first', () => {
    const corner = buildStreetIndex([
      street([[980, 1976], [1020, 1976]]),
      street([[1021, 1970], [1021, 2030]]),
    ], toLocal);
    const fronts = streetFrontages(ring, corner);
    expect(fronts).toHaveLength(2);
    expect(fronts[0].len).toBeGreaterThan(fronts[1].len);
  });

  it('ignores bridges and tunnels, which front nothing', () => {
    const deck = street([[980, 1976], [1020, 1976]]);
    deck.properties.bridge = true;
    expect(streetFrontages(ring, buildStreetIndex([deck], toLocal))).toHaveLength(0);
  });

  it('skips walls shorter than a shopfront', () => {
    const stub: V2[] = [[-2, -10], [2, -10], [2, 10], [-2, 10]];
    const index = buildStreetIndex([street([[980, 1976], [1020, 1976]])], toLocal);
    expect(streetFrontages(stub, index)).toHaveLength(0);
  });
});

describe('addStreetFacade', () => {
  const index = buildStreetIndex([street([[980, 1976], [1020, 1976]])], toLocal);
  const emit = (over: Partial<BuildingProps> = {}, budget = { left: FACADE_TRI_BUDGET }) => {
    const mb = new MeshBuilder(true);
    const count = addStreetFacade(mb, ring, 0, building(over).properties, index, budget);
    return { mb, count };
  };

  it('emits geometry for a retail frontage and charges the budget', () => {
    const budget = { left: FACADE_TRI_BUDGET };
    const { mb, count } = emit({}, budget);
    expect(count).toBeGreaterThan(0);
    expect(mb.triCount).toBe(count);
    expect(budget.left).toBe(FACADE_TRI_BUDGET - count);
  });

  it('stays attached to the wall, in front of it and inside the lower floors', () => {
    const { mb } = emit();
    // The frontage is the z = +10 wall with outward normal +z; nothing may sink into the footprint.
    for (let i = 0; i < mb.pos.length; i += 3) {
      const x = mb.pos[i], y = mb.pos[i + 1], z = mb.pos[i + 2];
      expect(z).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(z).toBeLessThan(10 + 1.3);
      expect(x).toBeGreaterThanOrEqual(-15 - 1e-6);
      expect(x).toBeLessThanOrEqual(15 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThan(2 * 3.2 + 0.5);
    }
  });

  it('is deterministic for the same building', () => {
    const a = emit(), b = emit();
    expect(a.count).toBe(b.count);
    expect(a.mb.pos).toEqual(b.mb.pos);
  });

  it('skips building parts that start above the pavement', () => {
    expect(emit({ min_height: 6 }).count).toBe(0);
  });

  it('skips buildings too low for a modelled ground floor', () => {
    expect(emit({ height: 2.5 }).count).toBe(0);
  });

  it('stops at the tile budget', () => {
    const budget = { left: 40 };
    const first = emit({}, budget).count;
    expect(first).toBeGreaterThan(40);
    expect(budget.left).toBeLessThanOrEqual(0);
    expect(emit({}, budget).count).toBe(0);
  });

  it('varies the rule set by building type', () => {
    const retail = emit({ type: 'retail' }).count;
    const residential = emit({ type: 'house', height: 8 }).count;
    const parking = emit({ type: 'parking' }).count;
    expect(new Set([retail, residential, parking]).size).toBe(3);
    expect(parking).toBeLessThan(retail);
  });
});

describe('buildBuildingsMesh with street frontages', () => {
  const roads = [street([[980, 1976], [1020, 1976]])];
  const count = (opts: Parameters<typeof buildBuildingsMesh>[4]) =>
    (buildBuildingsMesh([building()], toLocal, groundAt, material(), opts).mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count;

  it('adds the grammar only when the tile supplies streets', () => {
    expect(count({ roads })).toBeGreaterThan(count({}));
  });

  it('leaves reduced-detail tiles alone', () => {
    expect(count({ roads, details: false })).toBe(count({ details: false }));
  });

  it('does not double up on the hand-modelled storefronts', () => {
    const seven = building({ id: 'osm:way/236014923' });
    const withRoads = buildBuildingsMesh([seven], toLocal, groundAt, material(), { roads });
    const without = buildBuildingsMesh([seven], toLocal, groundAt, material(), {});
    expect((withRoads.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count)
      .toBe((without.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count);
  });

  it('keeps one pickable range per building', () => {
    const { ranges } = buildBuildingsMesh([building()], toLocal, groundAt, material(), { roads });
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(0);
  });
});
