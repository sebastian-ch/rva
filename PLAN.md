# Isometric Richmond, Virginia — Project Plan

Goal: a browser-based, stylized isometric 3D model of Richmond, VA, in the style of low-poly "little worlds" city explorers (reference: DFWZOO Fort Worth Stockyards). The bulk of the city is procedurally generated from open geodata; a curated list of landmarks is hand-modeled; everything renders with an orthographic camera and a warm, flat-shaded art style.

---

## 1. Scope and art direction

- Start with a bounded district, not the whole city. First slice: Downtown + Shockoe Bottom + Capitol Square (~2 sq mi).
- Later slices: The Fan / VCU, Carytown, Church Hill, Scott's Addition, Manchester.
- Style bible:
  - Flat shading, 8–12 color palette, chunky simplified geometry
  - No photo textures; baked ambient occlusion
  - Faux-isometric orthographic camera, ~35° elevation, 45° azimuth
  - Warm sun + fog gradient, optional day/night toggle
- Runtime: three.js with glTF assets. Authoring: Blender.

## 2. Data acquisition and inventory

Do this before writing any generation code. Data quality decides everything downstream.

### 2a. Vector data — OpenStreetMap (ODbL)

| Layer | Tags / fields needed |
|---|---|
| Building footprints | `building`, `building:levels`, `height`, `roof:shape`, `roof:colour`, `building:material`, `name`, `addr:*` |
| Roads | `highway`, `lanes`, `oneway`, `surface`, `sidewalk`, `crossing` nodes |
| Rail | `railway` (Main Street Station, Acca Yard corridors) |
| Land cover | `landuse`, `leisure=park`, `amenity=parking`, `natural=water`, cemeteries |
| Water | James River, Belle Isle, Haxall / Kanawha Canal |
| POIs | shops, restaurants, museums, monuments, bus stops, benches, streetlights |
| Trees | `natural=tree` points (patchy coverage — supplement below) |

Sources:
- Overpass API for small areas
- Geofabrik Virginia extract + `osmium` for the full city

### 2b. Supplementary open data

| Source | What it provides |
|---|---|
| Overture Maps (buildings) | Merged OSM + Microsoft + Google Open Buildings footprints, often with heights OSM lacks |
| City of Richmond GIS open data portal | Building footprints, parcels, zoning, address points, street tree inventory |
| VGIN (Virginia Geographic Information Network) | Statewide LiDAR point clouds; VBMP orthoimagery (~6 in resolution) |
| USGS 3DEP | 1 m DEM for terrain (Richmond has real relief: river, Church Hill, Libby Hill) |
| USGS NAIP | Public-domain aerial imagery for roof color sampling and land cover |

LiDAR → normalized DSM is the best source for building heights and roof shape.

### 2c. Imagery for reference and detail

| Source | Use | License note |
|---|---|---|
| Google Photorealistic 3D Tiles, Street View | Visual reference for landmark modeling and facade colors | Reference only — no derived datasets |
| Mapbox Satellite | Visual reference | Reference only — no derived datasets |
| Mapillary | Street-level imagery; OK for machine extraction | CC BY-SA |
| Own photo survey | Landmark reference | Ours |

**Licensing rule:** Google and Mapbox terms prohibit deriving datasets from their imagery. Automated extraction happens only from OSM, Overture, VGIN, NAIP, and Mapillary. Keep an attribution list from day one.

### 2d. Landmark list (hand-modeled, first pass)

- Virginia State Capitol
- Main Street Station
- The Jefferson Hotel
- Old City Hall
- Carpenter Theatre / Dominion Energy Center
- Federal Reserve Bank of Richmond
- James Monroe Building
- Dominion Energy tower (600 Canal Place)
- Altria Theater
- Byrd Theatre
- Monument Avenue streetscape
- Hollywood Cemetery
- Belle Isle footbridge
- Mayo Bridge
- Canal Walk + Tredegar Iron Works
- The Diamond
- VCU Cabell Library
- Maggie L. Walker memorial

## 3. Processing pipeline

- Python: `osmnx`, `geopandas`, `shapely`, `rasterio`, `pyproj`
- Reproject to Virginia State Plane South (EPSG:2284) or UTM 18N (EPSG:32618) so units are linear and geometry does not skew.
- Height resolution order per building:
  1. OSM `height`
  2. OSM `building:levels` × 3.2 m
  3. LiDAR nDSM median inside footprint
  4. Zoning-based default
- Roof classification: OSM `roof:shape` if present; otherwise fit LiDAR points to flat / gable / hip. Fan and Church Hill rowhouses are mostly flat or shallow gable, so the fallback matters.
- Sample NAIP roof color per footprint, snap to palette.
- Simplify footprints (Douglas–Peucker); merge touching rowhouse footprints into blocks.
- Tile the city into ~250 m squares; write one GeoJSON / GeoParquet per tile.

## 4. Procedural generation

- Extrude footprints with roof geometry.
- Facade kit of parts: window rows, doors, awnings, cornices selected by building type and height. This is what separates "designed" from "extruded."
- Roads as ribbon meshes with lane markings; sidewalks as offset polygons; crosswalks at OSM crossing nodes.
- Trees, cars, streetlights, people as instanced low-poly meshes along sidewalks and in parks.
- Terrain from DEM; water with a stylized rapids texture on the James.
- Authoring: Blender offline (import via Blosm or BlenderGIS), bake AO, export compressed glTF. Alternative: generate at load time in three.js.

## 5. Landmark modeling

- Model the landmark list by hand in Blender, matching the style bible.
- Reference: Street View, Google 3D Tiles, own photos.
- Budget 1–3 days per building.
- Align to the OSM footprint so each drops into its tile.

## 6. Rendering and interaction

- three.js `OrthographicCamera`; toon or flat `MeshStandardMaterial`; AO baked into vertex color.
- Click-to-select buildings → info card (name, address, description, Wikidata / official link), like the Livestock Exchange panel in the reference.
- Guided camera tours between landmarks.
- Day/night toggle, pause motion, map view toggle.

## 7. Optimization

- Draco or meshopt compression; texture atlases; instancing for props.
- Tile-based loading and LOD by distance from camera.
- Target < 30 MB initial load for one district.

## 8. Attribution, QA, release

- OSM and Overture credits in UI; data sources page.
- QA pass: walk every block against imagery for misplaced or mis-sized buildings.

---

## Suggested order of work

1. Steps 1–2 for a single downtown tile.
2. Get one block rendering end to end through step 6.
3. Validate the LiDAR height/roof pipeline before investing in art.
4. Widen the area; add landmarks.

Most of the risk is in data quality for heights and roofs, not in rendering.
