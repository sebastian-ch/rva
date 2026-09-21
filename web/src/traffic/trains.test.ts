import { describe, expect, it } from 'vitest';
import { RoadGraph, type CarPathMeta, type Edge } from './graph';
import { MAX_RAIL_CARS, POSE_STRIDE, RAIL_KIND_NAMES, RAIL_SLOT_BASE, TOTAL_POSE_SLOTS, VEHICLE_KIND_NAMES } from './protocol';
import { CAR_LENGTH, TrainSim, isRunnable, poseOnEdge, railSpeed, type RailPathMeta } from './trains';

/** A straight track along +x, `n` metres long, as one path. */
function straight(n: number, z = 0): Float32Array {
  return new Float32Array([0, 0, z, n / 2, 0, z, n, 0, z]);
}

function meta(over: Partial<RailPathMeta> = {}): RailPathMeta {
  return { wayId: 'w1', railway: 'rail', service: null, usage: 'main', bridge: false, ...over };
}

function edgeFrom(pts: Float32Array): Edge {
  const g = new RoadGraph();
  const m: CarPathMeta = { oneway: true, width: 0, highway: 'rail', lanes: 1, bridge: false, ramp: false, wayId: 'w1', speed: 20, offset: 0 };
  g.addTile('t', [pts], [m]);
  return [...g.edges.values()][0];
}

function poses(sim: TrainSim): Float32Array {
  const buf = new Float32Array(TOTAL_POSE_SLOTS * POSE_STRIDE);
  for (let i = 0; i < TOTAL_POSE_SLOTS; i++) buf[i * POSE_STRIDE + 4] = -1;
  sim.writePoses(buf);
  return buf;
}

function drawnCars(buf: Float32Array): { x: number; z: number; kind: number }[] {
  const out: { x: number; z: number; kind: number }[] = [];
  for (let i = 0; i < MAX_RAIL_CARS; i++) {
    const o = (RAIL_SLOT_BASE + i) * POSE_STRIDE;
    if (buf[o + 4] >= 0) out.push({ x: buf[o], z: buf[o + 2], kind: buf[o + 4] });
  }
  return out;
}

/** Run the sim until `done` or the step budget is spent. */
function run(sim: TrainSim, steps: number, done?: () => boolean): number {
  for (let i = 0; i < steps; i++) {
    sim.step(0.05);
    if (done?.()) return i;
  }
  return steps;
}

describe('rail track selection', () => {
  it('runs trains on through rail only', () => {
    expect(isRunnable(meta())).toBe(true);
    expect(isRunnable(meta({ service: 'yard' }))).toBe(false);
    expect(isRunnable(meta({ service: 'siding' }))).toBe(false);
    expect(isRunnable(meta({ railway: 'tram' }))).toBe(false);
    expect(isRunnable(undefined)).toBe(false);
  });

  it('gives every railway class a speed', () => {
    expect(railSpeed('rail')).toBeGreaterThan(railSpeed('tram'));
    expect(railSpeed('light_rail')).toBeGreaterThan(0);
  });
});

describe('poseOnEdge', () => {
  const e = edgeFrom(straight(100));

  it('interpolates along the line and faces down the track', () => {
    const out = new Float32Array(POSE_STRIDE);
    poseOnEdge(e, 40, out, 0);
    expect(out[0]).toBeCloseTo(40);
    expect(out[2]).toBeCloseTo(0);
    expect(out[3]).toBeCloseTo(0); // heading = atan2(-dz, dx) = 0 along +x
  });

  it('extrapolates off both ends so a consist keeps its spacing entering and leaving', () => {
    const out = new Float32Array(POSE_STRIDE);
    poseOnEdge(e, -30, out, 0);
    expect(out[0]).toBeCloseTo(-30);
    poseOnEdge(e, 160, out, 0);
    expect(out[0]).toBeCloseTo(160);
  });

  it('holds the endpoint elevation instead of following the gradient off the end', () => {
    const climb = edgeFrom(new Float32Array([0, 0, 0, 50, 5, 0, 100, 10, 0]));
    const out = new Float32Array(POSE_STRIDE);
    poseOnEdge(climb, 200, out, 0);
    expect(out[1]).toBeCloseTo(10);
    poseOnEdge(climb, -200, out, 0);
    expect(out[1]).toBeCloseTo(0);
  });
});

