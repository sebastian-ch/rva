/**
 * Trains running on the rail graph. The track network reuses RoadGraph (nodes snapped in the local frame, ways
 * split where they share a vertex) but runs on the centreline at rail speeds instead of in a right-hand lane.
 *
 * A train is one consist: a head position along the graph plus a list of cars placed by arc length behind it,
 * walking back through the edges the head already traversed. Single track is protected by an undirected block
 * rule -- a train never enters a segment (pair id) another train occupies -- which is what keeps two consists
 * from meeting head-on where the same rails carry both directions.
 */
import { RoadGraph, type CarPathMeta, type Edge } from './graph';
import { idmAccel, rng } from './sim';
import {
  MAX_RAIL_CARS, POSE_STRIDE, RAIL_COLOR_WEIGHTS, RAIL_SLOT_BASE, VEHICLE_KIND_NAMES, type RailKindName,
} from './protocol';

export interface RailPathMeta {
  wayId: string;
  railway: string;
  /** OSM service: yard, siding, spur, crossover. Absent on running track. */
  service: string | null;
  usage: string | null;
  bridge: boolean;
}

/** Track speed (m/s) by railway class; urban freight and the A-line through Richmond are slow. */
export function railSpeed(railway: string): number {
  switch (railway) {
    case 'light_rail': return 16;
    case 'subway': return 18;
    case 'tram': return 11;
    default: return 20;
  }
}

/** Track a train may run on: through rail, not a yard throat, siding or industrial spur. */
export function isRunnable(m: RailPathMeta | undefined): boolean {
  return !!m && m.railway === 'rail' && !m.service;
}

/** Body length per car kind, in metres. */
export const CAR_LENGTH: Record<RailKindName, number> = {
  locomotive: 21, boxcar: 18, hopper: 16, tank_car: 16, coach: 26,
};
const COUPLER = 1.2;        // m of slack drawn between car bodies
const RAIL_LIFT = 0.12;     // m: wheels sit on the railhead, not on the tie ribbon
const FREIGHT_MIX: [RailKindName, number][] = [['boxcar', 45], ['hopper', 30], ['tank_car', 25]];
const PASSENGER_SHARE = 0.3;
const MAX_TRAINS = 3;
const A = 0.35;             // m/s^2 acceleration
const B = 0.6;              // m/s^2 service braking
const T_HEADWAY = 6;        // s
const S0 = 40;              // m standstill gap ahead of an occupied block
const LOOKAHEAD = 600;      // m of route searched for the next occupied block
const RESERVE = 90;         // m before a node where a train claims the block beyond it
const ROUTE_AHEAD = 8;      // edges planned ahead
const MAX_TURN_DEG = 55;    // a switch is shallow: a train never takes a sharp branch
const SPAWN_INTERVAL = 6;   // s between spawn attempts
const SPAWN_CHANCE = 0.5;
const STALL_S = 45;         // s stopped before a consist gives up and leaves the simulation
const MIN_ENTRY_LENGTH = 60; // m of track needed at a boundary to admit a train

const KIND_INDEX = Object.fromEntries(VEHICLE_KIND_NAMES.map((k, i) => [k, i])) as Record<string, number>;
const COLOR_ITEMS: [number, number][] = RAIL_COLOR_WEIGHTS.map((w, i) => [i, w]);

interface TrainCar {
  kind: RailKindName;
  length: number;
  color: number;
  slot: number;
  /** distance from the head of the consist to the centre of this car */
  centre: number;
}

export interface Train {
  id: number;
  cars: TrainCar[];
  /** total consist length, head coupler to rear coupler */
  length: number;
  edge: number;
  s: number;
  v: number;
  desire: number;
  route: number[];
  /** edges already traversed, newest first, kept long enough to place the rear car */
  behind: number[];
  /** the head has run off the end of the graph; the tail is still coming */
  exiting: boolean;
  /** seconds held at a standstill, so a buffer stop or a head-on standoff clears itself */
  waitS: number;
}

