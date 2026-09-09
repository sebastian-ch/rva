import { STYLE_IDS } from './styles';
import { describe, expect, it } from 'vitest';
import { decodeView, encodeView, searchPlaces, type ViewState } from './navigation';

const view: ViewState = { region: 'richmond', x: 284234.12, y: 4156123.45, z: 45, zoom: 2.6, az: -1.57,
  distance: 1800, night: true, map: false, style: 'risograph', building: 'way/123 & test' };

describe('shareable views', () => {
  it('round-trips camera, style, and escaped selection', () => {
    for (const style of STYLE_IDS) {
      expect(decodeView(encodeView({ ...view, style }), 'richmond')).toEqual({ ...view, style });
    }
  });
  it('rejects other regions, missing coordinates, and invalid camera values', () => {
    expect(decodeView(encodeView(view), 'honolulu')).toBeNull();
    expect(decodeView(encodeView(view).replace(/&x=[^&]*/, ''), 'richmond')).toBeNull();
    expect(decodeView(encodeView({ ...view, zoom: -1 }), 'richmond')).toBeNull();
    expect(decodeView(encodeView({ ...view, x: Infinity }), 'richmond')).toBeNull();
  });
});

it('finds words across names and addresses and ranks exact matches first', () => {
  const places = [
    { id: 'a', name: 'Main Street Station', addr: '1500 E Main St', x: 0, y: 0, ground_z: 0 },
    { id: 'b', name: 'Main', addr: '1 Broad St', x: 0, y: 0, ground_z: 0 },
  ];
  expect(searchPlaces(places, ' MAIN ').map((p) => p.id)).toEqual(['b', 'a']);
  expect(searchPlaces(places, 'station 1500').map((p) => p.id)).toEqual(['a']);
  expect(searchPlaces(places, '')).toEqual([]);
});