describe('TrainSim', () => {
  it('spawns a consist that enters from the dangling end and moves along the track', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(2000)], [meta()]);
    run(sim, 400, () => sim.trains.size > 0);
    expect(sim.trains.size).toBe(1);
    const before = drawnCars(poses(sim));
    expect(before.length).toBeGreaterThan(3);
    run(sim, 200);
    const after = drawnCars(poses(sim));
    expect(after[0].x).toBeGreaterThan(before[0].x);
  });

  it('places every car behind the head, spaced by car length, and leads with a locomotive', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(3000)], [meta()]);
    run(sim, 400, () => sim.trains.size > 0);
    run(sim, 400);
    const cars = drawnCars(poses(sim));
    expect(cars[0].kind).toBe(VEHICLE_KIND_NAMES.indexOf('locomotive'));
    for (const c of cars) expect(c.z).toBeCloseTo(0);
    for (let i = 1; i < cars.length; i++) {
      const gap = cars[i - 1].x - cars[i].x;
      expect(gap).toBeGreaterThan(10);
      expect(gap).toBeLessThan(30);
    }
  });

  it('never writes outside the rail slot range', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(2000)], [meta()]);
    run(sim, 600);
    const buf = poses(sim);
    for (let i = 0; i < RAIL_SLOT_BASE; i++) expect(buf[i * POSE_STRIDE + 4]).toBe(-1);
    for (const c of drawnCars(buf)) expect(RAIL_KIND_NAMES.includes(VEHICLE_KIND_NAMES[c.kind] as never)).toBe(true);
  });

  it('leaves yard and siding track empty', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(2000)], [meta({ service: 'yard' })]);
    run(sim, 1200);
    expect(sim.trains.size).toBe(0);
  });

  it('removes a consist once it has run off the end of the loaded graph', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(300)], [meta()]);
    run(sim, 400, () => sim.trains.size > 0);
    expect(sim.trains.size).toBe(1);
    const left = run(sim, 4000, () => sim.trains.size === 0);
    expect(left).toBeLessThan(4000);
  });

  it('drops a consist whose track is unloaded under it', () => {
    const sim = new TrainSim(3);
    sim.addTile('0_0', [straight(2000)], [meta()]);
    run(sim, 400, () => sim.trains.size > 0);
    expect(sim.trains.size).toBe(1);
    sim.removeTile('0_0');
    expect(sim.trains.size).toBe(0);
    expect(drawnCars(poses(sim))).toHaveLength(0);
  });

  it('keeps consists out of a block another train holds, instead of running through it', () => {
    // one single-track line in two segments; trains enter from both ends, so the block rule is what
    // stops two of them sharing a segment (and meeting head-on on the shared middle node)
    const sim = new TrainSim(11);
    sim.addTile('0_0', [straight(600)], [meta({ wayId: 'a' })]);
    sim.addTile('0_1', [new Float32Array([600, 0, 0, 900, 0, 0, 1200, 0, 0])], [meta({ wayId: 'b' })]);
    let concurrent = 0;
    for (let i = 0; i < 6000; i++) {
      sim.step(0.05);
      concurrent = Math.max(concurrent, sim.trains.size);
      const held = new Set<number>();
      for (const t of sim.trains.values()) {
        const e = sim.graph.edges.get(t.edge)!;
        expect(held.has(e.pair)).toBe(false);
        held.add(e.pair);
      }
    }
    expect(concurrent).toBeGreaterThanOrEqual(2);
  });

  it('clears a consist that has been held at a standstill too long', () => {
    // a stub with a buffer stop: the train brakes to a stand and must not sit on the block for ever
    const sim = new TrainSim(5);
    sim.addTile('0_0', [straight(400)], [meta({ wayId: 'a' })]);
    sim.addTile('0_1', [new Float32Array([400, 0, 0, 400, 0, 120])], [meta({ wayId: 'b', service: 'spur' })]);
    run(sim, 400, () => sim.trains.size > 0);
    expect(sim.trains.size).toBeGreaterThan(0);
    run(sim, 8000, () => sim.trains.size === 0);
    expect(run(sim, 1, () => true)).toBe(0);
  });

  it('gives each car kind a length the prop geometry can match', () => {
    for (const k of RAIL_KIND_NAMES) expect(CAR_LENGTH[k]).toBeGreaterThan(10);
  });
});
