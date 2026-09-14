# Aircraft over the isometric map: feasibility review

Reviewed 2026-09-09 after completing the Richmond geometry fixes; first viewer pass implemented
2026-09-14 using the existing `rva-live` API.

## Existing integration worth reusing

- [Aircraft adapter](https://github.com/chance-labs/rva/blob/HEAD/backend/sources/aircraft.js):
  ADSB.lol point endpoint, 40 nautical miles around Richmond, refresh every 30 seconds; validates
  coordinates and position age, expires records after 90 seconds, recognizes helicopter category A7.
- [Motion helper](https://github.com/chance-labs/rva/blob/HEAD/src/aircraftMotion.ts):
  great-circle prediction from speed/track, capped at 45 seconds, with smooth correction to new reports.
- [Map rendering](https://github.com/chance-labs/rva/blob/HEAD/src/MapView.tsx):
  two-second position blending, separate plane/helicopter icons, reduced-motion support and expiry.
- The deployed backend exposes `https://api.sebastianhancock.com/api/feed?types=aircraft` with CORS enabled.
- [ADSB.lol API documentation](https://www.adsb.lol/docs/open-data/api/) says its API is public and
  licensed ODbL 1.0. Preserve source/license attribution. The existing adapter identifies its requests
  with a User-Agent and does not require a key.

## Missing for actual 3D flight

The deployed adapter currently formats altitude into body/details text. Its normalized model preserves heading,
ground speed and kind, but not numeric altitude, altitude reference, vertical rate or an explicit ground
flag. The viewer accepts numeric altitude fields first and isolates a strict parser for the current labeled
`Altitude` detail as a compatibility bridge. Extend the backend adapter, `makeItem` whitelist and shared types
together, then remove that bridge.
Preserve barometric and geometric altitude separately, plus their provenance and timestamps. Barometric
altitude is not terrain-relative height; GNSS altitude also needs a compatible vertical datum before
comparison with the map's NAVD88 terrain. Unknown altitude should not become a made-up low flight.
Unknown aircraft categories should retain an unknown fallback, rather than always becoming a plane.

Add a reusable geographic-to-projected transform for each region (Richmond is UTM18N); the viewer now
consumes preprojected tile coordinates. Convert speed from knots to metres/second and altitude from feet
to metres once. Reuse bounded prediction and smooth corrections, including heading wrap at north.
Use a persistent aircraft scene group independent of streamed ground tiles: planes cross tile borders.
Render lightweight plane/helicopter models with heading, rotors, optional labels and style-aware lights.
Expire stale records even when the feed fails; honor Pause and reduced motion; clean up timers/resources.

## Visibility and altitude policy

Fetch a buffered region and test the aircraft's actual 3D position against the camera frustum. A point
above the visible ground footprint is not necessarily on screen in an oblique view. High-altitude jets
can legitimately be outside the current camera volume (far plane currently 6,000 world units). Do not
simply place every aircraft at rooftop height. Start with airborne aircraft actually visible in the 3D
scene; a separately labeled schematic altitude mode can be considered if the user wants high overflights
to remain visible. Keep reported altitude unchanged in labels. Revisit camera clipping deliberately.

Use the existing backend's cached feed, with numeric fields added, or a small equivalent server adapter.
The current isometric site is static; do not bundle the unrelated police/news/browser-scraping backend.
Deployment needs a reachable feed/proxy and failure/expiry handling, not a new authentication system.

## First-pass result

`web/src/aircraft.ts` polls the deployed feed every 30 seconds, expires stale positions, predicts motion for
at most 45 seconds and blends corrections over two seconds. It projects WGS84 positions into UTM 18N, converts
reported feet to the terrain's vertically exaggerated metre frame, and keeps the scene group independent of
streamed tiles. The Richmond toolbar controls lightweight airplane/helicopter models; Pause freezes motion and
the helicopter rotor, and reduced-motion preferences use reported positions. Aircraft outside the map extent
or without usable altitude remain hidden. `web/src/aircraft.test.ts` covers altitude compatibility, projection,
bounded prediction and expiry. The source is configurable with `VITE_AIRCRAFT_API_URL`.

Still needed: add structured altitude/reference/ground fields to `rva-backend`, click/hover details, and browser
checks for refresh correction, all styles and camera visibility. No aircraft performance claim has been
benchmarked yet.
