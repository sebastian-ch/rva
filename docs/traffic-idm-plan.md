# Graph-based IDM traffic in a worker — implementation plan

> **Status (2026-09-09): implemented** in `web/src/traffic/{graph,sim,protocol}.ts`, `trafficWorker.ts`,
> `trafficClient.ts`, `propPool.applyPoses`. Deviations from the plan below: ways are also split at any vertex two
> ways share (OSM crossroads), not only at endpoints; merge gap acceptance is folded into the priority yield rule;
> buses run in the worker from day one; the junction virtual leader stops 1 m short of the node. Phase 4 items:
> signals and stop signs landed 2026-09-25 (see the end of this file); MOBIL lane changes are still open.

> **Density correction (2026-09-14):** initial population is seeded once on newly loaded edges. Ongoing arrivals
> occur only on edges entering from a degree-one loaded-area boundary, at the class density multiplied by free-flow
> speed; vehicles leave at degree-one exits. Replacing cars on every interior edge after they moved onward caused
> the population to climb continuously and made short clipped road segments contribute at least one car each.
> Runtime targets are now 8 vehicles/km for motorways, 7 trunk, 5 primary, 4 secondary, 3 tertiary, 2 major links,
> and 1.25 for local roads. The older aspirational values below are retained as design history.

## Why

Today (`web/src/propPool.ts`) cars are spawned per road polyline *as clipped to the tile*. Each polyline is a
closed loop with one lane per direction; a car follows the vehicle ahead in its own loop and never leaves it.
Consequences visible in the viewer:

- cars loop on 30 m fragments where a street was cut by a tile edge, and vanish/reappear at tile borders;
- nothing crosses a junction, merges on a ramp, yields, or slows for a turn;
- density is a per-polyline constant, so a ramp stub gets the same traffic as Broad Street;
- all movement runs on the main thread, capped by `CAPACITY` per prop kind.

Goal: a persistent **traffic worker** that owns a city-wide road graph stitched from loaded tiles, runs the
Intelligent Driver Model (IDM) with simple junction and merge rules at a fixed rate, and streams car poses to the
main thread, which only writes instance matrices.

Non-goals for v1: lane changes (MOBIL), traffic signals, pedestrians (walkers stay in `propPool`), buses on
routes, parking. These are listed as later phases.

## Architecture

```
tile workers ──payload──▶ main thread ──graph delta──▶ traffic worker
   (roads.ts)             (tileManager)                 (graph + IDM @ 20 Hz)
                              ▲                              │
                              └────── Float32Array poses ────┘  (transferable, double-buffered)
                          propPool writes InstancedMesh matrices
```

- **Tile workers stay stateless.** `roads.ts` already emits `carPaths` (3D local polylines) and `carMeta`. Extend
  the meta with what the graph needs (below); no new geometry work in the tile build.
- **One traffic worker** (`web/src/trafficWorker.ts`) lives for the session. It receives `addTile` / `removeTile`
  deltas, keeps the graph, and runs the simulation on `setInterval` at a fixed `DT = 0.05 s` (decoupled from
  render FPS; the main thread interpolates between the last two pose buffers).
- **Main thread** (`propPool.ts`) drops its own car integration; `addCars` becomes "hand paths to the worker",
  `update(dt)` becomes "apply latest pose buffer". Walkers keep the current code.

## Data

### Per-path meta from `roads.ts` (`CarPathMeta`)

```ts
interface CarPathMeta {
  oneway: boolean; width: number;
  highway: string;          // class -> speed limit, priority, spawn density
  lanes: number;            // from OSM or class default (used for capacity only in v1)
  bridge: boolean; ramp: boolean;
  wayId: string;            // osm id: stitching and determinism
}
```

`carPaths` are already 3D (deck-aware via `toPath`), so the graph needs no terrain access.

### Graph (`web/src/traffic/graph.ts`, pure TS, no three.js)

- **Node**: keyed by rounded local `(x, z)` to 0.1 m, exactly like `roads.ts`' junction key. A polyline end at a
  tile border produces a node with degree 1 until the neighbouring tile arrives; then the two clipped halves
  share the node and traffic flows across. This is the stitching mechanism and needs no extra data.
