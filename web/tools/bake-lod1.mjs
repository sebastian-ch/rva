#!/usr/bin/env node
/** Bake meshopt-compressed LOD1 geometry after `pipeline/build_tiles.py`. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { MeshoptEncoder } from 'meshoptimizer/encoder';

const web = resolve(import.meta.dirname, '..');
const tiles = resolve(web, '../data/tiles');
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : Number(args[i + 1]); };
const start = value('--start', 0), end = value('--end', Infinity);
const MAGIC = new TextEncoder().encode('IL01');
const bytes = new TextEncoder();
const response = (file) => readFile(file).then((body) => ({ ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) })).catch(() => ({ ok: false }));
globalThis.fetch = async (url) => response(join(tiles, new URL(String(url), 'http://tiles/').pathname.replace(/^\//, '')));

await MeshoptEncoder.ready;
const server = await createServer({ root: web, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { fetchTileLayers, buildTilePayload } = await server.ssrLoadModule('/src/tileBuild.ts');
const index = JSON.parse(await readFile(join(tiles, 'index.json')));
function packedPositions(value) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < value.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], value[i + k]); max[k] = Math.max(max[k], value[i + k]); }
  const scale = max.map((v, k) => Math.max(v - min[k], 1e-6));
  const out = new Uint16Array((value.length / 3) * 4);
  for (let i = 0, j = 0; i < value.length; i += 3, j += 4) for (let k = 0; k < 3; k++) out[j + k] = Math.round((value[i + k] - min[k]) / scale[k] * 65535);
  return { value: out, quant: { min, scale }, encoding: 'position16' };
}
function packedUnit(value, encoding) {
  const out = new Uint8Array((value.length / 3) * 4);
  for (let i = 0, j = 0; i < value.length; i += 3, j += 4) for (let k = 0; k < 3; k++) out[j + k] = Math.round(Math.max(0, Math.min(1, encoding === 'normal8' ? value[i + k] * .5 + .5 : value[i + k])) * 255);
  return { value: out, encoding };
}
function indexedGeometry(geom) {
  if (!geom?.position || !geom.normal || !geom.color) return geom;
  const count = geom.position.length / 3, byVertex = new Map(), keep = [], indices = [];
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    // Rounding matches the later 16-bit/8-bit streams, so vertices that decode identically share one index.
    const key = [0, 1, 2].flatMap((k) => [Math.round(geom.position[p + k] * 100), Math.round((geom.normal[p + k] * .5 + .5) * 255), Math.round(geom.color[p + k] * 255)]).join(',');
    let next = byVertex.get(key);
    if (next === undefined) { next = keep.length; byVertex.set(key, next); keep.push(i); }
    indices.push(next);
  }
  const copy = (src) => Float32Array.from(keep.flatMap((i) => Array.from(src.slice(i * 3, i * 3 + 3))));
  const index = new Uint32Array(indices);
  return { position: copy(geom.position), normal: copy(geom.normal), color: copy(geom.color), index };
}
for (const [tileIndex, meta] of index.tiles.entries()) {
  if (tileIndex < start || tileIndex >= end) continue;
  if (existsSync(join(tiles, meta.id, 'lod1.meshopt'))) continue;
  const layers = await fetchTileLayers(meta, 'http://tiles', 1);
  const payload = buildTilePayload(meta, layers, index.origin, 1);
  const segments = [], chunks = [], terrain = payload.terrain;
  let offset = 0;
  for (const [layer, sourceGeom] of Object.entries(payload.geoms)) {
    const geom = indexedGeometry(sourceGeom);
    for (const attr of ['position', 'normal', 'color', 'index', 'uv', 'facade']) {
    const value = geom?.[attr]; if (!value) continue;
    const packed = attr === 'position' ? packedPositions(value) : attr === 'normal' ? packedUnit(value, 'normal8') : attr === 'color' ? packedUnit(value, 'color8') : { value, encoding: 'raw' };
    const encoded = packed.value, type = encoded instanceof Uint8Array ? 'u8' : encoded instanceof Uint16Array ? 'u16' : 'u32';
    const itemSize = attr === 'index' ? 1 : packed.encoding === 'raw' ? (attr === 'uv' ? 2 : attr === 'facade' ? 4 : 3) : 4;
    const source = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const compressed = attr === 'index'
      ? MeshoptEncoder.encodeIndexSequence(source, encoded.length, encoded.BYTES_PER_ELEMENT)
      : MeshoptEncoder.encodeVertexBuffer(source, encoded.length / itemSize, itemSize * encoded.BYTES_PER_ELEMENT);
    segments.push({ layer, attr, count: encoded.length / itemSize, itemSize, type, encoding: attr === 'index' ? 'index-sequence' : packed.encoding, quant: packed.quant, offset, length: compressed.length }); chunks.push(compressed); offset += compressed.length;
    }
  }
  const header = bytes.encode(JSON.stringify({ terrain, segments, sourceBytes: payload.sourceBytes ?? 0, loadMs: payload.loadMs ?? 0 }));
  const out = new Uint8Array(8 + header.length + offset); out.set(MAGIC); new DataView(out.buffer).setUint32(4, header.length, true); out.set(header, 8); let at = 8 + header.length; for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  await writeFile(join(tiles, meta.id, 'lod1.meshopt'), out);
}
await server.close();
console.log(`baked LOD1 tiles ${start}..${Math.min(end, index.tiles.length)} of ${index.tiles.length}`);
