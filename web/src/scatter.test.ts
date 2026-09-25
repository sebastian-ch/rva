import { describe, it, expect } from 'vitest';
import { scatterTile } from './scatter';
import type { AreaProps, BuildingProps, Feature, PointGeom, PoiProps, PolyGeom, RoadProps, LineGeom } from './types';
import type { V2 } from './geomutil';

const identity = (x: number, y: number): V2 => [x, y];
const flatGround = () => 0;
const bbox: [number, number, number, number] = [0, 0, 100, 100];

function poi(kind: string, x: number, y: number): Feature<PointGeom, PoiProps> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [x, y] },
    properties: { id: `${kind}-${x}-${y}`, name: null, kind },
  };
}

function squareBuilding(cx: number, cy: number, half: number): Feature<PolyGeom, BuildingProps> {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
      ]],
    },
    properties: {} as BuildingProps,
  };
}

describe('scatterTile', () => {
  it('adds more coastal palms while avoiding road corridors and buildings', () => {
    const green: Feature<PolyGeom, AreaProps> = {
      type: 'Feature', geometry: squareBuilding(50, 50, 50).geometry,
      properties: { id: 'green', name: null, kind: 'park' },
    };
    const roads: Feature<LineGeom, RoadProps>[] = [{ type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0,50],[100,50]] },
      properties: { width: 10, highway: 'footway' } as RoadProps }];
    const trees = (coastal: boolean) => scatterTile('coastal-test', [],
      [{ ...green, properties: { ...green.properties, coastal } }], roads,
      [squareBuilding(20,20,10)], bbox, identity, flatGround)
      .filter((p) => p.kind === 'tree' || p.kind === 'tree_round');
    const palms = trees(true);
    expect(palms.length).toBeGreaterThan(trees(false).length * 2);
    expect(palms.every((p) => Math.abs(p.z - 50) >= 7)).toBe(true);
    expect(palms.every((p) => !(p.x > 10 && p.x < 30 && p.z > 10 && p.z < 30))).toBe(true);
  });
  it('places a traffic_light at a traffic_signals POI and a fountain at a fountain POI', () => {
    const pois = [poi('traffic_signals', 20, 30), poi('fountain', 50, 60)];
    const out = scatterTile('tile-a', pois, [], [], [], bbox, identity, flatGround);

    const trafficLights = out.filter((p) => p.kind === 'traffic_light');
    const fountains = out.filter((p) => p.kind === 'fountain');
    expect(trafficLights).toHaveLength(1);
    expect(fountains).toHaveLength(1);

    for (const p of [...trafficLights, ...fountains]) {
      expect(p.x).toBeGreaterThanOrEqual(bbox[0]);
      expect(p.x).toBeLessThan(bbox[2]);
      expect(p.z).toBeGreaterThanOrEqual(bbox[1]);
      expect(p.z).toBeLessThan(bbox[3]);
    }
  });

  it('aims a surveyed streetlight toward the nearest road', () => {
    const road: Feature<LineGeom, RoadProps> = { type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 50], [100, 50]] },
      properties: { width: 8, highway: 'residential' } as RoadProps };
    const out = scatterTile('lamp-facing', [poi('streetlight', 50, 55)], [], [road], [], bbox, identity, flatGround);
    const lamp = out.find((p) => p.kind === 'streetlight' && p.x === 50 && p.z === 55);
    expect(lamp?.rot).toBeCloseTo(-Math.PI / 2);
  });

  it('skips procedural lamps on surveyed roads and beside mapped lamps', () => {
    const road = (id: string, y: number, lamps_surveyed?: boolean): Feature<LineGeom, RoadProps> => ({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, y], [100, y]] },
      properties: { id, width: 8, highway: 'residential', lamps_surveyed } as RoadProps });
    const count = (roads: Feature<LineGeom, RoadProps>[], pois: Feature<PointGeom, PoiProps>[] = []) =>
      scatterTile('lamps', pois, [], roads, [], bbox, identity, flatGround).filter((p) => p.kind === 'streetlight').length;

    expect(count([road('open', 50)])).toBeGreaterThan(0);
    expect(count([road('surveyed', 50, true)])).toBe(0);
    const mapped = [0, 20, 40, 60, 80, 100].flatMap((x) => [poi('lamp_post', x, 45), poi('lamp_post', x, 55)]);
    expect(count([road('open', 50)], mapped)).toBe(0);
  });

  it('stands a surveyed utility pole at its height with the crossarm across the street', () => {
    const road: Feature<LineGeom, RoadProps> = { type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 50], [100, 50]] },
      properties: { width: 4, highway: 'service', lamps_surveyed: true } as RoadProps };
    const pole = poi('utility_pole', 30, 53);
    pole.properties.pole_height = 12.5;
    const out = scatterTile('pole', [pole], [], [road], [], bbox, identity, flatGround);
    const placed = out.find((p) => p.kind === 'utility_pole');
    expect(placed?.scaleY).toBeCloseTo(1.25);
    expect(Math.abs(Math.cos(placed!.rot))).toBeLessThan(1e-9); // +X arm points north-south, across an east-west street
  });

  it('rejects a POI that falls inside a building footprint', () => {
    const pois = [poi('fountain', 50, 50)];
    const buildings = [squareBuilding(50, 50, 10)];
    const out = scatterTile('tile-b', pois, [], [], buildings, bbox, identity, flatGround);
    expect(out.filter((p) => p.kind === 'fountain')).toHaveLength(0);
  });
});

it('preserves identical tree placement in reduced detail while omitting small props',()=>{
 const pois=[poi('tree',10,10),poi('bench',20,20),poi('tree',30,30)];
 const full=scatterTile('lod-test',pois,[],[],[],bbox,identity,flatGround);
 const reduced=scatterTile('lod-test',pois,[],[],[],bbox,identity,flatGround,{treesOnly:true});
 expect(reduced).toEqual(full.filter(p=>p.kind.startsWith('tree')));
 expect(reduced).toHaveLength(2);
});
