# 3301 West Cary Street 7-Eleven facade

The building at 3301 West Cary Street is a small, low commercial footprint (`osm:way/236014923`,
approximately 20 × 28 m and 4 m tall). A full marketplace building would be a poor fit for this
map's scale and would introduce unnecessary licensing and polygon cost. The viewer keeps the
surveyed footprint and adds a procedural low-poly storefront during full-detail tile builds.

The facade follows the user-provided street reference: brick end wings, dark storefront glazing,
a projecting brown fascia, red/green/red horizontal bands, a central white 7-Eleven color mark,
an orange canopy lip and a small pole sign. The treatment is attached by stable OSM id and also
recognizes a building whose name/address/website contains `7-Eleven`; it is omitted from reduced
detail tiles. It does not claim surveyed sign dimensions or reproduce small window advertising.

Implementation is in `web/src/buildings.ts` (`isSevenEleven`, `addSevenElevenFacade`) and uses the
shared palette keys in `assets/palette.json`. The facade is geometry-only so existing styles,
lighting, outlines and selection ranges continue to apply. `web/src/buildings.test.ts` guards the
target matching. The user-provided image remains a visual reference and is not bundled or traced as
an image texture.

Targeted review:

```sh
cd web
node tools/snap.mjs --at 400,-4462 --zoom 12 -o snapshots/fan/7-eleven-detail.png
```

The projected target is the building's local coordinate from the active tile manifest. If the map
extent changes, use address search or regenerate the target from `pipeline/tiles_inspect.py find`.
