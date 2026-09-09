import { describe, expect, it } from 'vitest';
import { bridgeLift, deckHeight, parseDeck } from './roads';

describe('bridge decks', () => {
  it('parses the pipeline deck string and rejects bad input', () => {
    expect(parseDeck('[0,0,10,100,0,20]')).toEqual({ x0: 0, y0: 0, z0: 10, x1: 100, y1: 0, z1: 20 });
    expect(parseDeck([0, 0, 10, 100, 0, 20])).toEqual({ x0: 0, y0: 0, z0: 10, x1: 100, y1: 0, z1: 20 });
    expect(parseDeck(null)).toBeNull();
    expect(parseDeck('nope')).toBeNull();
    expect(parseDeck('[1,2,3]')).toBeNull();
  });
  it('interpolates deck height between the banks and clamps beyond the ends', () => {
    const d = parseDeck('[0,0,10,100,0,20]')!;
    expect(deckHeight(d, 0, 0)).toBeCloseTo(10);
    expect(deckHeight(d, 50, 0)).toBeCloseTo(15);
    expect(deckHeight(d, 50, 30)).toBeCloseTo(15); // off-axis points project onto the deck line
    expect(deckHeight(d, 150, 0)).toBeCloseTo(20);
    expect(deckHeight(d, -50, 0)).toBeCloseTo(10);
  });
  it('lifts decks by a thickness only, so bridges meet their approaches at grade', () => {
    expect(bridgeLift(1)).toBeGreaterThan(0);
    expect(bridgeLift(1)).toBeLessThan(1.5);
    expect(bridgeLift(0)).toBe(bridgeLift(2));
  });
});
