# Scott's Addition and Diamond District expansion plan

## Goal

Extend the Richmond viewer northwest from the current Fan/VCU coverage through Scott's Addition and
the Diamond District. The delivered present-day scene must include both stadium sites that currently
exist: CarMax Park and the former Flying Squirrels stadium (The Diamond), alongside the surrounding
industrial, commercial, residential, rail, road, parking, and construction context.

This is a continuous Richmond expansion, not two disconnected mini-maps. Its road graph, terrain,
tile grid, search index, and visual language must join the existing Richmond extent without seams.

## Outcomes and acceptance criteria

- The active Richmond extent covers the complete Scott's Addition-to-Diamond corridor, with a review
  margin around its perimeter; the exact WGS84 bbox is recorded before source downloads.
- Both CarMax Park and The Diamond resolve to reviewed, exact landmark targets. A nearby large
  footprint must never be accepted as a match merely because it is non-null.
- The built scene reflects one documented source-as-of date, while representing both existing stadiums.
  Construction, cleared parcels, parking, and temporary surfaces are rendered only where supported by
  current evidence.
- Roads, sidewalks, rail-adjacent areas, fields, parking, terrain, buildings, trees, and search work
  across the old/new extent boundary; no duplicate tiles or isolated traffic graph are introduced.
- The stadiums read clearly at overview distance and remain geographically correct up close. Landmark
  models are used only where the procedural base cannot convey the important silhouette or massing.
- Desktop and 390 x 844 mobile reviews pass, including a selected stadium and a selected ordinary
  building near the expanded-area boundary.

## Scope boundary

The survey phase selects the final rectangular bbox. It should include the whole Scott's Addition and
Diamond District corridor plus enough surrounding blocks to avoid cutting primary streets, rail edges,
parking fields, or stadium approaches at the map edge. Do not set that boundary from a marketing
district polygon alone.

In scope:

- Current observed geometry and land cover in Scott's Addition, the Diamond District, CarMax Park,
  and The Diamond.
- Supporting streets, paths, parking, rail-adjacent geometry, major green space, named buildings,
  and public-facing stadium surroundings needed for a coherent scene.
- Landmark models or reviewed procedural supplements for the two stadiums and any nearby feature whose
  silhouette is essential to orientation.

Out of scope for this pass:

- A speculative future buildout inferred from planning controls, renderings, or parcel entitlements.
- A historical time toggle or demolition timeline.
- Detailed interiors, seating bowls, signage inventories, and construction equipment that cannot be
  verified at map scale.

## Delivery sequence

### 1. Establish an evidence ledger and the exact extent

1. Select the bbox in EPSG:4326 and project it to the Richmond working CRS (EPSG:32618) for all
   distance and area work. Snap the projected bounds to the existing 250 m tile grid so the old and
   new tiles share an origin and no boundary slivers are created.
2. Record a source ledger in a new Richmond-area note: provider, URL/item ID, access date, acquisition
   date, CRS, horizontal/vertical units, coverage, license/attribution, and intended use. Distinguish
   *observed current* sources from planning controls and promotional images.
3. Inventory the two stadiums before coding. For each, record its verified footprint/parts, ground
   elevation, public-facing frontage, height/massing evidence, current surrounding surfaces, and the
   exact source feature ID that the landmark registry will target.
4. Compare at least two independent current references for construction-sensitive parcels. Where the
   sources disagree in date, prefer the newer observed geometry; do not fill gaps with a proposed site
   plan. Add a reviewed override only when the newer condition is clear and cite that evidence.
5. Capture the baseline tile count, feature counts, payload size, tile-worker timings, and current
   desktop/mobile screenshots before increasing the extent.

Decision gate: approve the extent and the source-as-of date before downloading or modeling. This keeps
the two existing stadiums in one coherent present-day scene without quietly mixing incompatible vintages.

### 2. Make the expanded extent a first-class pipeline input

1. Add a named Richmond expansion slice/profile in configuration, rather than embedding coordinates in
   one-off shell commands. The profile must expose its WGS84 bbox, projected/grid-aligned bounds, raw
   source cache location, and output identity.
