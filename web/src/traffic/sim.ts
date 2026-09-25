/**
 * Traffic simulation: Intelligent Driver Model car-following on the road graph, with routing through junctions,
 * priority yielding, signals, stop signs, turn slowing and density-driven spawning. Pure TypeScript, fixed time step.
 */
import { RoadGraph, type Edge } from './graph';
import { MAX_VEHICLES, POSE_STRIDE, VEHICLE_COLOR_WEIGHTS, VEHICLE_KIND_NAMES, type JunctionControl, type RailKindName, type VehicleKindName } from './protocol';

/** Road vehicles only: the rail kinds in the pose buffer belong to the train sim. */
export type RoadKindName = Exclude<VehicleKindName, RailKindName>;

export const DT = 0.05; // s per step

interface KindSpec { idx: number; length: number; v0: number; a: number; b: number }
const KINDS: Record<RoadKindName, KindSpec> = {
  car: { idx: 0, length: 4.5, v0: 1.0, a: 1.4, b: 2.2 },
  suv: { idx: 1, length: 5.0, v0: 0.97, a: 1.2, b: 2.0 },
  pickup: { idx: 2, length: 5.5, v0: 0.95, a: 1.1, b: 2.0 },
  van: { idx: 3, length: 5.5, v0: 0.92, a: 1.0, b: 2.0 },
  bus: { idx: 4, length: 12, v0: 0.8, a: 0.8, b: 1.6 },
};
const KIND_MIX: [RoadKindName, number][] = [['car', 60], ['suv', 22], ['pickup', 10], ['van', 8]];
const BUS_SHARE = 0.05; // of spawns on roads >= 8 m wide

const S0 = 2.5;            // m, standstill gap
const T_HEADWAY = 1.4;     // s
const LOOKAHEAD = 80;      // m, leader search across next edges
const JUNCTION_ZONE = 15;  // m before a node where yield/turn rules apply
const CONFLICT_ZONE = 25;  // m: vehicles this close to the node on other arms are conflicts
const DEADLOCK_S = 4;      // s stopped at a node before ignoring the yield rule
const SPAWN_GAP = 16;      // m free on both sides for a spawn
const SPAWN_INTERVAL = 1.0; // s between spawn attempts per edge
// Junction control. OSM tags most signals at each approach's stop line, so any signal this close to a junction
// signalizes it; a stop sign belongs to the incoming edge whose end direction matches its approach.
const SIGNAL_RADIUS = 20;  // m
const STOP_SIGN_RADIUS = 18; // m
const STOP_SIGN_ALIGN = 0.8; // cos of the largest angle between a sign's approach and the edge's end direction
const CONTROL_ZONE = 60;   // m before a node where a signal or stop sign is obeyed
const SIGNAL_CYCLE = 60;   // s: two phases, each GREEN + YELLOW + all-red
const SIGNAL_GREEN = 25;
const SIGNAL_YELLOW = 3;
const SIGNAL_STOP_BACK = 3; // m short of the node: the stop line sits behind the crosswalk
const STOP_BACK = 2;       // m short of the node for a stop sign
const STOP_DWELL = 1;      // s at a standstill that completes a stop
const CONTROL_CELL = 50;   // m, spatial hash for control lookup

export type EdgeControl = { kind: 'none' } | { kind: 'stop' } | { kind: 'signal'; group: 0 | 1; offset: number };
const NO_CONTROL: EdgeControl = { kind: 'none' };
export type Light = 'green' | 'yellow' | 'red';