function pickWeighted<T>(items: [T, number][], r: number): T {
  const total = items.reduce((a, b) => a + b[1], 0);
  let x = r * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1][0];
}

/**
 * Position and heading at arc length `s` along an edge, extrapolated along the end tangent when `s` falls off
 * either end. A consist entering or leaving the loaded graph keeps its shape that way instead of bunching up;
 * the extrapolated elevation is held at the endpoint rather than following the gradient off into the air.
 */
export function poseOnEdge(e: Edge, s: number, out: Float32Array, o: number): void {
  const p = e.pts, cum = e.cum, n = cum.length;
  if (s <= 0 || n < 2) {
    const dx = p[3] - p[0], dz = p[5] - p[2];
    const l = Math.hypot(dx, dz) || 1;
    out[o] = p[0] + (dx / l) * s;
    out[o + 1] = p[1];
    out[o + 2] = p[2] + (dz / l) * s;
    out[o + 3] = Math.atan2(-dz, dx);
    return;
  }
  const end = cum[n - 1];
  if (s >= end) {
    const a = (n - 2) * 3, b = (n - 1) * 3;
    const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
    const l = Math.hypot(dx, dz) || 1;
    out[o] = p[b] + (dx / l) * (s - end);
    out[o + 1] = p[b + 1];
    out[o + 2] = p[b + 2] + (dz / l) * (s - end);
    out[o + 3] = Math.atan2(-dz, dx);
    return;
  }
  let i = 1;
  while (i < n - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1];
  const f = seg > 0 ? (s - cum[i - 1]) / seg : 0;
  const a = (i - 1) * 3, b = i * 3;
  const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
  out[o] = p[a] + dx * f;
  out[o + 1] = p[a + 1] + (p[b + 1] - p[a + 1]) * f;
  out[o + 2] = p[a + 2] + dz * f;
  out[o + 3] = Math.atan2(-dz, dx);
}

export class TrainSim {
  readonly graph = new RoadGraph();
  readonly trains = new Map<number, Train>();
  /** rail meta by OSM way id; a way crossing a tile border carries the same meta in both tiles */
  private meta = new Map<string, RailPathMeta>();
  private free: number[] = [];
  private blocks = new Map<number, number>();
  private rand: () => number;
  private nextId = 1;
  private spawnClock = 0;
  paused = false;

  constructor(seed = 7) {
    this.rand = rng(seed);
    for (let i = MAX_RAIL_CARS - 1; i >= 0; i--) this.free.push(i);
  }

  reseed(seed: number) { this.rand = rng(seed); }

  addTile(tileId: string, paths: Float32Array[], meta: RailPathMeta[]) {
    const carMeta: CarPathMeta[] = meta.map((m) => {
      this.meta.set(m.wayId, m);
      return {
        oneway: false, width: 0, highway: m.railway, lanes: 1, bridge: m.bridge, ramp: false,
        wayId: m.wayId, speed: railSpeed(m.railway), offset: 0,
      };
    });
    this.graph.addTile(tileId, paths, carMeta);
  }

  removeTile(tileId: string) {
    const gone = new Set(this.graph.removeTile(tileId));
    for (const t of [...this.trains.values()]) {
      if (gone.has(t.edge)) this.despawn(t);
      else {
        t.route = t.route.filter((id) => !gone.has(id));
        const cut = t.behind.findIndex((id) => gone.has(id));
        if (cut >= 0) t.behind.length = cut; // history stops where the graph does; the tail extrapolates
      }
    }
  }

  private runnable(e: Edge): boolean { return isRunnable(this.meta.get(e.wayId)); }

  private despawn(t: Train) {
    for (const c of t.cars) this.free.push(c.slot);
    this.trains.delete(t.id);
  }

