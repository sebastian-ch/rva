import { describe, it, expect } from 'vitest';
import { TrafficSim, idmAccel, turnSpeed, DT } from './sim';
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

describe('TrafficSim', () => {
  it('spawns toward the density target and never overlaps vehicles', () => {
    const sim = new TrafficSim(7);
    // a 1 km loop of primary road (4 sides) so vehicles keep circulating
    const sq = [line([0, 0], [1000, 0]), line([1000, 0], [1000, 1000]), line([1000, 1000], [0, 1000]), line([0, 1000], [0, 0])];
    sim.addTile('a', sq, sq.map((_, i) => meta({ wayId: `s${i}` })));
    run(sim, 60);
    const n = sim.vehicles.size;
    expect(n).toBeGreaterThan(15); // 4 km at 9/km, minus spawn gaps
    expect(n).toBeLessThanOrEqual(40);
    for (const e of sim.graph.edges.values()) {
      for (let i = 1; i < e.vehicles.length; i++) {
        const a = sim.vehicles.get(e.vehicles[i - 1])!, b = sim.vehicles.get(e.vehicles[i])!;
        expect(b.s - a.s).toBeGreaterThan(b.length * 0.5);
      }
    }
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
