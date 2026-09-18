import { MeshoptDecoder } from 'meshoptimizer/decoder';
import type { GeomArrays, TilePayload } from './tileBuild';
import type { TileMeta, TerrainGrid } from './types';

const MAGIC = 'IL01', decoder = new TextDecoder(), encoder = new TextEncoder();
type Segment = { layer: string; attr: keyof GeomArrays; count: number; itemSize: number; type: 'u8' | 'u16' | 'u32'; encoding: 'raw' | 'position16' | 'normal8' | 'color8' | 'index-sequence'; quant?: { min: number[]; scale: number[] }; offset: number; length: number };
type Header = { terrain: TerrainGrid | null; segments: Segment[]; sourceBytes: number; loadMs: number };

/** Decode the meshopt LOD1 artifact produced by tools/bake-lod1.mjs. */
export async function decodeLod1(data: ArrayBuffer, meta: TileMeta): Promise<TilePayload> {
  const view = new DataView(data);
  if (data.byteLength < 8 || decoder.decode(data.slice(0, 4)) !== MAGIC) throw new Error('invalid LOD1 artifact');
  const headerBytes = view.getUint32(4, true), headerEnd = 8 + headerBytes;
  if (headerEnd > data.byteLength) throw new Error('invalid LOD1 header');
  const header = JSON.parse(decoder.decode(data.slice(8, headerEnd))) as Header;
  await MeshoptDecoder.ready;
  const geoms: TilePayload['geoms'] = {};
  for (const s of header.segments) {
    if (headerEnd + s.offset + s.length > data.byteLength) throw new Error('invalid LOD1 segment');
    const stride = s.itemSize * (s.type === 'u8' ? 1 : s.type === 'u16' ? 2 : 4), target = new Uint8Array(s.count * stride);
    const source = new Uint8Array(data, headerEnd + s.offset, s.length);
    if (s.attr === 'index') MeshoptDecoder.decodeIndexSequence(target, s.count, stride, source);
    else MeshoptDecoder.decodeVertexBuffer(target, s.count, stride, source);
    const packed = s.type === 'u8' ? new Uint8Array(target.buffer) : s.type === 'u16' ? new Uint16Array(target.buffer) : new Uint32Array(target.buffer);
    let value: Float32Array | Uint16Array | Uint32Array;
    if (s.encoding === 'position16') {
      if (!s.quant) throw new Error('missing LOD1 position range');
      value = new Float32Array(s.count * 3);
      for (let i = 0, j = 0; i < value.length; i += 3, j += 4) for (let k = 0; k < 3; k++) value[i + k] = s.quant.min[k] + packed[j + k] / 65535 * s.quant.scale[k];
    } else if (s.encoding === 'normal8' || s.encoding === 'color8') {
      value = new Float32Array(s.count * 3);
      for (let i = 0, j = 0; i < value.length; i += 3, j += 4) for (let k = 0; k < 3; k++) value[i + k] = s.encoding === 'normal8' ? packed[j + k] / 255 * 2 - 1 : packed[j + k] / 255;
    } else value = packed as Uint16Array | Uint32Array;
    const layer = s.layer as keyof TilePayload['geoms'];
    const geom = geoms[layer] ?? (geoms[layer] = {} as GeomArrays);
    (geom as unknown as Record<string, unknown>)[s.attr] = value;
  }
  return { meta, lod: 1, terrain: header.terrain, geoms, ranges: [], placements: [], carPaths: [], carMeta: [], walkPaths: [], buildingFeatures: [], buildMs: 0, loadMs: header.loadMs, sourceBytes: header.sourceBytes };
}

export function isLod1Artifact(data: ArrayBuffer): boolean { return data.byteLength >= 4 && decoder.decode(data.slice(0, 4)) === MAGIC; }
export { MAGIC, encoder };
