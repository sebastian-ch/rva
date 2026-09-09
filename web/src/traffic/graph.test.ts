import { describe, it, expect } from 'vitest';
import { RoadGraph, nodeKey, splitAt, type CarPathMeta } from './graph';

const meta = (o: Partial<CarPathMeta> = {}): CarPathMeta => ({ oneway: false, width: 7, highway: 'residential', lanes: 2, bridge: false, ramp: false, wayId: 'w', ...o });
const line = (...pts: [number, number][]) => new Float32Array(pts.flatMap(([x, z]) => [x, 0, z]));

describe('RoadGraph', () => {
  it('stitches a street clipped at a tile border into one node with edges from both tiles', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [250, 0])], [meta({ wayId: 'w1', oneway: true })]);
    g.addTile('b', [line([250, 0], [500, 0])], [meta({ wayId: 'w1', oneway: true })]);
    const n = g.nodes.get(nodeKey(250, 0))!;
    expect(n.in.length).toBe(1);
    expect(n.out.length).toBe(1);
    const [ea] = n.in.map((id) => g.edges.get(id)!);
    expect(g.outgoing(ea).map((e) => e.tileId)).toEqual(['b']);
  });

  it('splits a through road where a side street ends on an interior vertex', () => {
    const g = new RoadGraph();
    const main = line([0, 0], [50, 0], [100, 0]);
    const side = line([50, 0], [50, 40]);
    g.addTile('a', [main, side], [meta({ wayId: 'main' }), meta({ wayId: 'side' })]);
    // main: 2 pieces x 2 directions, side: 1 x 2 = 6 edges
    expect(g.edges.size).toBe(6);
    expect(g.arms(nodeKey(50, 0))).toBe(3);
    expect(g.arms(nodeKey(0, 0))).toBe(1);
  });

  it('splits two ways crossing at a shared interior vertex into a 4-arm junction', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [100, 0], [200, 0]), line([100, -60], [100, 0], [100, 60])], [meta({ wayId: 'ew' }), meta({ wayId: 'ns' })]);
    expect(g.arms(nodeKey(100, 0))).toBe(4);
    expect(g.edges.size).toBe(8);
  });

  it('never offers the reverse edge as a turn unless it is a dead end', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [100, 0]), line([100, 0], [200, 0])], [meta({ wayId: 'a' }), meta({ wayId: 'b' })]);
    const first = [...g.edges.values()].find((e) => e.wayId === 'a' && e.from === nodeKey(0, 0))!;
    expect(g.outgoing(first).map((e) => e.wayId)).toEqual(['b']);
    const last = [...g.edges.values()].find((e) => e.wayId === 'b' && e.to === nodeKey(200, 0))!;
    expect(g.outgoing(last).map((e) => e.from)).toEqual([nodeKey(200, 0)]); // U-turn at the dead end
  });

  it('removeTile detaches edges and drops empty nodes', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [100, 0])], [meta()]);
    g.addTile('b', [line([100, 0], [200, 0])], [meta()]);
    g.removeTile('b');
    expect(g.edges.size).toBe(2);
    expect(g.nodes.has(nodeKey(200, 0))).toBe(false);
    expect(g.nodes.get(nodeKey(100, 0))!.in.length + g.nodes.get(nodeKey(100, 0))!.out.length).toBe(2);
  });

  it('turnAngle is 0 straight on and 90 for a right-angle turn', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [100, 0]), line([100, 0], [200, 0]), line([100, 0], [100, 100])], [meta({ wayId: 'a', oneway: true }), meta({ wayId: 'b', oneway: true }), meta({ wayId: 'c', oneway: true })]);
    const a = [...g.edges.values()].find((e) => e.wayId === 'a')!;
    const b = [...g.edges.values()].find((e) => e.wayId === 'b')!;
    const c = [...g.edges.values()].find((e) => e.wayId === 'c')!;
    expect(g.turnAngle(a, b)).toBeCloseTo(0, 5);
    expect(g.turnAngle(a, c)).toBeCloseTo(90, 5);
  });

  it('poseAt offsets into the right-hand lane and reports heading', () => {
    const g = new RoadGraph();
    g.addTile('a', [line([0, 0], [100, 0])], [meta({ oneway: true, width: 8 })]);
    const e = [...g.edges.values()][0];
    const out = new Float32Array(6);
    g.poseAt(e, 50, out, 0);
    expect(out[0]).toBeCloseTo(50, 3);
    expect(out[2]).toBeCloseTo(-2, 3); // +x travel: right-hand lane is -z (south)
    expect(out[3]).toBeCloseTo(0, 5);
  });

  it('splitAt cuts only at interior vertices that are known nodes', () => {
    const p = line([0, 0], [10, 0], [20, 0], [30, 0]);
    expect(splitAt(p, new Set([nodeKey(20, 0)])).map((s) => s.length / 3)).toEqual([3, 2]);
    expect(splitAt(p, new Set()).length).toBe(1);
  });
});
