import { describe, it, expect } from 'vitest';
import { PROP_KINDS, VEHICLE_KINDS, buildPropGeometry, buildPalm } from './props';

function hasNaN(arr: ArrayLike<number>): boolean {
  for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) return true;
  return false;
}

const VEHICLE_SPEC: Record<string, { length: number; width: number }> = {
  car: { length: 4.5, width: 1.8 },
  suv: { length: 4.7, width: 1.9 },
  pickup: { length: 5.3, width: 1.9 },
  van: { length: 5.0, width: 2.0 },
};

describe('buildPropGeometry', () => {
  it('palms fit the instanced prop budget with finite geometry and distinct heights', () => {
    const heights = [false, true].map((tall) => {
      const geom = buildPalm(tall);
      expect(geom.attributes.position.count).toBeLessThan(600);
      for (const attribute of Object.values(geom.attributes)) {
        expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
      }
      geom.computeBoundingBox();
      const height = geom.boundingBox!.max.y;
      expect(geom.boundingBox!.min.y).toBeGreaterThan(-0.01);
      geom.dispose();
      return height;
    });
    expect(heights[1]).toBeGreaterThan(heights[0]);
  });
  for (const kind of PROP_KINDS) {
    it(`builds a valid geometry for "${kind}"`, () => {
      const geom = buildPropGeometry(kind);
      const pos = geom.attributes.position;
      const nrm = geom.attributes.normal;
      const col = geom.attributes.color;
      expect(pos).toBeDefined();
      expect(nrm).toBeDefined();
      expect(col).toBeDefined();

      expect(hasNaN(pos.array)).toBe(false);
      expect(hasNaN(nrm.array)).toBe(false);
      expect(hasNaN(col.array)).toBe(false);

      expect(pos.count).toBeLessThan(600);

      let minY = Infinity;
      for (let i = 0; i < pos.count; i++) minY = Math.min(minY, pos.getY(i));
      expect(minY).toBeGreaterThanOrEqual(-0.01);
    });
  }

  it('traffic_light stays under 200 vertices', () => {
    const geom = buildPropGeometry('traffic_light');
    expect(geom.attributes.position.count).toBeLessThan(200);
  });

  it('car with bodyWhite has some white-colored vertices', () => {
    const geom = buildPropGeometry('car', undefined, true);
    const col = geom.attributes.color;
    let sawWhite = false;
    for (let i = 0; i < col.count; i++) {
      if (col.getX(i) === 1 && col.getY(i) === 1 && col.getZ(i) === 1) {
        sawWhite = true;
        break;
      }
    }
    expect(sawWhite).toBe(true);
  });

  it('car without bodyWhite has no white-colored vertices from the body', () => {
    const geom = buildPropGeometry('car', 'brick', false);
    const col = geom.attributes.color;
    let sawWhite = false;
    for (let i = 0; i < col.count; i++) {
      if (col.getX(i) === 1 && col.getY(i) === 1 && col.getZ(i) === 1) {
        sawWhite = true;
        break;
      }
    }
    expect(sawWhite).toBe(false);
  });

  it('VEHICLE_KINDS lists exactly the four vehicle body kinds', () => {
    expect(VEHICLE_KINDS).toEqual(['car', 'suv', 'pickup', 'van']);
  });

  for (const kind of VEHICLE_KINDS) {
    const spec = VEHICLE_SPEC[kind];

    it(`${kind} matches its spec length/width and has white + glass vertices`, () => {
      const geom = buildPropGeometry(kind);
      const pos = geom.attributes.position;
      const col = geom.attributes.color;

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      let sawWhite = false;
      let sawGlass = false;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);

        const r = col.getX(i);
        const g = col.getY(i);
        const b = col.getZ(i);
        if (r === 1 && g === 1 && b === 1) sawWhite = true;
        if (g > r && b > r) sawGlass = true;
      }

      const length = maxX - minX;
      const width = maxZ - minZ;
      expect(Math.abs(length - spec.length)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(width - spec.width)).toBeLessThanOrEqual(0.2);
      expect(sawWhite).toBe(true);
      expect(sawGlass).toBe(true);
    });
  }
});
