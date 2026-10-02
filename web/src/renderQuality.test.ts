import { describe, expect, it } from 'vitest';
import { AdaptiveResolution } from './renderQuality';

function runFrames(quality: AdaptiveResolution, frameMs: number, start: number, count = 120, eligible = true) {
  const changes: number[] = [];
  let now = start;
  for (let i = 0; i < count; i++) {
    now += frameMs;
    const ratio = quality.sample(frameMs, now, eligible);
    if (ratio !== null) changes.push(ratio);
  }
  return { changes, now };
}

describe('adaptive mobile resolution', () => {
  it('starts sharper than 1x without exceeding native density or the 2x cap', () => {
    expect(new AdaptiveResolution(3).pixelRatio).toBe(1.5);
    expect(new AdaptiveResolution(1.25).pixelRatio).toBe(1.25);
    expect(new AdaptiveResolution(1).pixelRatio).toBe(1);
  });

  it('raises resolution after sustained smooth frames and stops at the cap', () => {
    const quality = new AdaptiveResolution(3);
    const first = runFrames(quality, 16, 4000);
    expect(first.changes).toEqual([2]);
    expect(runFrames(quality, 16, first.now + 5000).changes).toEqual([]);
    expect(quality.pixelRatio).toBe(2);
  });

  it('steps down under sustained load, waits between changes, and stops at 1x', () => {
    const quality = new AdaptiveResolution(3);
    runFrames(quality, 16, 4000);
    const slow = runFrames(quality, 40, 11000, 40);
    expect(slow.changes).toEqual([1.5]);
    expect(runFrames(quality, 40, slow.now, 30).changes).toEqual([]);
    expect(runFrames(quality, 40, slow.now + 5000, 40).changes).toEqual([1]);
    expect(runFrames(quality, 40, 30000).changes).toEqual([]);
  });

  it('holds resolution for borderline performance rather than oscillating', () => {
    const quality = new AdaptiveResolution(3);
    expect(runFrames(quality, 24, 4000).changes).toEqual([]);
    expect(quality.pixelRatio).toBe(1.5);
  });

  it('ignores loading, hidden tabs, and long pauses and gives recovery time', () => {
    const quality = new AdaptiveResolution(3);
    const loading = runFrames(quality, 80, 4000, 100, false);
    expect(loading.changes).toEqual([]);
    expect(runFrames(quality, 40, loading.now, 50).changes).toEqual([]);
    quality.sample(1000, 18000, true);
    expect(runFrames(quality, 40, 18000, 50).changes).toEqual([]);
    expect(quality.pixelRatio).toBe(1.5);
  });

  it('does not react to one dropped frame in an otherwise smooth window', () => {
    const quality = new AdaptiveResolution(3);
    quality.sample(120, 4120, true);
    const remaining = runFrames(quality, 16, 4120, 90);
    expect(remaining.changes).toEqual([2]);
  });
});
