import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { rangeForFace, buildBuildingsMesh, isCaryMcDonalds, isSevenEleven, type BuildingRange } from './buildings';
import type { BuildingProps, Feature, PolyGeom, RoofShape } from './types';
import type { V2 } from './geomutil';

describe('rangeForFace', () => {
  const ranges: BuildingRange[] = [
    { start: 0, count: 10, props: {} as BuildingProps },
    { start: 10, count: 5, props: {} as BuildingProps },
    { start: 15, count: 20, props: {} as BuildingProps },
  ];

  it('finds the containing range', () => {
    expect(rangeForFace(ranges, 0)).toBe(ranges[0]);
    expect(rangeForFace(ranges, 9)).toBe(ranges[0]);
    expect(rangeForFace(ranges, 10)).toBe(ranges[1]);
    expect(rangeForFace(ranges, 14)).toBe(ranges[1]);
    expect(rangeForFace(ranges, 15)).toBe(ranges[2]);
    expect(rangeForFace(ranges, 34)).toBe(ranges[2]);
  });

  it('returns null outside all ranges', () => {
    expect(rangeForFace(ranges, 35)).toBeNull();
    expect(rangeForFace(ranges, -1)).toBeNull();
  });
});

describe('isSevenEleven', () => {
  it('limits the custom facade to the mapped store', () => {
    expect(isSevenEleven({ id: 'osm:way/236014923', name: null, addr: null, website: null })).toBe(true);
    expect(isSevenEleven({ id: 'other', name: '7-Eleven', addr: null, website: null })).toBe(true);
    expect(isSevenEleven({ id: 'other', name: 'Convenience store', addr: '3301 West Cary Street', website: null })).toBe(false);
  });
});

describe('isCaryMcDonalds', () => {
  it('limits the custom facade to 3410 West Cary Street', () => {
    expect(isCaryMcDonalds({ id: 'osm:way/235998654' })).toBe(true);
    expect(isCaryMcDonalds({ id: 'osm:way/755389457' })).toBe(false);
  });
});

function makeFeature(roof_shape: RoofShape): Feature<PolyGeom, BuildingProps> {
  // 10x10 m square footprint centered on projected coords (1000, 2000)
  const coords: [number, number][] = [
    [995, 1995],
    [1005, 1995],
    [1005, 2005],
    [995, 2005],
    [995, 1995],
  ];
  const props: BuildingProps = {
    id: 'b1',
    name: null,
    height: 10,
    min_height: 0,
    levels: null,
    height_source: 'osm',
    roof_shape,
    roof_height: 3,
    roof_color: 'roof_red',
    wall_color: 'brick',
    type: 'building',
    landmark: null,
    addr: null,
    wikidata: null,
    website: null,
    ground_z: 5,
  };
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: props,
  };
}

const toLocal = (x: number, y: number): V2 => [x - 1000, -(y - 2000)];
const groundAt = () => 5;
const material = () => new THREE.MeshBasicMaterial();

function assertNoNaN(arr: ArrayLike<number>) {
  for (let i = 0; i < arr.length; i++) expect(Number.isNaN(arr[i])).toBe(false);
}

