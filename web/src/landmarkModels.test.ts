import { expect, it } from 'vitest';
import * as THREE from 'three';
import { prepareLandmarkObject } from './landmarkModels';

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