  /** Build a consist: a freight drag of mixed cars, or a short passenger set. */
  private makeCars(): { kind: RailKindName }[] {
    const out: { kind: RailKindName }[] = [];
    if (this.rand() < PASSENGER_SHARE) {
      out.push({ kind: 'locomotive' });
      const n = 4 + Math.floor(this.rand() * 4);
      for (let i = 0; i < n; i++) out.push({ kind: 'coach' });
      return out;
    }
    const locos = this.rand() < 0.45 ? 2 : 1;
    for (let i = 0; i < locos; i++) out.push({ kind: 'locomotive' });
    const n = 8 + Math.floor(this.rand() * 17);
    for (let i = 0; i < n; i++) out.push({ kind: pickWeighted(FREIGHT_MIX, this.rand()) });
    return out;
  }

  private spawn(e: Edge): Train | null {
    const wanted = this.makeCars();
    const n = Math.min(wanted.length, this.free.length);
    if (n < 2) return null;
    const cars: TrainCar[] = [];
    let head = 0;
    for (let i = 0; i < n; i++) {
      const kind = wanted[i].kind;
      const length = CAR_LENGTH[kind];
      cars.push({ kind, length, color: pickWeighted(COLOR_ITEMS, this.rand()), slot: this.free.pop()!, centre: head + length / 2 });
      head += length + COUPLER;
    }
    const t: Train = {
      id: this.nextId++, cars, length: head - COUPLER, edge: e.id, s: 0,
      v: e.v0 * 0.6, desire: 0.85 + this.rand() * 0.25, route: [], behind: [], exiting: false, waitS: 0,
    };
    this.trains.set(t.id, t);
    return t;
  }

  /** Next edge out of `e`: straight on where possible, never a reversal or a sharp branch. */
  private chooseNext(e: Edge): Edge | null {
    if (this.graph.arms(e.to) <= 1) return null;
    const opts = this.graph.outgoing(e).filter((o) => o.pair !== e.pair && this.graph.turnAngle(e, o) <= MAX_TURN_DEG);
    if (!opts.length) return null;
    if (opts.length === 1) return opts[0];
    const items: [Edge, number][] = opts.map((o) => {
      let w = this.graph.turnAngle(e, o) < 15 ? 8 : 2;
      if (!this.runnable(o)) w *= 0.15; // a siding or spur only when nothing else leaves the node
      return [o, w];
    });
    return pickWeighted(items, this.rand());
  }

  private ensureRoute(t: Train, e: Edge) {
    let last = e;
    for (const id of t.route) { const r = this.graph.edges.get(id); if (r) last = r; }
    while (t.route.length < ROUTE_AHEAD) {
      const nx = this.chooseNext(last);
      if (!nx) break;
      t.route.push(nx.id);
      last = nx;
    }
  }

  /**
   * Mark every track segment a consist occupies, then let each one claim the segment beyond the junction it is
   * approaching. Occupancy is marked first and a claim never displaces it, or a train closing on an occupied
   * block would take ownership of it and drive straight in.
   */
  private rebuildBlocks() {
    this.blocks.clear();
    for (const t of this.trains.values()) {
      const e = this.graph.edges.get(t.edge);
      if (!e) continue;
      this.blocks.set(e.pair, t.id);
      let covered = t.s;
      for (const id of t.behind) {
        if (covered >= t.length) break;
        const p = this.graph.edges.get(id);
        if (!p) break;
        this.blocks.set(p.pair, t.id);
        covered += p.length;
      }
    }
    for (const t of this.trains.values()) {
      const e = this.graph.edges.get(t.edge);
      if (!e || e.length - t.s >= RESERVE || !t.route.length) continue;
      const nx = this.graph.edges.get(t.route[0]);
      if (nx && !this.blocks.has(nx.pair)) this.blocks.set(nx.pair, t.id);
    }
  }

  /** Distance from the head to the start of the first block ahead held by another train. */
  private blockGap(t: Train, e: Edge): number {
    let d = e.length - t.s;
    for (const id of t.route) {
      if (d > LOOKAHEAD) break;
      const r = this.graph.edges.get(id);
      if (!r) break;
      const owner = this.blocks.get(r.pair);
      if (owner !== undefined && owner !== t.id) return d;
      d += r.length;
    }
    return Infinity;
  }

