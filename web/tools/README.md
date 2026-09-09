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

## deploy.mjs

```
npm run deploy -- [--remote <git url>] [--base /<repo>/] [--dry-run]
```

Typechecks, runs `vite build` with `BASE_PATH` set (default `/<repo name>/` from the remote, which the app reads
as `import.meta.env.BASE_URL` for tiles, landmark models and workers), copies `data/tiles` and
`assets/landmarks` into `dist/` (done by `vite.config.ts`), adds `.nojekyll`, and force-pushes `dist/` as the
`gh-pages` branch. Pages must serve that branch from `/` (set once with
`gh api -X PUT repos/<owner>/<repo>/pages -f "source[branch]=gh-pages" -f "source[path]=/"`). `--dry-run`
builds without pushing. Run the pipeline first: the tiles in `dist/` are whatever `data/tiles` holds.

## lib/browser.mjs

Shared helpers (`launchBrowser`, `openViewer`, `readStats`, `errorLogs`) used
by both scripts above.
