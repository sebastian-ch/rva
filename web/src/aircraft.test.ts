import { describe, expect, it } from 'vitest';
import { altitudeFeet, predictedCoords, toUtm, type AircraftItem } from './aircraft';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const item: AircraftItem = {
  id: 'aircraft:test', type: 'aircraft', title: 'Test', coords: [-77.436048, 37.540725],
  when: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 90_000).toISOString(),
  groundSpeed: 120, heading: 90, aircraftKind: 'airplane',
  details: [['Altitude', '1,250 ft (barometric)']],
};

describe('aircraft feed conversion', () => {
  it('prefers structured altitude and supports the current labeled compatibility value', () => {
    expect(altitudeFeet(item)).toBe(1250);
    expect(altitudeFeet({ ...item, altitudeGeomFeet: 1310 })).toBe(1310);
    expect(altitudeFeet({ ...item, details: [['Altitude', 'ground']] })).toBeNull();
  });

  it('projects Richmond coordinates to UTM 18N', () => {
    const [x, y] = toUtm(-77.436048, 37.540725, 18);
    expect(x).toBeCloseTo(284777.681, 2);
    expect(y).toBeCloseTo(4157648.304, 2);
  });

  it('predicts motion for at most 45 seconds and expires stale records', () => {
    const moved = predictedCoords(item, NOW + 10_000)!;
    expect(moved[0]).toBeGreaterThan(item.coords![0]);
    expect(moved[1]).toBeCloseTo(item.coords![1], 4);
    expect(predictedCoords(item, NOW + 45_000)).toEqual(predictedCoords(item, NOW + 80_000));
    expect(predictedCoords(item, NOW + 90_000)).toBeNull();
    expect(predictedCoords({ ...item, expiresAt: undefined }, NOW + 90_000)).toBeNull();
    expect(predictedCoords({ ...item, when: 'invalid', expiresAt: undefined }, NOW)).toBeNull();
  });
});