2. Decide the manifest strategy before implementation:
   - Preferred first delivery: rebuild one contiguous Richmond manifest over the union of the current
     active extent and the approved expansion bbox. This is the lowest-risk path for a single viewer
     index, tile origin, landmark registry, and traffic graph.
   - Follow-up only if build cost justifies it: implement the roadmap's named multi-bbox/slice support,
     with a merged manifest and the same grid origin. Never publish independently generated tile sets
     that can overwrite each other or leave the viewer with only the last slice.
3. Keep Richmond raw/derived products keyed by the approved bbox slug. Do not reuse a terrain raster,
   normalized point cloud, imagery crop, or stale tile manifest generated for the smaller extent.
4. Add tests for slice/bbox selection, grid alignment, and a union build whose manifest contains both
   an existing Fan tile and a new Diamond District tile.

### 3. Acquire and validate source layers

Acquire each source for the approved extent, then inspect its coverage and counts before building:

| Need | Preferred evidence | Validation |
|---|---|---|
| Base buildings, roads, paths, land use, pitches, POIs | Current OSM plus the existing Richmond fetch workflow | Confirm requests completed; inspect feature counts and known stadium/rail/parking records. |
| Building gaps and parts | City/VGIN footprint data, with OSM retained as the primary semantic source | Compare large stadium footprints and current construction parcels; retain IDs and subtype semantics. |
| Terrain and building height | Richmond 2025 NOAA DEM and LiDAR, rebuilt for this bbox | Verify CRS, vertical datum/units, nodata, coverage, and that nDSM is derived from the same DEM. |
| Roof colour and ground cover | VGIN RGB plus NAIP NIR, with LiDAR as a roof/tree exclusion | Record dates; use newer RGB evidence narrowly to veto stale vegetation on cleared construction sites. |
| Trees | Richmond inventory where coverage exists, then LiDAR-derived crowns | Remove inactive/duplicate records and retain inventory provenance. |
| Stadium identity/massing | Reviewed current aerial/street/official public references and LiDAR | Verify exact target ID, footprint, orientation, eave/ridge levels, and public-facing silhouette. |

Update `ATTRIBUTION.md` for every new source actually used. A failed request is a failure, not an empty
layer: retain completed inputs, retry the failed layer, and check coverage again.

### 4. Build the base map before landmark art

1. Produce the expanded DEM first, then regenerate LiDAR/nDSM products and all dependent layers.
2. Fetch/process OSM, Overture, City/VGIN, city planning data (if retained as a separate companion
   layer), imagery, tree inventory, and ground cover for the union extent.
3. Run the ordinary height and roof precedence unchanged: observed OSM height, levels, LiDAR, Overture,
   and existing fallbacks. Planning height limits and renderings must not replace observed buildings.
4. Run ground-cover classification with the existing vector exclusions after raster classification.
   Review cleared lots, surface parking, rail edges, stadium turf, and construction zones specifically;
   recalibrate imagery thresholds only from measured source behaviour, not from Richmond-wide defaults.
5. Preserve sports semantics through clipping. If either stadium's field is represented as a pitch,
   retain `sport` and `surface`, derive the baseball orientation from the complete source geometry, and
   layer turf, dirt, and paint in the established priority order. Do not use a square infield or infer
   a field from a generic park polygon.
6. Build the union tiles incrementally, inspect the active `index.json`, and confirm that stale files
   outside the manifest cannot influence counts or deployment output.

### 5. Stadium and district representation

#### CarMax Park

1. Start with the verified current footprint/parts and measured terrain/height evidence.
2. Use a landmark model only for the massing and high-signal public cues that cannot be represented by
   procedural parts: bowl/roof silhouette, principal facade rhythm, entry-side identity, and major
   open-field geometry where visible at map scale.
3. Keep the model aligned to the exact target's ground datum and public frontage. Do not orient it from
   the longest bounding-box axis without verifying the named street/frontage.
4. Keep procedural surrounding buildings, roads, parking, and ground cover active; the landmark swap
   must suppress only overlapping stadium masses.

#### The Diamond (former Flying Squirrels stadium)

1. Treat it as an independently verified current landmark, not as a fallback match for CarMax Park or
   an adjacent civic/industrial footprint.
2. Model the recognizable scale cues first: field/bowl mass, roof/lighting silhouette where supported,
   principal entrance/frontage, and surrounding parking/approach pattern. Avoid unverified seating,
   signs, or façade detail.
