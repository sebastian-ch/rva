import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { TrafficClient, type TrafficWorkerLike } from './trafficClient';
import { MAX_VEHICLES, POSE_STRIDE, type FromWorker, type ToWorker } from './traffic/protocol';

class FakeWorker implements TrafficWorkerLike {
  sent: ToWorker[] = [];
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  postMessage(msg: ToWorker) { this.sent.push(msg); }
  terminate = vi.fn();
  emit(m: FromWorker) { this.onmessage?.({ data: m } as MessageEvent<FromWorker>); }
}

function poses(slot: number, x: number, t: number): FromWorker {
  const buf = new Float32Array(MAX_VEHICLES * POSE_STRIDE).fill(0);
  for (let i = 0; i < MAX_VEHICLES; i++) buf[i * POSE_STRIDE + 4] = -1;
  buf[slot * POSE_STRIDE] = x; buf[slot * POSE_STRIDE + 4] = 0; buf[slot * POSE_STRIDE + 5] = 2;
  return { type: 'poses', t, buf };
}

describe('TrafficClient', () => {
  it('flattens paths into transferable buffers and forwards tile lifecycle', () => {
    const w = new FakeWorker();
    const c = new TrafficClient(() => w);
    c.addTile('t1', [[new THREE.Vector3(0, 1, 2), new THREE.Vector3(3, 4, 5)]], [{ oneway: true, width: 7, highway: 'primary', lanes: 2, bridge: false, ramp: false, wayId: 'w' }]);
    c.removeTile('t1');
    c.setPaused(true);
    expect(w.sent.map((m) => m.type)).toEqual(['addTile', 'removeTile', 'setParams']);
    const add = w.sent[0] as Extract<ToWorker, { type: 'addTile' }>;
    expect(Array.from(add.paths[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('interpolates between the last two pose buffers by wall time', () => {
    const w = new FakeWorker();
    const c = new TrafficClient(() => w);
    const spy = vi.spyOn(performance, 'now');
    spy.mockReturnValue(1000); w.emit(poses(3, 0, 0));
    spy.mockReturnValue(1050); w.emit(poses(3, 10, 50));
    const sink = { applyPoses: vi.fn() };
    spy.mockReturnValue(1075);
    c.apply(sink, 1075);
    const [prev, cur, alpha] = sink.applyPoses.mock.calls[0] as [Float32Array, Float32Array, number];
    expect(prev[3 * POSE_STRIDE]).toBe(0);
    expect(cur[3 * POSE_STRIDE]).toBe(10);
    expect(alpha).toBeCloseTo(1.5 > 1.25 ? 1.25 : 1.5, 5);
    spy.mockRestore();
  });
});