  step(dt: number) {
    if (this.paused) return;
    this.rebuildBlocks();
    const acc = new Map<number, number>();
    for (const t of this.trains.values()) {
      const e = this.graph.edges.get(t.edge);
      if (!e) { this.despawn(t); continue; }
      if (!t.exiting) this.ensureRoute(t, e);
      let gap = this.blockGap(t, e);
      // an interior dead end is a buffer stop; a dangling end is the edge of the loaded graph, and the
      // consist runs off it and is removed once the rear car has left
      if (!t.route.length && !t.exiting && this.graph.arms(e.to) > 1) gap = Math.min(gap, e.length - t.s);
      acc.set(t.id, idmAccel(t.v, e.v0 * t.desire, gap, t.v, A, B, T_HEADWAY, S0));
    }
    for (const t of [...this.trains.values()]) {
      const e = this.graph.edges.get(t.edge);
      if (!e) continue;
      t.v = Math.max(0, t.v + (acc.get(t.id) ?? 0) * dt);
      t.waitS = t.v < 0.2 ? t.waitS + dt : 0;
      // A buffer stop, or two consists nose to nose on single track, would otherwise hold the block forever.
      if (t.waitS > STALL_S) { this.despawn(t); continue; }
      t.s += t.v * dt;
      if (t.s < e.length) continue;
      const nextId = t.route.shift();
      const nx = nextId !== undefined ? this.graph.edges.get(nextId) : undefined;
      if (nx) {
        t.s -= e.length;
        t.behind.unshift(t.edge);
        t.edge = nx.id;
        this.trimHistory(t);
      } else {
        t.exiting = true;
        if (t.s - e.length > t.length) this.despawn(t);
      }
    }
    this.spawnStep(dt);
  }

  private trimHistory(t: Train) {
    let covered = 0, keep = 0;
    for (const id of t.behind) {
      const e = this.graph.edges.get(id);
      keep++;
      covered += e ? e.length : 0;
      if (covered >= t.length) break;
    }
    t.behind.length = keep;
  }

  private spawnStep(dt: number) {
    this.spawnClock -= dt;
    if (this.spawnClock > 0) return;
    this.spawnClock = SPAWN_INTERVAL;
    if (this.trains.size >= MAX_TRAINS || this.free.length < 4 || this.rand() > SPAWN_CHANCE) return;
    const entries: Edge[] = [];
    for (const e of this.graph.edges.values()) {
      if (e.length < MIN_ENTRY_LENGTH || this.blocks.has(e.pair)) continue;
      if (this.graph.arms(e.from) > 1 || !this.runnable(e)) continue;
      entries.push(e);
    }
    if (entries.length) this.spawn(entries[Math.floor(this.rand() * entries.length)]);
  }

  /** Resolve a car's pose `d` metres behind the head, walking back through the traversed edges. */
  private poseBehind(t: Train, d: number, out: Float32Array, o: number): boolean {
    let e = this.graph.edges.get(t.edge);
    if (!e) return false;
    let s = t.s - d;
    for (let i = 0; s < 0 && i < t.behind.length; i++) {
      const prev = this.graph.edges.get(t.behind[i]);
      if (!prev) break;
      e = prev;
      s += prev.length;
    }
    poseOnEdge(e, s, out, o);
    out[o + 1] += RAIL_LIFT;
    return true;
  }

  /** Write every car into the rail range of a pose buffer (kind = -1 marks empty slots). */
  writePoses(buf: Float32Array) {
    for (let i = 0; i < MAX_RAIL_CARS; i++) buf[(RAIL_SLOT_BASE + i) * POSE_STRIDE + 4] = -1;
    for (const t of this.trains.values()) {
      for (const c of t.cars) {
        const o = (RAIL_SLOT_BASE + c.slot) * POSE_STRIDE;
        if (!this.poseBehind(t, c.centre, buf, o)) continue;
        buf[o + 4] = KIND_INDEX[c.kind];
        buf[o + 5] = c.color;
      }
    }
  }

  /** Cars currently drawn, for the debug panel. */
  carCount(): number { let n = 0; for (const t of this.trains.values()) n += t.cars.length; return n; }
}
