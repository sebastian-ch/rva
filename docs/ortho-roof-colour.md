# Roof colour from orthoimagery

Before this, `roof_color` was `seed % 4` over a handful of palette keys unless OSM happened to carry
`roof:colour`, which it does for a negligible share of Richmond. Heights were surveyed, roof *shapes*
were fitted from LiDAR, and the colour on top of them was invented. This closes that gap with the one
source that actually sees a roof: a nadir aerial photograph.

Implementation: `pipeline/fetch_naip.py` (acquire) and `pipeline/ortho.py` (sample + classify), with
tests in `pipeline/tests/test_ortho.py`.

## Source

NAIP (USDA National Agriculture Imagery Program): public domain, 0.6 m, and 4-band (R, G, B, NIR) for
recent Virginia flights. Public domain matters here — VGIN's VBMP orthoimagery is sharper (~6 in) but
`ATTRIBUTION.md` still records its terms as "check current terms", and this pipeline derives a
published dataset from what it reads. `fetch_naip.py --service <url>` will point at VBMP once that
question is settled.

```
.venv/bin/python pipeline/fetch_naip.py --dry-run     # print the request plan
.venv/bin/python pipeline/fetch_naip.py               # -> data/raw/ortho_<slug>.tif
.venv/bin/python pipeline/build_tiles.py              # buildings step picks it up
```

The USGS image server caps a single export well below the ~10000 × 9500 px the Richmond bbox needs at
0.6 m, so the export is tiled. Every tile's bounds are derived from the destination transform, so
tiles land on exact destination pixels and mosaic without a resampling seam.
For large exports, request `f=json` and download the returned `href`; the live USGS service can return
HTTP 500 for the equivalent direct `f=image` response even after it successfully generates the TIFF.

The ortho is an optional input, like LiDAR: with no `ortho_<slug>.tif` present every roof keeps the
seeded colour and nothing else changes.

## The three things that make a roof photo hard to read

### Lean

NAIP is orthorectified against a bare-earth model, not against buildings. A roof is therefore
displaced radially from the nadir point by roughly `height × tan(off-nadir angle)` — tens of metres
for a downtown tower. Sampling a tall building's footprint often samples the street beside it.

The fix is to shrink the footprint inward by the expected displacement before sampling. Shrinking a
polygon by `d` leaves a core contained in the polygon translated by *any* vector of length `≤ d`, so
whatever direction the lean went, the core is still on the roof. Buildings too small or too thin to
survive the shrink produce no samples at all, which is the correct outcome: those are exactly the
ones the displacement carries clean off their own footprint.

`LEAN_FRAC = 0.12` (≈ 7° off-nadir) is an estimate of the typical angle across a frame, not a
per-pixel solution. Doing this properly needs the image's own acquisition geometry, which the export
service does not hand out. Treat the tall-building results as the weakest ones — and note that the
weakness is self-limiting, since the shrink discards the tallest and thinnest footprints entirely.

### Trees

A crown over a roof is greener than any roof material. With NIR present, NDVI decides
(`(nir − red) / (nir + red) > 0.15`); without it, excess green (`2g − r − b`) stands in. Vegetation
pixels are dropped, and a footprint more than half vegetated returns nothing rather than the colour
of a tree. This is the single biggest source of wrong answers in the Fan, where the canopy closes over
whole blocks of rowhouses.

### Shadow

A neighbour's shadow across part of a roof drags the median dark. Pixels below 55% of the footprint's
own median luminance are dropped once, then the median is taken from what remains. Keying the
threshold to the footprint's own median rather than an absolute value is what keeps a genuinely dark
roof from being rejected as shadow — there is a test for exactly that.

## Classification, not nearest-neighbour

The obvious approach — nearest palette swatch in colour space — is wrong here for two reasons. A
photograph of Richmond is nowhere near `palette.json`'s saturation, so every swatch distance is large
and the ranking among them is noise. And nearest-neighbour always answers, when the most valuable
output is "I cannot tell".

So `classify_roof_tone` works in CIE L\*a\*b\*: chroma decides whether the roof is coloured at all,
hue picks among the coloured keys, and lightness walks a neutral ladder otherwise.

| condition | key | material |
|---|---|---|
| C\* ≥ 12, hue 10–75°, L\* ≥ 62 | `roof_flat` | pale sand ballast, not tile |
| C\* ≥ 12, hue 10–75°, L\* < 35, C\* < 22 | `brick_dark` | brown asphalt shingle |
| C\* ≥ 12, hue 10–75° otherwise | `roof_red` | clay tile, red shingle, rusted metal |
| C\* ≥ 12, hue 100–190° | `roof_green` | copper patina, painted metal |
| C\* ≥ 8, hue 200–290° | `slate` | blue-grey standing seam |
| L\* ≥ 62 | `roof_flat` | white membrane, light gravel |
| L\* ≥ 40 | `concrete` | weathered deck, grey metal |
| otherwise | `roof_dark` | black shingle, tar and gravel |

The `brick_dark` row is the one worth defending: brown asphalt shingle is a large share of Richmond's
housing stock and is genuinely warm, but mapping it to `roof_red` makes a neighbourhood look like
terracotta Tuscany. The chroma ceiling separates it from actual tile.

## Precedence

OSM `roof:colour` → ortho → seeded guess, with `overrides.json` applied last as always. A surveyed tag
is a person's assertion about a specific building and outranks a photograph; the photograph outranks
a hash of the feature id. `roof_color_source` records which one won and the QA report histograms it,
so a regression shows up as coverage moving back to `heuristic`.

Landmarks keep the stylized flat-roof treatment (`roof_color_source = "landmark"`) — those are meant
to read as designed, not as surveyed, until a hand-modelled glTF replaces them.

## Known limitations

- **Lean is estimated, not solved** (above). Tall buildings are the weakest results.
- **Flight date.** NAIP flies leaf-on summer; a roof replaced since the flight is wrong, and the Fan's
  canopy is at its worst. `overrides.json` is the escape hatch, same as for heights.
- **Walls are untouched.** Nadir imagery cannot see a facade, so `wall_color` is still the seeded
  guess. Street-level imagery is the source for that; see the roadmap.
- **One colour per building.** A roof with two materials gets the median, and a merged rowhouse block
  gets the modal colour of its members.
- **Not validated against the live service.** The classifier and the sampler are tested against
  synthetic rasters; the export path in `fetch_naip.py` has not been run against the USGS image server
  from this environment (outbound access was blocked). Check the first real run's `--dry-run` plan and
  the QA histogram before trusting coverage numbers.
