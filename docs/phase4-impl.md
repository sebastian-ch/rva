# Phase 4 technical implementation — performance and scale (ROADMAP 4.1–4.3)

Goal: keep the viewer smooth as the area grows from one district to six, and make first paint fast.

## Where the time goes today

The client fetches ~7 MB of GeoJSON and builds ~1.4 M triangles on the main thread while tiles arrive.
Building geometry is CPU work (earcut, extrusion, ribbons, scatter), and it blocks rendering: the loading
sequence stutters and the first frame with buildings is late.

## Decision: workers + streaming first, baked tiles later

ROADMAP 4.1 proposed baking geometry to compressed glTF at build time. The payload math argues against doing it
first: the generated geometry is ~4 M vertices. Even quantized (int16 positions, int8 normals, uint8 colours,
uint16 uv, 5-byte facade) that is ~85 MB raw, and meshopt + gzip lands around 25–30 MB for the slice, four times
the GeoJSON it replaces. Bandwidth, not CPU, becomes the bottleneck, and the target of "under 12 MB" cannot be
met with full-detail geometry. Baking still makes sense later for low-end devices as an optional cache, and
for LOD1 meshes (which are small), but it is not the first move.

So Phase 4 delivers:

1. **Worker-built tiles (4.3).** All parsing and geometry construction moves to a pool of module workers.
2. **Streaming and LOD (4.2).** Tiles load and unload from the camera's ground footprint, with a reduced level
   of detail for tiles outside the immediate view.
3. **Measurement.** Per-tile build time and main-thread blocking are logged so the next decision (baking LOD1,
   or all tiles) is made from numbers.

## 4.3 Worker pool — `web/src/tileWorker.ts`, `workerPool.ts`, `tiles.ts`

- `tileWorker.ts` imports the same builders (`buildings.ts`, `roads.ts`, `areas.ts`, `terrain.ts`, `scatter.ts`).
  three.js core is DOM-free, so `BufferGeometry`, `ShapeUtils` and `Vector3` work in a worker.
- Message `build {meta, baseUrl, origin, lod}` → the worker fetches the tile's layers, builds every geometry and
  replies with transferable `Float32Array`s per layer (`position`, `normal`, `color`, and for buildings `uv`,
  `facade`), plus plain-object `ranges`, `placements`, `carPaths` (flattened numbers), the raw building features
  (needed for selection re-extrusion), and the terrain grid.
- `workerPool.ts`: `min(4, hardwareConcurrency - 1)` workers, a FIFO queue with cancellation (a tile unloaded
  before its build finishes is dropped on arrival).
- `tiles.ts` keeps its public shape (`TileWorld.load(meta, lod)` returns a `LoadedTile`), but now only wraps the
  transferred arrays into `BufferGeometry` + `Mesh` on the main thread, which is microseconds.
- Vite: `new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' })`.

## 4.2 Streaming and LOD — `web/src/streaming.ts`, `main.ts`

- Every 250 ms (or when the camera target moves more than 60 m or the zoom changes by 15%) compute the camera's
  ground footprint: unproject the four NDC corners at the near and far planes, intersect the rays with y = 0,
  take the bounding box of the four hits (orthographic, so it is a parallelogram), expand by 150 m.
- Tile priority: `full` for tiles intersecting the footprint, `lod1` for tiles within 600 m of it, `unload`
  otherwise. Tiles are requested nearest-first; a tile already loaded at a different LOD is rebuilt and swapped.
- LOD1 content: terrain, buildings without roof details or facade attributes (walls still coloured), roads
  without markings, no crossings, no props, no water animation (static material). This is roughly a third of the
  triangles of a full tile.
- Unload disposes geometries and removes instances from the prop pool. The pool gains `removeTile(tileId)`:
  instances are tagged with their tile, and removal compacts the instanced buffers.
- Cap on concurrent builds equals the pool size; the loading pill shows queued/active counts.
- Memory guard: at most 260 tiles resident (full + lod1) — beyond that the farthest lod1 tiles are dropped.

## Measurement

`window.__iso.stats()` reports: tiles by LOD, triangles by layer, worker build ms per tile (p50/p95), main-thread
wrap ms per tile, and time to first building mesh after index load. The same numbers are logged once when the
initial view finishes loading.

## Tests

- `streaming.test.ts`: footprint → tile priority for a synthetic index (a 5×5 grid): centre tile full, ring
  within 600 m lod1, corners unloaded; priorities ordered by distance; hysteresis keeps a tile at its LOD when
  it sits on the boundary.
- `workerPool.test.ts`: queue ordering, cancellation of a job dropped before completion, pool never exceeds its
  size (fake worker).
- `tiles.test.ts`: `wrapTilePayload` turns a synthetic payload into meshes with the expected attribute counts.
- Existing suites keep passing; `tsc` clean; `vite build` succeeds with the worker chunk emitted.

## Acceptance

| Check | Target |
|---|---|
| Longest main-thread task during initial load | under 50 ms |
| Time to first building mesh after `index.json` | under 400 ms on the dev machine |
| Frame time at the default view, full LOD | unchanged from Phase 2 |
| Tiles resident when zoomed to a single block | full ≤ 12, lod1 ≤ 40 |
| Panning across the slice | no visible pop beyond the LOD boundary, no leaks (heap stable after 5 passes) |

## Status (2026-09-09)

Implemented: worker pool (4.3), footprint-driven streaming with LOD1 and unloading (4.2), stats. Baking (4.1)
deferred per the payload analysis above. Measured in headless Chrome on the dev machine (SwiftShader, so render
timings are not representative, but CPU/worker timings are):

| Check | Target | Result |
|---|---|---|
| Time to first building mesh after `index.json` | < 400 ms | 75–86 ms |
| Worker build time per tile | — | p50 2–3 ms, p95 8–10 ms (190 tiles) |
| Main-thread wrap per tile | < 50 ms longest task | p95 0.2 ms |
| Resident tiles at the default view | — | 81 full + 109 lod1 of 240; 0.66 M triangles vs 1.27 M when everything was full |
| Tests | green | 80 + new streaming/pool/tiles suites, `tsc` clean, `vite build` emits the worker chunk |

Also in this phase (river fix requested alongside): the study bbox was extended south to 37.517° so the whole
James River, Belle Isle and the Manchester bank are in the slice (240 tiles, 3,966 buildings, 10.5 MB). Water
polygons now follow the DEM surface (the river drops several metres across the fall line, so a flat per-tile
surface hid under the terrain upstream).

Findings:
- The 3DEP `exportImage` request silently failed once for the larger bbox (12.8 MB TIFF); a retry succeeded.
  `fetch.py` should retry on a non-TIFF response — small follow-up.
- Standalone `bpy` (Blender as a Python module, wheel `bpy-5.0.1-cp311-macosx_arm64`, 228 MB) installs into
  the project venv, which lets the Blender scripts run headless without the desktop app; see Phase 3 notes.
