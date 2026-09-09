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
