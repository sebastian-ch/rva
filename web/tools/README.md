# tools/

Headless screenshot and smoke-test scripts for the viewer, driven with
`playwright-core` (Chrome + SwiftShader software rendering — no GPU needed,
works in CI).

**The Vite dev server must already be running** (`npm run dev`, default
`http://localhost:5173/`). Neither script starts it for you.

SwiftShader is software-rendered and slow: expect a single run to take
**30-90 seconds**, mostly spent waiting for the first tiles to build and the
tile manager to go idle.

## snap.mjs

```
node tools/snap.mjs [view] [--zoom N] [--night] [--heights] [--tour N] [--at X,Z] [--url http://localhost:5173/] -o out.png
npm run snap -- mayo-bridge --zoom 2.5 -o snapshots/mayo.png
```

`view` is one of:
- `default` — leave the camera where it starts
- a landmark slug from `../data/tiles/landmarks.json` (e.g. `virginia-state-capitol`), zoom 4 by default
- a named spot: `intersection`, `church-hill`, `river`

`--at X,Z` jumps to a raw local coordinate instead (metres, x east, z = -north).
`window.__iso.where()` prints the current camera target in this same coordinate
system — another engineer is adding it — so you can pan around in the browser
and paste the numbers straight into `--at`.

Prints one JSON stats line (tile/triangle counts, timings) to stdout.

## smoke.mjs

```
node tools/smoke.mjs
npm run smoke
```

Loads the viewer, waits up to 180s for it to settle, and fails (non-zero
exit, clear message) if: no tiles loaded, `stats().tiles.full` is 0, any
non-benign console error appears, or clicking a toolbar button produces a new
error. On success it writes `snapshots/default.png`, `snapshots/capitol.png`,
and `snapshots/river.png`. `snapshots/` is gitignored.

## lib/browser.mjs

Shared helpers (`launchBrowser`, `openViewer`, `readStats`, `errorLogs`) used
by both scripts above.
