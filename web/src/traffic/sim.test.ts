import { describe, it, expect } from 'vitest';
import { TrafficSim, idmAccel, signalLight, turnSpeed, DT } from './sim';
import { nodeKey, type CarPathMeta } from './graph';
import { MAX_VEHICLES, POSE_STRIDE } from './protocol';

const meta = (o: Partial<CarPathMeta> = {}): CarPathMeta => ({ oneway: true, width: 7, highway: 'primary', lanes: 2, bridge: false, ramp: false, wayId: 'w', ...o });
const line = (...pts: [number, number][]) => new Float32Array(pts.flatMap(([x, z]) => [x, 0, z]));

function run(sim: TrafficSim, seconds: number) { for (let i = 0; i < seconds / DT; i++) sim.step(DT); }

describe('idmAccel', () => {
  it('accelerates when free and brakes hard when the gap closes', () => {
    expect(idmAccel(0, 15, Infinity, 0, 1.4, 2.2, 1.4)).toBeCloseTo(1.4, 5);
    expect(idmAccel(15, 15, Infinity, 0, 1.4, 2.2, 1.4)).toBeCloseTo(0, 5);
    expect(idmAccel(10, 15, 3, 10, 1.4, 2.2, 1.4)).toBeLessThan(-5);
  });
  it('turnSpeed keeps straight-on free and slows right angles', () => {
    expect(turnSpeed(5, 15)).toBe(15);
    expect(turnSpeed(90, 15)).toBeCloseTo(4.1, 5);
  });
});

describe('signalLight', () => {
  it('alternates the two phase groups with yellow and an all-red clearance', () => {
    expect(signalLight(0, 0, 0)).toBe('green');
    expect(signalLight(1, 0, 0)).toBe('red');
    expect(signalLight(0, 0, 26)).toBe('yellow');
    expect(signalLight(0, 0, 29)).toBe('red');
    expect(signalLight(1, 0, 29)).toBe('red');
    expect(signalLight(1, 0, 31)).toBe('green');
    expect(signalLight(0, 10, 50)).toBe('green');
  });
});

describe('junction control', () => {
  type Handle = { s: number; v: number; edge: number };
  const tee = (sideHighway = 'residential') => {
    const sim = new TrafficSim(13);
    sim.densityScale = 0;
    return { sim, paths: [line([0, 0], [100, 0], [200, 0]), line([100, -60], [100, 0])],
      meta: [meta({ wayId: 'main', highway: 'residential' }), meta({ wayId: 'side', highway: sideHighway })] };
  };
  const edgeOf = (sim: TrafficSim, way: string) => [...sim.graph.edges.values()].find((x) => x.wayId === way && x.to === nodeKey(100, 0))!;

  it('holds a car at a red signal and puts the crossing approach in the other phase', () => {
    const sim = new TrafficSim(21);
    sim.densityScale = 0;
    sim.addTile('a', [line([0, 0], [100, 0], [200, 0]), line([100, -60], [100, 0], [100, 60])],
      [meta({ wayId: 'main' }), meta({ wayId: 'cross' })], [{ kind: 'signal', x: 90, z: 3 }]);
    const mainIn = edgeOf(sim, 'main'), crossIn = edgeOf(sim, 'cross');
    const ctl = sim.edgeControl(mainIn), other = sim.edgeControl(crossIn);
    expect(ctl.kind).toBe('signal');
    if (ctl.kind !== 'signal' || other.kind !== 'signal') return;
    expect(other.group).not.toBe(ctl.group);
    // @ts-expect-error private: start the main approach 2 s into its red
    sim.time = (((32 - ctl.offset - ctl.group * 30) % 60) + 60) % 60;
    // @ts-expect-error private
    const car = sim.spawn(mainIn, 40) as Handle;
    car.v = 10;
    run(sim, 10);
    expect(car.edge).toBe(mainIn.id);
    expect(mainIn.length - car.s).toBeLessThan(6);
    expect(car.v).toBeLessThan(0.5);
  });

  it('makes a car stop at a stop sign before turning onto the through road', () => {
    const { sim, paths, meta: m } = tee();
    sim.addTile('a', paths, m, [{ kind: 'stop', x: 104, z: -8, dx: 0, dz: 1 }]);
    const sideIn = edgeOf(sim, 'side');
    expect(sim.edgeControl(sideIn).kind).toBe('stop');
    expect(sim.edgeControl(edgeOf(sim, 'main')).kind).toBe('none');
    // @ts-expect-error private
    const car = sim.spawn(sideIn, 20) as Handle;
    car.v = 8;
    let slowest = Infinity;
    for (let i = 0; i < 12 / DT; i++) {
      sim.step(DT);
      if (car.edge === sideIn.id && sideIn.length - car.s < 4) slowest = Math.min(slowest, car.v);
    }
    expect(slowest).toBeLessThan(0.3);
    expect(car.edge).not.toBe(sideIn.id);
  });

  it('lets through traffic pass a car waiting at a stop sign', () => {
    const { sim, paths, meta: m } = tee();
    sim.addTile('a', paths, m, [{ kind: 'stop', x: 104, z: -8, dx: 0, dz: 1 }]);
    const sideIn = edgeOf(sim, 'side'), mainIn = edgeOf(sim, 'main');
    // @ts-expect-error private
    const waiting = sim.spawn(sideIn, sideIn.length - 2) as Handle;
    // @ts-expect-error private
    const through = sim.spawn(mainIn, mainIn.length - 20) as Handle;
    through.v = 8;
    for (let i = 0; i < 4 / DT; i++) { waiting.v = 0; waiting.s = sideIn.length - 2; sim.step(DT); }
    expect(through.edge).not.toBe(mainIn.id);
  });
});

