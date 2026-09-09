import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  signedArea,
  cleanRing,
  ccw,
  centroid,
  triangulate,
  convexHull,
  minAreaOBB,
  pointInRing,
  ringBounds,
  rng,
  hashStr,
  MeshBuilder,
  type V2,
} from './geomutil';

const CCW_SQUARE: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const CW_SQUARE: V2[] = [[0, 0], [0, 1], [1, 1], [1, 0]];

describe('signedArea', () => {
  it('is positive for a CCW square', () => {
    expect(signedArea(CCW_SQUARE)).toBeCloseTo(1);
  });
  it('is negative for a CW square', () => {
    expect(signedArea(CW_SQUARE)).toBeCloseTo(-1);
  });
});

describe('cleanRing', () => {
  it('removes the closing duplicate point', () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(cleanRing(ring)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });
  it('removes consecutive duplicate points', () => {
    const ring: [number, number][] = [[0, 0], [0, 0], [1, 0], [1, 0], [1, 1], [0, 1]];
    expect(cleanRing(ring)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });
});

describe('ccw', () => {
  it('reverses a CW ring', () => {
    const out = ccw(CW_SQUARE);
    expect(signedArea(out)).toBeGreaterThan(0);
    expect(out).toEqual(CW_SQUARE.slice().reverse());
  });
  it('leaves a CCW ring unchanged', () => {
    const out = ccw(CCW_SQUARE);
    expect(out).toEqual(CCW_SQUARE);
  });
});

describe('centroid', () => {
  it('of a unit square is (0.5, 0.5)', () => {
    const [cx, cy] = centroid(CCW_SQUARE);
    expect(cx).toBeCloseTo(0.5);
    expect(cy).toBeCloseTo(0.5);
  });
  it('of an L-shape lies inside the shape', () => {
    // L-shape: 2x2 square minus the top-right 1x1 quadrant
    const lShape: V2[] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const c = centroid(lShape);
    expect(pointInRing(c, lShape)).toBe(true);
  });
});

describe('triangulate', () => {
  it('of a simple square yields 2 triangles', () => {
    const idx = triangulate(CCW_SQUARE, []);
    expect(idx.length).toBe(6);
  });
  it('of a square with a square hole yields 8 triangles', () => {
    const outer: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: V2[] = [[4, 4], [6, 4], [6, 6], [4, 6]];
    const idx = triangulate(outer, [hole]);
    expect(idx.length).toBe(24);
  });
});

describe('convexHull', () => {
  it('of a square plus interior points returns just the 4 corners', () => {
    const square: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const interior: V2[] = [[5, 5], [3, 3], [7, 2], [4, 8]];
    const hull = convexHull([...square, ...interior]);
    expect(hull.length).toBe(4);
    for (const p of square) {
      expect(hull.some((h) => Math.abs(h[0] - p[0]) < 1e-9 && Math.abs(h[1] - p[1]) < 1e-9)).toBe(true);
    }
  });
});

describe('minAreaOBB', () => {
  it('of an axis-aligned 10x4 rectangle', () => {
    const rect: V2[] = [[0, 0], [10, 0], [10, 4], [0, 4]];
    const obb = minAreaOBB(rect);
    expect(obb.halfLong).toBeCloseTo(5);
    expect(obb.halfShort).toBeCloseTo(2);
    expect(Math.abs(obb.axis[0])).toBeCloseTo(1);
    expect(Math.abs(obb.axis[1])).toBeCloseTo(0);
  });
  it('of the same rectangle rotated 30 degrees', () => {
    const theta = (30 * Math.PI) / 180;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const rot = (p: V2): V2 => [p[0] * ct - p[1] * st, p[0] * st + p[1] * ct];
    const corners: V2[] = [[0, 0], [10, 0], [10, 4], [0, 4]];
    const rect: V2[] = corners.map(rot);
    const obb = minAreaOBB(rect);
    expect(obb.halfLong).toBeCloseTo(5);
    expect(obb.halfShort).toBeCloseTo(2);
    // axis should align with the rotated long edge direction, up to sign
    const dot = Math.abs(obb.axis[0] * ct + obb.axis[1] * st);
    expect(dot).toBeCloseTo(1, 5);
  });
});

describe('pointInRing', () => {
  const square: V2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  it('detects a point clearly inside', () => {
    expect(pointInRing([5, 5], square)).toBe(true);
  });
  it('detects a point clearly outside', () => {
    expect(pointInRing([15, 5], square)).toBe(false);
  });
  it('handles a point on an edge without throwing', () => {
    expect(() => pointInRing([5, 0], square)).not.toThrow();
  });
});

describe('ringBounds', () => {
  it('computes the bounding box', () => {
    const ring: V2[] = [[1, -2], [5, 3], [-1, 7], [4, 0]];
    expect(ringBounds(ring)).toEqual([-1, -2, 5, 7]);
  });
});

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = rng(42), b = rng(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });
  it('produces values in [0, 1)', () => {
    const r = rng(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashStr', () => {
  it('is deterministic', () => {
    expect(hashStr('richmond')).toBe(hashStr('richmond'));
  });
  it('differs for different strings', () => {
    expect(hashStr('richmond')).not.toBe(hashStr('virginia'));
  });
});

describe('MeshBuilder', () => {
  it('tri() appends 9 positions/normals/colors and computes a unit normal', () => {
    const mb = new MeshBuilder();
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(0, 0, -1);
    const c = new THREE.Vector3(1, 0, 0);
    const color = new THREE.Color(1, 0.5, 0.25);
    mb.tri(a, b, c, color);
    expect(mb.pos.length).toBe(9);
    expect(mb.nrm.length).toBe(9);
    expect(mb.col.length).toBe(9);
    // The code computes normal = (b-a) x (c-a), normalized.
    // (b-a) = (0,0,-1), (c-a) = (1,0,0) -> cross = (0,-1,0).
    const nx = mb.nrm[0], ny = mb.nrm[1], nz = mb.nrm[2];
    const len = Math.hypot(nx, ny, nz);
    expect(len).toBeCloseTo(1);
    expect(ny).toBeCloseTo(-1);
    expect(nx).toBeCloseTo(0);
    expect(nz).toBeCloseTo(0);
  });

  it('triShaded multiplies the color per vertex', () => {
    const mb = new MeshBuilder();
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(1, 0, 0);
    const c = new THREE.Vector3(0, 0, 1);
    const n = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color(1, 1, 1);
    mb.triShaded(a, b, c, color, n, 0.2, 0.5, 1.0);
    expect(mb.col.slice(0, 3)).toEqual([0.2, 0.2, 0.2]);
    expect(mb.col.slice(3, 6)).toEqual([0.5, 0.5, 0.5]);
    expect(mb.col.slice(6, 9)).toEqual([1.0, 1.0, 1.0]);
  });

  it('build() returns a BufferGeometry with count = 3 * tris', () => {
    const mb = new MeshBuilder();
    const color = new THREE.Color(1, 1, 1);
    mb.tri(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), color);
    mb.tri(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), color);
    const geom = mb.build();
    expect(geom).toBeInstanceOf(THREE.BufferGeometry);
    expect(geom.getAttribute('position').count).toBe(3 * mb.triCount);
    expect(mb.triCount).toBe(2);
  });
});
