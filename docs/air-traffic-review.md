# Aircraft over the isometric map: feasibility review

Reviewed 2026-09-09 after completing the Richmond geometry fixes. This is a proposal; no aircraft
layer or remote backend change has been implemented.

## Existing integration worth reusing

- [Aircraft adapter](https://github.com/chance-labs/rva/blob/HEAD/backend/sources/aircraft.js):
  ADSB.lol point endpoint, 40 nautical miles around Richmond, refresh every 30 seconds; validates
  coordinates and position age, expires records after 90 seconds, recognizes helicopter category A7.
- [Motion helper](https://github.com/chance-labs/rva/blob/HEAD/src/aircraftMotion.ts):
  great-circle prediction from speed/track, capped at 45 seconds, with smooth correction to new reports.
- [Map rendering](https://github.com/chance-labs/rva/blob/HEAD/src/MapView.tsx):
  two-second position blending, separate plane/helicopter icons, reduced-motion support and expiry.
- The backend exposes `/api/feed?types=aircraft`; it currently has CORS enabled. A deployed backend URL
  still needs to be established for this viewer; repository access is not proof of an available service.
- [ADSB.lol API documentation](https://www.adsb.lol/docs/open-data/api/) says its API is public and
  licensed ODbL 1.0. Preserve source/license attribution. The existing adapter identifies its requests
  with a User-Agent and does not require a key.

## Missing for actual 3D flight

The adapter currently formats altitude into body/details text. Its normalized model preserves heading,
ground speed and kind, but not numeric altitude, altitude reference, vertical rate or an explicit ground
flag. Extend the adapter, `makeItem` whitelist and shared types together. Do not parse the display string.
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

## Suggested first pass

1. Numeric aircraft contract + parser/expiry tests, with helicopter/unknown/on-ground cases.
2. Region projection, altitude conversion and bounded motion, tested with recorded fixtures.
3. Opt-in Aircraft layer with simple models, rotor animation, camera culling and hover details.
4. Live feed integration and browser checks: update jumps, stale feed, Pause, all styles and tile changes.

Technically feasible. Rendering a modest number of lightweight aircraft should be small compared with
the existing city geometry; altitude handling, live-data semantics and camera visibility are the main
integration work. No performance claim has been benchmarked for aircraft yet.
