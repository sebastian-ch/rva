import { expect, it } from 'vitest';
// Conversion tooling is JavaScript because it runs directly under Node.
// @ts-expect-error the tool intentionally has no shipped TypeScript declaration
import { bakeAtlasUvs, buildGlb, localize } from '../tools/import-i3s-object.mjs';

it('bakes per-vertex I3S atlas regions into ordinary texture coordinates', () => {
  const uv = bakeAtlasUvs(new Float32Array([0, 0, 1, 1]), new Uint16Array([
    0, 0, 32768, 32768, 32768, 32768, 65535, 65535,
  ]));
  expect(Array.from(uv)).toEqual([0, 0, 1, 1]);
});

it('projects raw node offsets and normalizes the base to a footprint anchor', () => {
  const attributes = {
    positions: { value: new Float32Array([0, 0, -2, 10, 0, 8]) },
    normals: { value: new Float32Array([0, 0, 1, 0, 0, 1]) },
  };
  const result = localize(attributes, [0, 0, 100], 'EPSG:3857', 'EPSG:3857', [0, 0]);
  expect(Array.from(result.position)).toEqual([0, 0, expect.closeTo(0, 6), 10, 10, expect.closeTo(0, 6)]);
  expect(Array.from(result.normal)).toEqual([0, 1, expect.closeTo(0, 6), 0, 1, expect.closeTo(0, 6)]);
  expect(result.base).toBe(98);
});

it('writes an embedded textured GLB', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const glb = buildGlb({
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0, 1]), texture: jpeg,
  });
  expect(glb.subarray(0, 4).toString()).toBe('glTF');
  const jsonLength = glb.readUInt32LE(12);
  const doc = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  expect(doc.images[0].mimeType).toBe('image/jpeg');
  expect(doc.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeTypeOf('number');
});
