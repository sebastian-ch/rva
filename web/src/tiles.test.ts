import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { wrapTilePayload, type Materials } from './tiles';
import type { TilePayload, GeomArrays } from './tileBuild';
import type { BuildingProps, Feature, PolyGeom, TileMeta } from './types';

function floats(n: number): Float32Array {
  return new Float32Array(Array.from({ length: n }, (_, i) => i));
}

function makeMaterials(): Materials {
  return {
    terrain: new THREE.MeshBasicMaterial(),
    buildings: new THREE.MeshBasicMaterial(),
    roads: new THREE.MeshBasicMaterial(),
    land: new THREE.MeshBasicMaterial(),
    water: new THREE.MeshBasicMaterial(),
  };
}

const META: TileMeta = { id: '0_0', x: 0, y: 0, bbox: [0, 0, 250, 250], layers: [], counts: {} };

describe('wrapTilePayload', () => {
  const buildings: GeomArrays = {
    position: floats(18), // 2 triangles
    normal: floats(18),
    color: floats(18),
    uv: floats(12),
    facade: floats(24),
  };
  const terrain: GeomArrays = {
    position: floats(9), // 1 triangle
    normal: floats(9),
    color: floats(9),
  };
  const feature: Feature<PolyGeom, BuildingProps> = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[]] },
    properties: { id: 'b1' } as BuildingProps,
  };
  const payload: TilePayload = {
    meta: META,
    lod: 0,
    terrain: null,
    geoms: { buildings, terrain },
    ranges: [],
    placements: [],
    carPaths: [new Float32Array([0, 1, 2, 3, 4, 5])],
    carMeta: [{ oneway: false, width: 7, highway: 'residential', lanes: 2, bridge: false, ramp: false, wayId: 'w1' }],
    walkPaths: [new Float32Array([10, 11, 12, 13, 14, 15])],
    buildingFeatures: [feature],
    buildMs: 5,
  };

  it('builds a group with terrain and buildings meshes', () => {
    const t = wrapTilePayload(payload, makeMaterials());
    const meshes = t.group.children as THREE.Mesh[];
    expect(meshes.map((m) => m.name).sort()).toEqual(['buildings', 'terrain']);

    const buildingsMesh = meshes.find((m) => m.name === 'buildings')!;
    const terrainMesh = meshes.find((m) => m.name === 'terrain')!;
    expect(buildingsMesh.castShadow).toBe(true);
    expect(terrainMesh.castShadow).toBeFalsy();

    expect(buildingsMesh.geometry.getAttribute('position').count).toBe(6);
    expect(terrainMesh.geometry.getAttribute('position').count).toBe(3);

    expect(t.triangles).toBe(3);
    expect(t.buildings).toBe(buildingsMesh);
  });

  it('converts flat car path arrays into Vector3 paths', () => {
    const t = wrapTilePayload(payload, makeMaterials());
    expect(t.carPaths.length).toBe(1);
    expect(t.carPaths[0]).toEqual([new THREE.Vector3(0, 1, 2), new THREE.Vector3(3, 4, 5)]);
  });

  it('converts flat walk path arrays into Vector3 paths', () => {
    const t = wrapTilePayload(payload, makeMaterials());
    expect(t.walkPaths.length).toBe(1);
    expect(t.walkPaths[0]).toEqual([new THREE.Vector3(10, 11, 12), new THREE.Vector3(13, 14, 15)]);
  });

  it('indexes buildingFeatures by id', () => {
    const t = wrapTilePayload(payload, makeMaterials());
    expect(t.buildingFeatures.size).toBe(1);
    expect(t.buildingFeatures.get('b1')).toBe(feature);
  });
});
