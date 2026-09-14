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

it('renders Richmond deck and patio surfaces above terrain', () => {
  const { land } = buildAreas([{
    type: 'Feature', properties: { id: 'richmond_structure:3', name: null, kind: 'deck', source: 'richmond_structures' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]] },
  }], [], (x, y) => [x, -y], () => 2, 0);
  const positions = land.getAttribute('position');
  expect(positions.count).toBeGreaterThan(0);
  for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeCloseTo(2.12);
});

it.each([
  ['tennis', [[[0, 0], [24, 0], [24, 11], [0, 11], [0, 0]]]],
  ['american_football', [[[0, 0], [110, 0], [110, 49], [0, 49], [0, 0]]]],
  ['soccer', [[[0, 0], [100, 0], [100, 64], [0, 64], [0, 0]]]],
  ['baseball', [[[0, 0], [80, 0], [90, 50], [50, 90], [0, 80], [0, 0]]]],
] as const)('adds a distinct surface and markings for a %s pitch', (sport, coordinates) => {
  const { land } = buildAreas([{
    type: 'Feature', properties: { id: sport, name: null, kind: 'pitch', sport, surface: sport === 'tennis' ? 'tartan' : 'grass' },
    geometry: { type: 'Polygon', coordinates: coordinates.map((ring) => ring.map(([x, y]) => [x, y] as [number, number])) },
  }], [], (x, y) => [x, -y], () => 2, 0);
  const positions = land.getAttribute('position'), colors = land.getAttribute('color');
  expect(positions.count).toBeGreaterThan(6);
  const unique = new Set(Array.from({ length: colors.count }, (_, i) =>
    `${colors.getX(i).toFixed(3)},${colors.getY(i).toFixed(3)},${colors.getZ(i).toFixed(3)}`));
  expect(unique.size).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < positions.count; i++) expect(positions.getY(i)).toBeGreaterThan(2);
});

it('keeps a baseball infield visible when the pitch is split across tiles', () => {
  const pitchLayout = JSON.stringify({
    cx: 40, cy: 40, ax: 1, ay: 0, hl: 40, hs: 40,
    hx: 0, hy: 0, dax: 1, day: 0, dbx: 0, dby: 1, la: 80, lb: 80,
  });
  const { land } = buildAreas([{
    type: 'Feature', properties: { id: 'fragment', name: null, kind: 'pitch', sport: 'baseball', pitch_layout: pitchLayout },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [15, 0], [15, 80], [0, 80], [0, 0]]] },
  }], [], (x, y) => [x, -y], () => 2, 0);
  const colors = land.getAttribute('color');
  const unique = new Set(Array.from({ length: colors.count }, (_, i) =>
    `${colors.getX(i).toFixed(3)},${colors.getY(i).toFixed(3)},${colors.getZ(i).toFixed(3)}`));
  expect(unique.size).toBeGreaterThanOrEqual(3); // turf, dirt, and paint
});