describe('TrafficSim', () => {
  it('seeds toward the density target and never overlaps vehicles', () => {
    const sim = new TrafficSim(7);
    // a 1 km loop of primary road (4 sides) so vehicles keep circulating
    const sq = [line([0, 0], [1000, 0]), line([1000, 0], [1000, 1000]), line([1000, 1000], [0, 1000]), line([0, 1000], [0, 0])];
    sim.addTile('a', sq, sq.map((_, i) => meta({ wayId: `s${i}` })));
    run(sim, 60);
    const n = sim.vehicles.size;
    expect(n).toBeGreaterThan(10); // 4 km at 5/km, minus stochastic rounding and spawn gaps
    expect(n).toBeLessThanOrEqual(24);
    for (const e of sim.graph.edges.values()) {
      for (let i = 1; i < e.vehicles.length; i++) {
        const a = sim.vehicles.get(e.vehicles[i - 1])!, b = sim.vehicles.get(e.vehicles[i])!;
        expect(b.s - a.s).toBeGreaterThan(b.length * 0.5);
      }
    }
  });

  it('does not refill every short interior edge until the network is saturated', () => {
    const sim = new TrafficSim(17);
    const roads: Float32Array[] = [];
    const metadata: CarPathMeta[] = [];
    const count = 100;
    const radius = 1000;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const b = ((i + 1) / count) * Math.PI * 2;
      roads.push(line([Math.cos(a) * radius, Math.sin(a) * radius], [Math.cos(b) * radius, Math.sin(b) * radius]));
      metadata.push(meta({ wayId: `ring-${i}` }));
    }
    sim.addTile('ring', roads, metadata);
    run(sim, 300);
    // The 6.28 km ring targets about 31 cars. The old per-edge refill rule put one car on nearly every
    // short segment and kept all of them circulating, producing roughly three times the intended density.
    expect(sim.vehicles.size).toBeGreaterThan(15);
    expect(sim.vehicles.size).toBeLessThan(50);
  });

  it('lets a vehicle leave at a loaded-area boundary instead of making a U-turn', () => {
    const sim = new TrafficSim(19);
    sim.densityScale = 0;
    sim.addTile('a', [line([0, 0], [100, 0])], [meta({ oneway: false })]);
    const outbound = [...sim.graph.edges.values()].find((e) => e.from === nodeKey(0, 0))!;
    // @ts-expect-error private
    const v = sim.spawn(outbound, 90)!;
    v.v = 10;
    run(sim, 3);
    expect(sim.vehicles.size).toBe(0);
  });

  it('lets a vehicle leave where one-way roads only arrive instead of queueing traffic there', () => {
    const sim = new TrafficSim(23);
    sim.densityScale = 0;
    sim.addTile('a', [line([0, 0], [100, 0]), line([200, 0], [100, 0])], [meta({ wayId: 'a' }), meta({ wayId: 'b' })]);
    const e = [...sim.graph.edges.values()].find((x) => x.wayId === 'a')!;
    // @ts-expect-error private
    const v = sim.spawn(e, 80)!;
    v.v = 8;
    run(sim, 5);
    expect(sim.vehicles.size).toBe(0);
  });

  it('a platoon behind a stopped leader never produces a negative gap', () => {
    const sim = new TrafficSim(3);
    sim.addTile('a', [line([0, 0], [400, 0]), line([400, 0], [400, 1])], [meta({ wayId: 'a' }), meta({ wayId: 'b', highway: 'residential' })]);
    sim.densityScale = 0; // no spawning: place vehicles by hand
    const e = [...sim.graph.edges.values()].find((x) => x.wayId === 'a')!;
    // @ts-expect-error private
    const spawn = sim.spawn.bind(sim) as (edge: typeof e, s: number) => { v: number; s: number };
    const leader = spawn(e, 300); leader.v = 0;
    const followers = [250, 230, 210, 190, 170].map((s) => spawn(e, s));
    for (const f of followers) f.v = 14;
    // freeze the leader each step
    for (let i = 0; i < 20 / DT; i++) { leader.v = 0; leader.s = 300; sim.step(DT); }
    let prev = 0;
    for (const id of e.vehicles) { const v = sim.vehicles.get(id)!; expect(v.s).toBeGreaterThanOrEqual(prev); prev = v.s + v.length * 0.8; }
  });

  it('crosses a tile border and continues on the next tile', () => {
    const sim = new TrafficSim(5);
    sim.densityScale = 0;
    sim.addTile('a', [line([0, 0], [250, 0])], [meta({ wayId: 'w' })]);
    sim.addTile('b', [line([250, 0], [500, 0])], [meta({ wayId: 'w' })]);
    const ea = [...sim.graph.edges.values()].find((x) => x.tileId === 'a')!;
    // @ts-expect-error private
    const v = sim.spawn(ea, 200) as { edge: number; v: number };
    v.v = 12;
    run(sim, 10);
    expect(sim.graph.edges.get(v.edge)!.tileId).toBe('b');
  });

  it('a residential car yields at a junction to a primary car arriving on the crossing arm', () => {
    const sim = new TrafficSim(9);
    sim.densityScale = 0;
    sim.addTile('a', [line([0, 0], [100, 0], [200, 0]), line([100, -60], [100, 0], [100, 60])], [meta({ wayId: 'main' }), meta({ wayId: 'side', highway: 'residential' })]);
    const sideIn = [...sim.graph.edges.values()].find((x) => x.wayId === 'side' && x.to === nodeKey(100, 0))!;
    const mainIn = [...sim.graph.edges.values()].find((x) => x.wayId === 'main' && x.to === nodeKey(100, 0))!;
    // @ts-expect-error private
    const side = sim.spawn(sideIn, 30) as { s: number; v: number; edge: number };
    // @ts-expect-error private
    const main = sim.spawn(mainIn, 70) as { s: number; v: number; edge: number };
    side.v = 8;
    // hold the primary car 20 m short of the node: the side car must stop just before the node
    for (let i = 0; i < 6 / DT; i++) { main.s = 80; main.v = 0; sim.step(DT); }
    expect(sim.graph.arms(nodeKey(100, 0))).toBe(4);
    expect(side.edge).toBe(sideIn.id);
    expect(sideIn.length - side.s).toBeLessThan(10);
    expect(side.v).toBeLessThan(1);
  });

  it('writes poses slot-indexed with -1 for empty slots and removes vehicles with their tile', () => {
    const sim = new TrafficSim(11);
    sim.addTile('a', [line([0, 0], [600, 0])], [meta({ wayId: 'w' })]);
    run(sim, 20);
    const before = sim.vehicles.size;
    expect(before).toBeGreaterThan(0);
    const buf = new Float32Array(MAX_VEHICLES * POSE_STRIDE);
    sim.writePoses(buf);
    let live = 0;
    for (let i = 0; i < MAX_VEHICLES; i++) if (buf[i * POSE_STRIDE + 4] >= 0) live++;
    expect(live).toBe(before);
    sim.removeTile('a');
    expect(sim.vehicles.size).toBe(0);
    expect(sim.graph.edges.size).toBe(0);
  });

  it('is deterministic for a seed', () => {
    const mk = () => { const s = new TrafficSim(42); s.addTile('a', [line([0, 0], [800, 0]), line([800, 0], [0, 0])], [meta({ wayId: 'a' }), meta({ wayId: 'b' })]); run(s, 15); return [...s.vehicles.values()].map((v) => [v.edge, +v.s.toFixed(3)]); };
    expect(mk()).toEqual(mk());
  });
});
