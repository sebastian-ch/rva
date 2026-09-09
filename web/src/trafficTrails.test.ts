import { expect, it } from 'vitest';
import { TrafficTrails } from './trafficTrails';
import { MAX_VEHICLES, POSE_STRIDE } from './traffic/protocol';

it('keeps a bounded exposure and clears trails on respawn, despawn, and style changes', () => {
  const trails = new TrafficTrails();
  const poses = new Float32Array(MAX_VEHICLES * POSE_STRIDE);
  for (let i = 0; i < MAX_VEHICLES; i++) poses[i * POSE_STRIDE + 4] = -1;
  poses[4] = 0;
  const step = (x: number) => { poses[0] = x; trails.update(0.1); trails.applyPoses(null, poses, 1); };
  trails.setEnabled(true);
  for (let i = 0; i < 30; i++) step(i);
  expect(trails.lines.geometry.drawRange.count).toBe(30);
  const positions = trails.lines.geometry.getAttribute('position');
  expect(positions.getX(0)).toBe(29);
  expect(positions.getX(29)).toBe(14);
  step(1000);
  expect(trails.lines.geometry.drawRange.count).toBe(0);
  step(1001);
  expect(trails.lines.geometry.drawRange.count).toBe(2);
  poses[4] = -1; step(1002);
  expect(trails.lines.geometry.drawRange.count).toBe(0);
  poses[4] = 0; step(1); step(2);
  trails.setEnabled(false);
  expect(trails.lines.visible).toBe(false);
  expect(trails.lines.geometry.drawRange.count).toBe(0);
});
