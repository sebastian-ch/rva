import { expect, it } from 'vitest';
import { MeshBuilder, type V2 } from './geomutil';
import { addRooftopAssets, rooftopAssetsFor } from './rooftopAssets';

const outer: V2[] = [[285340, 4157510], [285370, 4157510], [285370, 4157540], [285340, 4157540]];
const local = (x: number, y: number): V2 => [x - 285340, 4157540 - y];
const asset = rooftopAssetsFor('osm:way/224601746');

it('attaches the recorded hospital pad to its own roof and rejects other roof fragments', () => {
  const roof = outer.map(([x, y]) => local(x, y));
  const mb = new MeshBuilder();
  expect(addRooftopAssets(mb, asset, roof, [], local, 130)).toBeGreaterThan(60);
  for (let i = 1; i < mb.pos.length; i += 3) expect(mb.pos[i]).toBeGreaterThanOrEqual(130);
  const rejected = new MeshBuilder();
  expect(addRooftopAssets(rejected, asset, roof, [roof], local, 130)).toBe(0);
  expect(addRooftopAssets(rejected, asset, [[100, 100], [120, 100], [120, 120], [100, 120]], [], local, 130)).toBe(0);
});