describe('buildBuildingsMesh', () => {
  it('uses an attached Roofer roof mesh above the existing walls', () => {
    const feat = makeFeature('gable');
    feat.properties.roof_source = 'lod2';
    feat.properties.roof_height = 4;
    feat.properties.lod2_roof = JSON.stringify({
      v: [[995, 1995, 0], [1005, 1995, 0], [1005, 2005, 4], [995, 2005, 4]],
      f: [[[0, 1, 2, 3]]],
    });
    const { mesh } = buildBuildingsMesh([feat], toLocal, groundAt, material(), { details: false });
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(maxY).toBeCloseTo(19, 2);
  });

  it('uses the procedural roof when LoD2 is disabled for a distant tile', () => {
    const feat = makeFeature('gable');
    feat.properties.roof_source = 'lod2';
    feat.properties.roof_height = 4;
    feat.properties.lod2_roof = JSON.stringify({
      v: [[995, 1995, 0], [1005, 1995, 0], [1005, 2005, 9], [995, 2005, 9]],
      f: [[[0, 1, 2, 3]]],
    });
    const { mesh } = buildBuildingsMesh([feat], toLocal, groundAt, material(), { details: false, lod2: false });
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(maxY).toBeCloseTo(19, 2);
  });

  it('emits one attached roof mesh for a multipart footprint', () => {
    const feat = makeFeature('flat');
    feat.geometry = { type: 'MultiPolygon', coordinates: [
      [[[995, 1995], [1005, 1995], [1005, 2005], [995, 2005], [995, 1995]]],
      [[[1015, 1995], [1025, 1995], [1025, 2005], [1015, 2005], [1015, 1995]]],
    ] };
    feat.properties.roof_source = 'lod2';
    feat.properties.lod2_roof = JSON.stringify({
      v: [[995, 1995, 0], [1005, 1995, 0], [1005, 2005, 0], [995, 2005, 0]],
      f: [[[0, 1, 2, 3]]],
    });
    const withRoof = buildBuildingsMesh([feat], toLocal, groundAt, material(), { details: false });
    const fallback = buildBuildingsMesh([feat], toLocal, groundAt, material(), { details: false, lod2: false });
    const withCount = (withRoof.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count / 3;
    const fallbackCount = (fallback.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count / 3;
    expect(withCount - fallbackCount).toBe(2);
  });

  it('builds a gable-roofed box within the expected height bounds', () => {
    const feat = makeFeature('gable');
    const { mesh, ranges } = buildBuildingsMesh([feat], toLocal, groundAt, material());
    expect(ranges.length).toBe(1);
    expect(ranges[0].count).toBeGreaterThan(0);

    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrmAttr = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    expect(posAttr.count).toBe(ranges[0].count * 3);

    assertNoNaN(posAttr.array);
    assertNoNaN(nrmAttr.array);

    const ground = 5, height = 10, roofH = 3;
    const minY = ground - 0.3 - 0.01;
    const maxY = ground + height + roofH + 0.8 + 0.01; // + chimney from roofDetails on gabled houses
    for (let i = 1; i < posAttr.array.length; i += 3) {
      const y = posAttr.array[i];
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(y).toBeLessThanOrEqual(maxY);
    }
  });

  const cases: { shape: RoofShape; expectedMax: number }[] = [
    { shape: 'flat', expectedMax: 15 },
    { shape: 'hip', expectedMax: 18 },
    { shape: 'pyramidal', expectedMax: 18 },
    { shape: 'skillion', expectedMax: 18 },
    { shape: 'dome', expectedMax: 18 },
  ];

  for (const { shape, expectedMax } of cases) {
    it(`builds a ${shape} roof with no NaN and correct peak height`, () => {
      const feat = makeFeature(shape);
      const { mesh, ranges } = buildBuildingsMesh([feat], toLocal, groundAt, material());
      expect(ranges.length).toBe(1);
      expect(ranges[0].count).toBeGreaterThan(0);

      const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nrmAttr = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      assertNoNaN(posAttr.array);
      assertNoNaN(nrmAttr.array);

      let maxY = -Infinity;
      for (let i = 1; i < posAttr.array.length; i += 3) maxY = Math.max(maxY, posAttr.array[i]);
      expect(maxY).toBeCloseTo(expectedMax, 2);
    });
  }
});

it.each(['gable','skillion'] as const)('keeps %s roof triangles inside a concave footprint',shape=>{
 const f=makeFeature(shape);
 f.geometry={type:'Polygon',coordinates:[[[0,0],[20,0],[20,6],[6,6],[6,20],[0,20],[0,0]]]};
 f.properties.roof_azimuth=37;
 const {mesh}=buildBuildingsMesh([f],(x,y)=>[x,y],()=>5,new THREE.MeshBasicMaterial(),{details:false});
 const pos=mesh.geometry.getAttribute('position');
 for(let i=0;i<pos.count;i+=3){
  const x=(pos.getX(i)+pos.getX(i+1)+pos.getX(i+2))/3,z=(pos.getZ(i)+pos.getZ(i+1)+pos.getZ(i+2))/3;
  if(Math.max(pos.getY(i),pos.getY(i+1),pos.getY(i+2))>15.001) expect(x>6.001&&z>6.001).toBe(false);
 }
});
