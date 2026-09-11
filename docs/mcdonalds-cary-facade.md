# 3410 West Cary Street McDonald's facade

The Carytown McDonald's is mapped as `osm:way/235998654` with a City of Richmond address and a
LiDAR-derived 4.49 m roofline. The full-detail renderer preserves that footprint and height, then adds a
site-specific low-poly treatment from the user-provided September 2026 references.

The reference set includes an overhead view, the short customer-facing elevation on West Cary Street, and
the long east elevation. The model uses gray/taupe walls, a dark raised sign tower, white canopy and parapet
bands, dark storefront glazing, a low stone patio enclosure, and small geometry-built golden arches. The
Cary storefront belongs on the footprint's short south end; the long axis runs back from the street. The east
wall receives its own sign panel and canopy band.

The treatment is keyed to the exact OSM way ID so other Richmond McDonald's locations keep the ordinary
building style. It is emitted only with full building detail. The signs are simplified geometry rather than
textured logos, and the patio, glazing divisions and canopy depths are visual estimates from the supplied
images rather than surveyed dimensions.

Implementation: `web/src/buildings.ts`. Regression: `web/src/buildings.test.ts`. Visual review:
`web/tools/review-geometry.mjs`, view `cary-mcdonalds`.