3. Preserve its own exact landmark ID, source notes, orientation, and acceptance screenshots. Both
   stadium entries must resolve correctly in the generated landmark manifest.

For both sites, export compact GLBs only after reviewing whether procedural massing is insufficient.
Join compatible materials, preserve vertex colours, check draw calls, and verify model hashes in the
actual deployed viewer. After every landmark change, rebuild tiles and confirm `data/tiles/landmarks.json`
contains the intended `model` path before judging the browser result.

### 6. Roads, rail, access, and traffic

1. Review all primary approaches, service drives, parking aisles, paths, crossings, and rail-adjacent
   features at the expansion boundary. Preserve surveyed centre lines and grade separation; do not
   extend paths or bus-only ways as ordinary car junctions.
2. Test the I-95/rail/overpass and any cut/bridge conditions found in the selected extent using the
   terrain's actual triangle interpolation. Ground-supported approaches must drape to terrain; true
   spans retain their supplied deck profile.
3. Verify at-grade intersections include the appropriate paved arms without inventing sidewalks,
   crosswalk paint, traffic islands, or stop lines. Run the existing road topology regressions for any
   changed processing/rendering rules.
4. Expand the traffic graph with the same union manifest. Check boundary entry/exit behaviour and
   density across the old/new seam; never seed a second independent traffic population in the new tiles.

### 7. QA, review, and deployment

1. Add focused tests for every new algorithm or reviewed override. At minimum cover exact landmark
   matching for both stadiums, sports-field orientation/priority if applicable, grid alignment, and
   any new construction/footprint exception.
2. Run relevant pipeline tests, `npm run typecheck`, `npm test`, and a production build. Run the full
   pipeline twice (cached and `--no-cache`) when pipeline dependencies change, then compare active tile
   output rather than directory globs.
3. Create named browser review stops for: CarMax Park, The Diamond, a Scott's Addition street/industrial
   block, a construction-sensitive parcel, an expanded-area boundary tile, a rail/grade-separation
   location, and a wide overview containing both stadium districts where possible.
4. Capture desktop and mobile screenshots after camera animation and tile loading have both settled.
   On mobile, test a selected stadium and a selected ordinary building so the selection card does not
   obscure controls or attribution.
5. Record source limitations, verified exceptions, screenshot locations, test results, and unresolved
   approximations in a Richmond-specific note. If a new reusable defect is fixed, append its symptom,
   root cause, rule, code/test references, and limits to `docs/map-building-playbook.md`.
6. Deploy only after the active manifest, landmark model paths, payload/performance checks, and browser
   review all pass. Verify the published `gh-pages` commit and the live build status afterward.

## Work breakdown

| Milestone | Deliverable | Exit condition |
|---|---|---|
| A. Survey | Approved bbox, source ledger, stadium identity sheet | Current sources agree enough to model both sites; unknowns are explicitly listed. |
| B. Extent plumbing | Named config and union-manifest path with tests | Existing and new tiles share one grid/origin and appear in one active manifest. |
| C. Source build | Validated terrain, LiDAR, imagery, vectors, trees | Coverage/count checks pass and source provenance is recorded. |
| D. Base scene | Expanded procedural map | Seam, roads, terrain, ground cover, search, and traffic work before landmark swaps. |
| E. Landmarks | CarMax Park and The Diamond representations | Exact targets, orientations, model paths, and map-scale visual checks pass. |
| F. QA/deploy | Review captures, tests, published site | Desktop/mobile acceptance checks pass and Pages serves the new deployment. |

## Risks to resolve early

- **Mixed dates in a fast-changing district:** maintain the source-as-of ledger and use reviewed
  overrides sparingly; do not merge a proposal rendering with observed terrain/footprints.
- **Stadium identity errors:** exact source IDs and visual position checks are mandatory because a
  nearest-footprint fallback has already mislabeled a police precinct as a stadium.
- **A partial slice overwriting active tiles:** publish only a union manifest with shared grid origin;
  validate `index.json` rather than trusting files left on disk.
- **Large-area performance regression:** measure tile-worker timings, payload, tree counts, and landmark
  draw calls before and after; retain reduced-detail behaviour for distant tiles.
- **False sports geometry:** preserve typed pitch inputs and complete-feature orientation; otherwise use
  an unmarked verified surface rather than invented field markings.