- **Edge**: one directed edge per travel direction of a polyline. Holds the polyline, cumulative lengths,
  `speedLimit` (by class: motorway 27 m/s, trunk 22, primary 16, secondary 14, tertiary 12, residential 9,
  link classes = parent class − 4), `priority` (motorway 4 … residential 1; links inherit), `tileId`, `wayId`.
- **Lane offset**: v1 keeps one lane per direction at the current `laneOffset(width)`; the sim works in
  1-D arc length `s` per edge, the offset is applied only when writing poses.
- **Turn table**: at each node, outgoing edges except the reverse of the incoming one (U-turn allowed only at
  degree-1 nodes). Turn weights: straight-ish (|angle| < 30°) ×3, same class ×2, link edges ×1, so most traffic
  goes through and some peels onto ramps.

Vehicles reference edges by index; removing a tile removes its edges and any vehicle on them (or on an edge whose
next node is now dangling and within 20 m — despawn rather than stop dead).

## Simulation (`web/src/traffic/idm.ts`)

IDM acceleration for vehicle with speed `v`, gap `s` to the leader, speed difference `Δv`:

```
s* = s0 + v·T + v·Δv / (2·sqrt(a·b))
dv/dt = a · (1 − (v/v0)^4 − (s*/s)^2)
```

Parameters (per kind, jittered ±10 % per vehicle so platoons break up): `a = 1.2`, `b = 2.0`, `T = 1.4 s`,
`s0 = 2.5 m`, `v0 = min(speedLimit, driverDesire)`. Vehicle lengths: car 4.5, suv 5, pickup 5.5, van 5.5, bus 12.

**Leader lookup.** Each edge keeps its vehicles sorted by `s`. The leader is the next vehicle on the same edge;
if none, walk the vehicle's *planned* next edges (route lookahead of 2) up to 80 m and take the first vehicle
found, with gap = remaining length on current edge + its `s`. This is what lets cars queue through junctions
without a separate junction model.

**Junction rule (v1, no signals).** When a vehicle is within `L_stop = 12 m` of a node with degree ≥ 3 and it is
about to enter edge `e_next`:

1. collect vehicles on other incoming edges of that node that are within 25 m of it and will conflict
   (conflict = their next edge is `e_next`, or their path crosses ours; v1 approximates "crosses" as
   "not the same edge and not opposite-direction straight");
2. if such a vehicle has higher `priority` or (same priority and arrives sooner), treat the node as a virtual
   stopped leader at `s = nodeS − s0` (IDM then brakes smoothly);
3. else proceed. Deadlock guard: a vehicle stopped ≥ 4 s at a node ignores the rule once.

**Ramp merge.** A `motorway_link` entering a `motorway` node is a degree-3 node; the rule above already makes the
ramp yield to mainline (higher priority). Add gap acceptance: the merging car also needs the mainline vehicle
*behind* the node to be ≥ `s0 + v·T` away, else wait. This gives visible merge queues on the Downtown Expressway.

**Turn speed.** Desired speed on the last 15 m before a node is capped by turn angle: 90° → 5 m/s, straight → no cap.

**Integration.** Semi-implicit Euler at `DT = 0.05`, `v = max(0, v + a·DT)`, `s += v·DT`; when `s` passes the edge
length, pop the route and carry the remainder. Vehicles that reach a degree-1 node despawn.

## Spawning and density

- Target density per edge class (vehicles per km per lane): motorway 18, primary 12, secondary 9, tertiary 6,
  residential 3. The worker keeps a running count per class and spawns to meet the target.
- Spawn points: degree-1 nodes at the *outer* boundary of the loaded area (tile-border stubs whose neighbour tile
  is not loaded) and, to seed interior streets on first load, random positions on edges with no vehicle within
  40 m. Spawn only where the entry gap is ≥ `s0 + v0·T`.
- Hard cap: 1500 vehicles (raise `CAPACITY` accordingly). Deterministic RNG seeded from `'cars'` plus the
  edge's `wayId`, so a reload gives the same traffic.

