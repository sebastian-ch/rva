import { describe, expect, it } from 'vitest';
import { decodePoiTable } from './poiTable';

function table(): ArrayBuffer {
  const strings = new TextEncoder().encode('tree-1Quercus alba');
  const buffer = new ArrayBuffer(16 + 32 + 16 + strings.length);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set(new TextEncoder().encode('POI1'));
  view.setUint32(4, 1, true); view.setUint32(8, 3, true); view.setUint32(12, strings.length, true);
  view.setUint16(16, 1234, true); view.setUint16(18, 5678, true); view.setUint8(20, 1);
  view.setUint32(24, 1, true); view.setUint32(32, 2, true); view.setFloat32(40, 9.5, true); view.setFloat32(44, 2.25, true);
  view.setUint32(48, 0, true); view.setUint32(52, 0, true); view.setUint32(56, 6, true); view.setUint32(60, strings.length, true);
  new Uint8Array(buffer, 64).set(strings);
  return buffer;
}

describe('decodePoiTable', () => {
  it('restores quantized positions and optional tree attributes', () => {
    expect(decodePoiTable(table(), [100, 200, 350, 450]).features).toEqual([{
      type: 'Feature', geometry: { type: 'Point', coordinates: [112.34, 256.78] },
      properties: { id: 'tree-1', name: null, kind: 'tree', species: 'Quercus alba', tree_height: 9.5, crown_radius: 2.25 },
    }]);
  });

  it('reads the height slot as a pole height for surveyed poles', () => {
    const pole = table();
    new DataView(pole).setUint8(20, 12);
    const props = decodePoiTable(pole, [100, 200, 350, 450]).features[0].properties;
    expect(props.kind).toBe('utility_pole');
    expect(props.pole_height).toBe(9.5);
    expect(props.tree_height).toBeUndefined();
  });

  it('rejects malformed payloads', () => {
    expect(() => decodePoiTable(new ArrayBuffer(16), [0, 0, 250, 250])).toThrow('Invalid POI table');
    const badIndex = table();
    new DataView(badIndex).setUint32(24, 9, true);
    expect(() => decodePoiTable(badIndex, [100, 200, 350, 450])).toThrow('Invalid POI string index');
  });
});