/** Signal aspect for a phase group at sim time t (s); group 1 runs half a cycle behind group 0. */
export function signalLight(group: 0 | 1, offset: number, t: number): Light {
  const phase = (((t + offset + group * (SIGNAL_CYCLE / 2)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return phase < SIGNAL_GREEN ? 'green' : phase < SIGNAL_GREEN + SIGNAL_YELLOW ? 'yellow' : 'red';
}

/** target vehicles per km of edge by highway class */
export function density(highway: string): number {
  switch (highway) {
    case 'motorway': return 8;
    case 'trunk': return 7;
    case 'primary': return 5;
    case 'secondary': return 4;
    case 'tertiary': return 3;
    case 'motorway_link': case 'trunk_link': case 'primary_link': return 2;
    default: return 1.25;
  }
}

export interface Vehicle {
  slot: number;
  kind: RoadKindName;
  color: number;
  edge: number;
  s: number;
  v: number;
  /** desired free speed factor (jitter) */
  desire: number;
  /** jittered IDM params */
  a: number;
  b: number;
  T: number;
  length: number;
  /** planned next edge ids */
  route: number[];
  /** seconds at a standstill inside the junction zone (deadlock guard) */
  waitS: number;
  /** node key this vehicle has been released through (yield rule ignored until it passes) */
  released: string | null;
  /** node key whose stop sign this vehicle has stopped at, and when the stop completed */
  stoppedAt: string | null;
  stopDoneAt: number;
  stopWait: number;
}

/** Mulberry32, same as geomutil.rng but dependency-free for the worker. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(items: [T, number][], r: number): T {
  const total = items.reduce((a, b) => a + b[1], 0);
  let x = r * total;
  for (const [v, w] of items) { x -= w; if (x <= 0) return v; }
  return items[items.length - 1][0];
}
const COLOR_ITEMS: [number, number][] = VEHICLE_COLOR_WEIGHTS.map((w, i) => [i, w]);

/** IDM acceleration. gap: bumper-to-bumper distance to the leader (m); dv: v - vLeader. */
export function idmAccel(v: number, v0: number, gap: number, dv: number, a: number, b: number, T: number, s0 = S0): number {
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
  const g = Math.max(gap, 0.1);
  const free = v0 > 0 ? Math.pow(v / v0, 4) : 1;
  return a * (1 - free - (sStar / g) * (sStar / g));
}

/** Speed that lets a vehicle decelerate at b to vTarget over distance d. */
function approachSpeed(vTarget: number, d: number, b: number): number {
  return Math.sqrt(vTarget * vTarget + 2 * b * Math.max(0, d));
}

/** Comfortable speed through a turn of `deg` degrees. */
export function turnSpeed(deg: number, v0: number): number {
  if (deg < 20) return v0;
  return Math.min(v0, Math.max(3, 14 - deg * 0.11));
}

export class TrafficSim {
  readonly graph = new RoadGraph();
  readonly vehicles = new Map<number, Vehicle>();
  private free: number[] = [];
  private rand: () => number;
  densityScale = 1;
  paused = false;
  private spawnClock = new Map<number, number>();
  /** One-time interior population. Continuous replacement is restricted to loaded-area entrances. */
  private seedRemaining = new Map<number, number>();
  private time = 0;
  private controls = new Map<string, JunctionControl[]>();
  private controlGrid: Map<string, JunctionControl[]> | null = null;
  private edgeControls = new Map<number, EdgeControl>();

  constructor(seed = 1) {
    this.rand = rng(seed);
    for (let i = MAX_VEHICLES - 1; i >= 0; i--) this.free.push(i);
  }

  reseed(seed: number) { this.rand = rng(seed); }

  removeTile(tileId: string) {
    this.controls.delete(tileId);
    this.controlsChanged();
    const ids = this.graph.removeTile(tileId);
    const gone = new Set(ids);
    for (const v of [...this.vehicles.values()]) {
      if (gone.has(v.edge)) this.despawn(v);
      else v.route = v.route.filter((id) => !gone.has(id));
    }
    for (const id of ids) {
      this.spawnClock.delete(id);
      this.seedRemaining.delete(id);
    }
  }

  addTile(tileId: string, paths: Float32Array[], meta: Parameters<RoadGraph['addTile']>[2], controls: JunctionControl[] = []) {
    this.controls.set(tileId, controls);
    this.controlsChanged();
    const ids = this.graph.addTile(tileId, paths, meta);
    // vehicles on edges that got split by the new tile's nodes keep going: their edge ids are unchanged,
    // only the new edges are new. Routes stay valid because edges are never mutated in place.
    for (const id of ids) {
      this.spawnClock.set(id, this.time - this.rand() * SPAWN_INTERVAL);
      const e = this.graph.edges.get(id)!;
      const target = (density(e.highway) * this.densityScale * e.length) / 1000;
      const whole = Math.floor(target);
      this.seedRemaining.set(id, whole + (this.rand() < target - whole ? 1 : 0));
    }
  }

  /** Loaded tiles changed: junction arms and the controls near them may both differ. */
  private controlsChanged() {
    this.controlGrid = null;
    this.edgeControls.clear();
  }

  private controlsNear(x: number, z: number): JunctionControl[] {
    if (!this.controlGrid) {
      this.controlGrid = new Map();
      for (const list of this.controls.values()) for (const c of list) {
        const k = `${Math.floor(c.x / CONTROL_CELL)}|${Math.floor(c.z / CONTROL_CELL)}`;
        const cell = this.controlGrid.get(k);
        if (cell) cell.push(c); else this.controlGrid.set(k, [c]);
      }
    }
    const out: JunctionControl[] = [];
    const cx = Math.floor(x / CONTROL_CELL), cz = Math.floor(z / CONTROL_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(this.controlGrid.get(`${cx + i}|${cz + j}`) ?? []));
    return out;
  }

  /** What controls the end of edge `e`: a signal phase group, a stop sign, or nothing (the yield rule). */
  edgeControl(e: Edge): EdgeControl {
    const cached = this.edgeControls.get(e.id);
    if (cached) return cached;
    let result: EdgeControl = NO_CONTROL;
    const n = this.graph.nodes.get(e.to);
    if (n && this.graph.arms(e.to) >= 3) {
      const [ex, ez] = this.graph.dirAt(e, true);
      let signal = false, stop = false;
      for (const c of this.controlsNear(n.x, n.z)) {
        const d = Math.hypot(c.x - n.x, c.z - n.z);
        if (c.kind === 'signal' && d <= SIGNAL_RADIUS) signal = true;
        else if (c.kind === 'stop' && d <= STOP_SIGN_RADIUS && (c.dx ?? 0) * ex + (c.dz ?? 0) * ez >= STOP_SIGN_ALIGN) stop = true;
      }
      if (signal) {
        // phase groups by axis: approaches within 45 degrees of the leading approach's line share its phase
        let axis: Edge = e;
        for (const id of n.in) {
          const o = this.graph.edges.get(id);
          if (o && (o.priority > axis.priority || (o.priority === axis.priority && o.id < axis.id))) axis = o;
        }
        const [ax, az] = this.graph.dirAt(axis, true);
        let hash = 0;
        for (let i = 0; i < n.key.length; i++) hash = (hash * 31 + n.key.charCodeAt(i)) >>> 0;
        result = { kind: 'signal', group: Math.abs(ex * ax + ez * az) >= Math.SQRT1_2 ? 0 : 1, offset: hash % SIGNAL_CYCLE };
      } else if (stop) result = { kind: 'stop' };
    }
    this.edgeControls.set(e.id, result);
    return result;
  }

  private despawn(v: Vehicle) {
    const e = this.graph.edges.get(v.edge);
    if (e) { const k = e.vehicles.indexOf(v.slot); if (k >= 0) e.vehicles.splice(k, 1); }
    this.vehicles.delete(v.slot);
    this.free.push(v.slot);
  }

  private spawn(e: Edge, s: number): Vehicle | null {
    if (!this.free.length) return null;
    const slot = this.free.pop()!;
    const kind: RoadKindName = e.width >= 8 && this.rand() < BUS_SHARE ? 'bus' : pickWeighted(KIND_MIX, this.rand());
    const spec = KINDS[kind];
    const j = () => 0.9 + this.rand() * 0.2;
    const v: Vehicle = {
      slot, kind, color: pickWeighted(COLOR_ITEMS, this.rand()), edge: e.id, s, v: Math.min(e.v0 * spec.v0, 8) * (0.5 + this.rand() * 0.5),
      desire: spec.v0 * j(), a: spec.a * j(), b: spec.b * j(), T: T_HEADWAY * j(), length: spec.length, route: [], waitS: 0, released: null,
      stoppedAt: null, stopDoneAt: 0, stopWait: 0,
    };
    this.vehicles.set(slot, v);
    insertSorted(e.vehicles, slot, (id) => this.vehicles.get(id)!.s);
    return v;
  }

  /** Pick the next edge for a vehicle leaving `e` (weighted: straight and same class preferred). */
  private chooseNext(e: Edge): Edge | null {
    // A dangling road end is the boundary of the loaded graph (or a real cul-de-sac). Let traffic leave
    // there instead of selecting the reverse edge and keeping every vehicle in the simulation forever.
    if (this.graph.arms(e.to) <= 1) return null;
    const opts = this.graph.outgoing(e);
    if (!opts.length) return null;
    if (opts.length === 1) return opts[0];
    const items: [Edge, number][] = opts.map((o) => {
      const ang = this.graph.turnAngle(e, o);
      let w = ang < 30 ? 3 : 1.5;
      if (o.highway === e.highway) w *= 2;
      if (o.link !== e.link) w *= 0.6;
      return [o, w];
    });
    return pickWeighted(items, this.rand());
  }

  private ensureRoute(v: Vehicle, e: Edge, n = 2) {
    let last = e;
    for (const id of v.route) { const r = this.graph.edges.get(id); if (r) last = r; }
    while (v.route.length < n) {
      const nx = this.chooseNext(last);
      if (!nx) break;
      v.route.push(nx.id);
      last = nx;
    }
  }

  /** Distance (bumper gap) and speed of the leader, searching along the route up to LOOKAHEAD. */
  private leader(v: Vehicle, e: Edge): { gap: number; vLead: number } | null {
    const list = e.vehicles;
    const i = list.indexOf(v.slot);
    if (i >= 0 && i < list.length - 1) {
      const l = this.vehicles.get(list[i + 1])!;
      return { gap: l.s - v.s - l.length, vLead: l.v };
    }
    let ahead = e.length - v.s;
    for (const id of v.route) {
      if (ahead > LOOKAHEAD) break;
      const r = this.graph.edges.get(id);
      if (!r) break;
      if (r.vehicles.length) {
        const l = this.vehicles.get(r.vehicles[0])!;
        return { gap: ahead + l.s - l.length, vLead: l.v };
      }
      ahead += r.length;
    }
    return null;
  }

  /**
   * Yield rule at a junction node: true when another vehicle within CONFLICT_ZONE of the node on a different
   * incoming arm has priority, so `v` should stop short of the node. Through traffic never yields to stop-sign
   * arms; a vehicle that has stopped at a sign yields to through traffic and to vehicles on other stop arms
   * that finished their stop first (an all-way stop runs first-come, first-served).
   */
  private mustYield(e: Edge, dNode: number, v: Vehicle): boolean {
    const n = this.graph.nodes.get(e.to);
    if (!n) return false;
    const mine = this.edgeControl(e).kind === 'stop';
    for (const id of n.in) {
      if (id === e.id) continue;
      const o = this.graph.edges.get(id);
      if (!o || o.pair === e.pair) continue;
      const theirs = this.edgeControl(o).kind === 'stop';
      if (theirs && !mine) continue;
      for (const slot of o.vehicles) {
        const u = this.vehicles.get(slot)!;
        const d = o.length - u.s;
        if (d > CONFLICT_ZONE) continue;
        if (mine && theirs) {
          if (u.stoppedAt === o.to && u.stopDoneAt < v.stopDoneAt && d < STOP_BACK + 4) return true;
          continue;
        }
        if (mine) return true;
        if (o.priority > e.priority) return true;
        if (o.priority === e.priority && d < dNode - 1) return true;
      }
    }
    return false;
  }

  step(dt = DT) {
    if (this.paused) return;
    this.time += dt;
    const g = this.graph;
    // 1. accelerations
    const acc = new Map<number, number>();
    for (const v of this.vehicles.values()) {
      const e = g.edges.get(v.edge)!;
      this.ensureRoute(v, e);
      const v0 = e.v0 * v.desire;
      let vAllowed = v0;
      const dNode = e.length - v.s;
      const next = v.route.length ? g.edges.get(v.route[0]) : undefined;
      // slow for the turn ahead
      if (next) {
        const vt = turnSpeed(g.turnAngle(e, next), v0);
        if (vt < v0) vAllowed = Math.min(vAllowed, approachSpeed(vt, dNode, v.b));
      }
      let gap = Infinity, dv = 0;
      const lead = this.leader(v, e);
      if (lead) { gap = lead.gap; dv = v.v - lead.vLead; }
      // signals and stop signs
      const ctl = next && dNode < CONTROL_ZONE ? this.edgeControl(e) : NO_CONTROL;
      let yieldRule = true;
      if (ctl.kind === 'signal') {
        yieldRule = false;
        const light = signalLight(ctl.group, ctl.offset, this.time);
        const toLine = dNode - SIGNAL_STOP_BACK;
        // a vehicle already over the line keeps going; on yellow, only one that can stop comfortably stops
        if (toLine > -0.5 && (light === 'red' || (light === 'yellow' && toLine > (v.v * v.v) / (2 * v.b)))) {
          // IDM halts S0 short of an obstacle, so the virtual one sits S0 past the line
          if (toLine + S0 < gap) { gap = Math.max(0.1, toLine + S0); dv = v.v; }
        }
      } else if (ctl.kind === 'stop' && v.stoppedAt !== e.to) {
        yieldRule = false; // the stop line holds it; the yield rule takes over once the stop is complete
        const toLine = dNode - STOP_BACK;
        if (toLine < -1) { v.stoppedAt = e.to; v.stopDoneAt = this.time; }
        else {
          if (toLine + S0 < gap) { gap = Math.max(0.1, toLine + S0); dv = v.v; }
          if (toLine < 1.5 && v.v < 0.3) {
            v.stopWait += dt;
            if (v.stopWait >= STOP_DWELL) { v.stoppedAt = e.to; v.stopDoneAt = this.time; v.stopWait = 0; }
          }
        }
      }
      // junction yielding
      if (yieldRule && dNode < JUNCTION_ZONE && g.arms(e.to) >= 3 && v.released !== e.to) {
        if (this.mustYield(e, dNode, v)) {
          v.waitS += v.v < 0.3 ? dt : 0;
          if (v.waitS < DEADLOCK_S) {
            const stopGap = dNode - 1;
            if (stopGap < gap) { gap = stopGap; dv = v.v; }
          } else v.released = e.to;
        } else v.waitS = 0;
      } else if (v.released && v.released !== e.to) v.released = null;
      // With no onward edge the node is an exit: a loaded-area boundary, or a sink where one-way ways only
      // arrive (a merge whose continuation lies outside the data). Vehicles drive through and the integration
      // pass removes them; holding them there queued traffic behind a car that could never move.
      acc.set(v.slot, idmAccel(v.v, vAllowed, gap, dv, v.a, v.b, v.T));
    }
    // 2. integrate and move between edges
    for (const v of [...this.vehicles.values()]) {
      const a = acc.get(v.slot) ?? 0;
      v.v = Math.max(0, v.v + a * dt);
      v.s += v.v * dt;
      const e = g.edges.get(v.edge)!;
      if (v.s >= e.length) {
        const nextId = v.route.shift();
        const nx = nextId !== undefined ? g.edges.get(nextId) : undefined;
        if (!nx) { this.despawn(v); continue; }
        const k = e.vehicles.indexOf(v.slot);
        if (k >= 0) e.vehicles.splice(k, 1);
        v.s -= e.length;
        v.edge = nx.id;
        v.released = null;
        v.waitS = 0;
        v.stoppedAt = null;
        v.stopWait = 0;
        insertSorted(nx.vehicles, v.slot, (id) => this.vehicles.get(id)!.s);
      }
    }
    for (const e of g.edges.values()) if (e.vehicles.length > 1) e.vehicles.sort((x, y) => this.vehicles.get(x)!.s - this.vehicles.get(y)!.s);
    // 3. seed newly loaded roads once, then admit replacement flow only at graph boundaries
    this.spawnStep();
  }

  private spawnStep() {
    if (this.vehicles.size >= MAX_VEHICLES) return;
    const ids = [...this.spawnClock.keys()];
    for (const id of ids) {
      const due = this.spawnClock.get(id)!;
      if (this.time - due < SPAWN_INTERVAL) continue;
      this.spawnClock.set(id, this.time);
      const e = this.graph.edges.get(id);
      if (!e || e.length < SPAWN_GAP || this.densityScale <= 0) continue;
      const seed = this.seedRemaining.get(id) ?? 0;
      const entry = this.graph.arms(e.from) <= 1;
      if (seed <= 0) {
        if (!entry) continue;
        // Density times free-flow speed gives a boundary arrival rate. This balances the cars leaving other
        // graph boundaries instead of refilling every interior edge each time a car moves onward.
        const arrivalChance = Math.min(1, (density(e.highway) * this.densityScale * e.v0 * SPAWN_INTERVAL) / 1000);
        if (this.rand() >= arrivalChance) continue;
      }
      const s = seed > 0 ? SPAWN_GAP / 2 + this.rand() * (e.length - SPAWN_GAP) : 1;
      let ok = true;
      for (const slot of e.vehicles) { const u = this.vehicles.get(slot)!; if (Math.abs(u.s - s) < SPAWN_GAP) { ok = false; break; } }
      if (ok && entry && seed <= 0) {
        // also require a free gap on the edges feeding this start node (a merge from an unloaded neighbour)
        for (const inId of this.graph.nodes.get(e.from)?.in ?? []) {
          const inn = this.graph.edges.get(inId);
          if (inn) for (const slot of inn.vehicles) if (inn.length - this.vehicles.get(slot)!.s < SPAWN_GAP) ok = false;
        }
      }
      if (!ok) continue;
      if (!this.spawn(e, s)) return;
      if (seed > 0) this.seedRemaining.set(id, seed - 1);
    }
  }

  /** Write every vehicle into a pose buffer (slot-indexed; kind = -1 marks empty slots). */
  writePoses(buf: Float32Array) {
    for (let i = 0; i < MAX_VEHICLES; i++) buf[i * POSE_STRIDE + 4] = -1;
    for (const v of this.vehicles.values()) {
      const e = this.graph.edges.get(v.edge)!;
      const o = v.slot * POSE_STRIDE;
      this.graph.poseAt(e, v.s, buf, o);
      buf[o + 4] = KINDS[v.kind].idx;
      buf[o + 5] = v.color;
    }
  }
}

function insertSorted(list: number[], id: number, key: (id: number) => number) {
  const k = key(id);
  let i = list.length;
  while (i > 0 && key(list[i - 1]) > k) i--;
  list.splice(i, 0, id);
}

export const KIND_INDEX: Record<VehicleKindName, number> = Object.fromEntries(VEHICLE_KIND_NAMES.map((k, i) => [k, i])) as Record<VehicleKindName, number>;