## Protocol (`web/src/traffic/protocol.ts`)

```ts
type ToWorker =
  | { type: 'addTile'; tileId: string; paths: Float32Array; pathOffsets: Uint32Array; meta: CarPathMeta[] }
  | { type: 'removeTile'; tileId: string }
  | { type: 'setParams'; density: number; paused: boolean };
type FromWorker =
  | { type: 'poses'; t: number; n: number; buf: Float32Array }  // n × [x, y, z, heading, kindIdx, colorIdx]
  | { type: 'stats'; vehicles: number; msPerStep: number };
```

Poses go out at 20 Hz as a transferable `Float32Array`; the main thread keeps the previous buffer and
interpolates by wall time, so 60 fps rendering stays smooth. Vehicles are identified by slot index; the worker
keeps slots stable (free list) so instance colours do not need re-upload every frame.

## Rendering changes (`propPool.ts`)

- `addCars` → `traffic.addTile(tileId, paths, meta)`; `removeTile` → `traffic.removeTile(tileId)`.
- New `applyPoses(buf, prevBuf, alpha)`: per slot, build the matrix from interpolated position and heading and
  write to the kind's `InstancedMesh`. Kinds are chosen by the worker (`kindIdx`) so mesh assignment is stable.
- Buses: keep `addBuses` on the old path code for v1 (they only use wide roads) or move them into the worker
  as a kind with `v0 = 12` and length 12; the second is simpler once the worker exists.

## Files

| File | Change |
|---|---|
| `web/src/traffic/graph.ts` | new: nodes, edges, stitching, turn tables, add/remove tile |
| `web/src/traffic/idm.ts` | new: IDM, leader lookup, junction + merge rules, integrator |
| `web/src/traffic/spawn.ts` | new: density targets, spawn/despawn |
| `web/src/traffic/protocol.ts` | new: message types, pose buffer layout |
| `web/src/trafficWorker.ts` | new: worker entry, fixed-step loop |
| `web/src/trafficClient.ts` | new: main-thread wrapper, double buffer, interpolation |
| `web/src/roads.ts` | extend `CarPathMeta`; nothing else |
| `web/src/propPool.ts` | remove car integration; add `applyPoses`; keep walkers |
| `web/src/main.ts` | create client; wire `onAdded` / `onRemoved`; call `applyPoses` per frame |
| `web/src/debug.ts` | show vehicle count and ms/step from `stats` |

## Tests (vitest)

- `idm.test.ts`: a platoon of 20 cars behind a stopped leader never produces a negative gap; a free car converges
  to `v0`; string stability (perturbation decays over the platoon).
- `graph.test.ts`: two tiles with a street clipped at the border stitch into one node with degree 2; removing a
  tile removes its edges and vehicles; turn table excludes U-turns at degree ≥ 2.
- `junction.test.ts`: a residential car yields to a primary car arriving within 25 m; a ramp car waits for a
  mainline gap; deadlock guard releases after 4 s.
- `spawn.test.ts`: density converges to the target on a loop and is deterministic for a seed.
- `protocol.test.ts`: pose buffer round-trips slot → kind → colour.

## Phases

1. **Graph + IDM on one edge, no junction rule** (graph.ts, idm.ts, worker, client, propPool swap). Cars already
   cross tile borders and junctions by routing; junction conflicts ignored. ~1 day. This alone removes the
   fragment loops and border pop.
2. **Junction + merge rules, turn speed, density spawning.** ~1 day.
3. **Buses in the worker; debug overlay; tuning** on the Downtown Expressway ramps and Broad Street. ~½ day.
4. Later: MOBIL lane changes on ≥ 2-lane edges (needs per-lane `s` lists), signals at `highway=traffic_signals`
   nodes (fixed 30/30 s phases), stop signs from `highway=stop`.

## Risks and guards

- **Tile-border stitching depends on identical clipped endpoints.** The pipeline clips both tiles from the same
  geometry so keys match today (roads.ts relies on it too). Add a test fixture with a real border pair.
- **Per-frame `postMessage` cost.** 1500 × 6 floats = 36 KB at 20 Hz, transferable, negligible. If the worker
  falls behind, it drops to 10 Hz and the client interpolates further.
