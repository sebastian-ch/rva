import type { FC, PoiProps, PointGeom } from './types';

const MAGIC = 'POI1';
const HEADER_BYTES = 16, RECORD_BYTES = 32;
const KINDS = ['', 'tree', 'streetlight', 'bench', 'bus_stop', 'traffic_signals', 'fountain', 'monument', 'shop', 'restaurant', 'museum'];

/** Decode pipeline/poi_table.py's compact per-tile POI table. */
export function decodePoiTable(data: ArrayBuffer, bbox: [number, number, number, number]): FC<PointGeom, PoiProps> {
  if (data.byteLength < HEADER_BYTES) throw new Error('POI table is shorter than its header');
  const view = new DataView(data);
  const magic = new TextDecoder().decode(data.slice(0, 4));
  const count = view.getUint32(4, true), stringCount = view.getUint32(8, true), stringBytes = view.getUint32(12, true);
  const recordsEnd = HEADER_BYTES + count * RECORD_BYTES;
  const stringsStart = recordsEnd + (stringCount + 1) * 4;
  if (magic !== MAGIC || stringCount === 0 || stringsStart + stringBytes !== data.byteLength) throw new Error('Invalid POI table');
  const offsets = Array.from({ length: stringCount + 1 }, (_, i) => view.getUint32(recordsEnd + i * 4, true));
  if (offsets[0] !== 0 || offsets.at(-1) !== stringBytes || offsets.some((value, i) => i && value < offsets[i - 1])) throw new Error('Invalid POI string table');
  const strings = offsets.slice(0, -1).map((start, i) => new TextDecoder().decode(data.slice(stringsStart + start, stringsStart + offsets[i + 1])));
  const stringAt = (index: number): string | null => {
    if (index >= stringCount) throw new Error('Invalid POI string index');
    return index === 0 ? null : strings[index];
  };
  const [minx, miny, maxx, maxy] = bbox;
  const features = Array.from({ length: count }, (_, i) => {
    const offset = HEADER_BYTES + i * RECORD_BYTES;
    const kind = KINDS[view.getUint8(offset + 4)];
    if (!kind) throw new Error('Invalid POI kind');
    const treeHeight = view.getFloat32(offset + 24, true), crownRadius = view.getFloat32(offset + 28, true);
    const x = minx + view.getUint16(offset, true) / 100, y = miny + view.getUint16(offset + 2, true) / 100;
    if (x > maxx + 0.005 || y > maxy + 0.005) throw new Error('POI lies outside its tile');
    const props: PoiProps = { id: stringAt(view.getUint32(offset + 8, true)) ?? '', name: stringAt(view.getUint32(offset + 12, true)), kind };
    const species = stringAt(view.getUint32(offset + 16, true)), source = stringAt(view.getUint32(offset + 20, true));
    if (species !== null) props.species = species;
    if (source !== null) props.source = source;
    if (Number.isFinite(treeHeight)) props.tree_height = treeHeight;
    if (Number.isFinite(crownRadius)) props.crown_radius = crownRadius;
    return { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [x, y] as [number, number] }, properties: props };
  });
  return { type: 'FeatureCollection', features };
}
