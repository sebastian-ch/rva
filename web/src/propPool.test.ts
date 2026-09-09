import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PropPool } from './propPool';

function zeroRand(): number { return 0; }

function personMesh(pool: PropPool): THREE.InstancedMesh {
  return pool.group.children.find((o) => o.name === 'props:person') as THREE.InstancedMesh;
}

function translationX(mesh: THREE.InstancedMesh, idx: number): number {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(idx, m);
  const pos = new THREE.Vector3();
  m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
  return pos.x;
}

describe('PropPool.addWalkers', () => {
  const path = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0)];

  it('spawns at least one walker for a 100 m path', () => {
    const pool = new PropPool(new THREE.MeshBasicMaterial());
    pool.beginTile('0_0');
    pool.addWalkers([path], zeroRand);
    expect(pool.counts_().person).toBeGreaterThanOrEqual(1);
  });

  it('moves the walker along +X after update()', () => {
    const pool = new PropPool(new THREE.MeshBasicMaterial());
    pool.beginTile('0_0');
    pool.addWalkers([path], zeroRand);
    const mesh = personMesh(pool);
    const before = translationX(mesh, 0);
    pool.update(2);
    const after = translationX(mesh, 0);
    expect(after).toBeGreaterThan(before);
  });

  it('ping-pongs back toward the start once it reaches the far end', () => {
    const pool = new PropPool(new THREE.MeshBasicMaterial());
    pool.beginTile('0_0');
    pool.addWalkers([path], zeroRand);
    const mesh = personMesh(pool);
    // large dt overshoots the 100 m path in one step, forcing a bounce
    pool.update(200);
    const atBounce = translationX(mesh, 0);
    pool.update(1);
    const afterBounce = translationX(mesh, 0);
    expect(afterBounce).toBeLessThan(atBounce);
  });

  it('removeTile drops walkers, restoring the previous person count', () => {
    const pool = new PropPool(new THREE.MeshBasicMaterial());
    const before = pool.counts_().person;
    pool.beginTile('tileA');
    pool.addWalkers([path], zeroRand);
    expect(pool.counts_().person).toBeGreaterThan(before);
    pool.removeTile('tileA');
    expect(pool.counts_().person).toBe(before);
  });
});