- **Unloaded neighbour = dead end.** Vehicles despawn there and respawn at the boundary; visible only at the
  edge of the loaded area, which is already outside the LOD-0 ring.
- **Determinism.** Fixed `DT`, seeded RNG, and stable edge ordering by `wayId` keep reloads identical; tile
  arrival order does not affect the graph, only which slot a vehicle gets.

## Trains (implemented)

`traffic/trains.ts` runs consists on the rail graph out of the same worker and writes them into the same pose
buffer, above the road vehicles (`RAIL_SLOT_BASE`). What differs from the road sim:

- **Track, not lanes.** Rail paths come from `buildRoads` as the drawn centreline, un-extended, so track meeting
  at a node shares a graph node exactly as roads do. `CarPathMeta.offset = 0` and `speed = railSpeed(railway)`
  keep RoadGraph reusable without a rail-specific copy.
- **One train, many poses.** A consist is a head position plus cars placed by arc length behind it, resolved by
  walking back through `behind` (the edges the head already traversed). A car that lands off the loaded track --
  behind the oldest edge in history, or past the head's edge while the train is running off the end -- is not
  drawn at all. Extrapolating it along the end tangent floats it beside the track the LOD-1 tiles are still
  drawing; the consist grows in from the boundary instead.
- **Blocks, not car-following.** A train never enters a segment (`Edge.pair`, i.e. undirected track) another
  train occupies; the distance to the first foreign block is the IDM gap. This is what keeps two consists off
  the same single track head-on, which a same-direction leader search cannot do.
  Occupancy is marked for every train **before** any train claims the block beyond its junction — a claim that
  could displace occupancy would hand the approaching train ownership of the block it is meant to stop for, and
  it would drive straight in (`trains.test.ts` covers it).
- **Self-healing standoffs.** Two consists can still stop nose to nose in adjacent blocks where a line converges,
  and a buffer stop holds a train for ever. A consist stopped for `STALL_S` leaves the simulation.
- **Where trains run.** `railway=rail` with no OSM `service` value: not yard throats, sidings or spurs. The
  pipeline carries `service`/`usage` through to the tile for this; every class is still drawn.

Open: level crossings do not stop road traffic, and a train running off a mid-scene graph boundary is visible
as the consist leaving the end of the track.

## Signals and stop signs (2026-09-25)

Tiles hand the worker `controls` (`JunctionControl`, local frame) built from their POIs: every
`traffic_signals` point, and every `stop_sign` with its approach's travel direction. `TrafficSim.edgeControl`
resolves an incoming edge lazily and caches it until tiles change. A node with ≥ 3 arms is signalized when
any signal lies within 20 m. OSM puts most at the stop lines, not on the junction node. An edge stops when a
sign within 18 m of its end node points along the edge's end direction (cos ≥ 0.8).

- **Signals:** two phase groups by approach axis (within 45° of the highest-priority approach), 60 s cycle
  (25 s green, 3 s yellow, 2 s all-red per phase), offset by a hash of the node key. Red, or yellow when the car
  can stop at `b`, puts a virtual obstacle S0 past the stop line 3 m before the node. IDM halts S0 short of an
  obstacle, so without that shift cars stop 2.5 m early. The yield rule is skipped at signals.
- **Stop signs:** hold at 2 m before the node until the car has stood still for 1 s. After that the yield rule
  applies: yield to any vehicle on a non-stop arm within the conflict zone, and to vehicles on other stop arms
  that finished their stop earlier (all-way stops are first-come, first-served). Through traffic never yields
  to stop arms. The deadlock guard still releases after 4 s.
- **Checked** headless on real tiles over 10 simulated minutes. On city streets (motorways excluded) the Fan
  holds a steady ~10% of cars stopped with controls (259 stop approaches, 48 signalized). Downtown (308
  signalized approaches) settles around 30–37% stopped, mostly at red lights, as the vehicle count levels off.
  Queues at interior dead ends (a two-arm node with no onward edge, seen on I-195 and a downtown tertiary)
  predate this and appear without controls too.

