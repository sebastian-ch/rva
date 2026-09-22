import { expect, it } from 'vitest';
import * as THREE from 'three';
import type { BuildingRange } from './buildings';
import { pickModelAnchors, prepareLandmarkObject } from './landmarkModels';

it('preserves a reviewed source material while still configuring shadows', () => {
  const source = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const shared = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  prepareLandmarkObject(mesh, shared, true);
  expect(mesh.material).toBe(source);
  expect(mesh.castShadow).toBe(true);
  expect(mesh.receiveShadow).toBe(true);
});

it('uses the shared map material for normal landmark models', () => {
  const source = new THREE.MeshStandardMaterial();
  const shared = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  prepareLandmarkObject(mesh, shared, false);
  expect(mesh.material).toBe(shared);
});

const range = (id: string, landmark: string, count: number, extra: Partial<BuildingRange['props']> = {}): BuildingRange =>
  ({ start: 0, count, props: { id, landmark, ...extra } as BuildingRange['props'] });

it('anchors a landmark on its outline, not its larger parts', () => {
  const outline = range('osm:way/1', 'station', 30);
  const anchors = pickModelAnchors([range('osm:way/2', 'station', 90, { is_part: true, parent: 'osm:way/1' }), outline]);
  expect(anchors.get('station')).toBe(outline);
});

it('hides parts whose outline lives in another tile without placing a second model', () => {
  const anchors = pickModelAnchors([range('osm:way/2', 'station', 90, { is_part: true, parent: 'osm:way/1' })]);
  expect(anchors.has('station')).toBe(true);
  expect(anchors.get('station')).toBeNull();
});

it('falls back to the largest parentless part', () => {
  const big = range('osm:way/3', 'tower', 50, { is_part: true, parent: null });
  const anchors = pickModelAnchors([range('osm:way/2', 'tower', 10, { is_part: true, parent: null }), big]);
  expect(anchors.get('tower')).toBe(big);
});
