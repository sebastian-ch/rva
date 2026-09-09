import { expect, it } from 'vitest';
import * as THREE from 'three';
import { buildAreas } from './areas';

it('keeps coastal decks above water with outward-facing solid sides', () => {
  const { land } = buildAreas([{
    type: 'Feature', properties: { id: 'wall', name: null, kind: 'groyne', base_z: -0.5, top_z: 1.5 },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 3], [0, 3], [0, 0]]] },
  }], [], (x, y) => [x, -y], () => -20, 0);
  const positions = land.getAttribute('position'), normals = land.getAttribute('normal');
  const heights = Array.from({ length: positions.count }, (_, i) => positions.getY(i));
  expect(Math.min(...heights)).toBe(-0.5);
  expect(Math.max(...heights)).toBe(1.5);
  let sides = 0;
  for (let i = 0; i < positions.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(positions, i);
    const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(positions, i + 2);
    const n = new THREE.Vector3().fromBufferAttribute(normals, i);
    expect(b.sub(a).cross(c.sub(a)).dot(n)).toBeGreaterThan(0);
    if (n.y === 0) sides++;
  }
  expect(sides).toBe(8);
});
