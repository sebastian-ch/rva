# Data Source Attribution

Update this file whenever a new data source is added.

## OpenStreetMap

- **What we use it for:** Building footprints, heights, roof shapes, roads, rail, land cover, water, POIs, trees.
- **License:** ODbL 1.0 (Open Data Commons Open Database License)
- **Required attribution:** © OpenStreetMap contributors
- **URL:** https://www.openstreetmap.org/copyright

## Overture Maps Foundation Buildings

- **What we use it for:** Building footprints and heights (merged OSM + Microsoft + Google Open Buildings, often with heights OSM lacks).
- **License:** ODbL 1.0 for OSM-derived features; CDLA-Permissive-2.0 for others.
- **Required attribution:** Overture Maps Foundation
- **URL:** https://overturemaps.org

## USGS 3DEP Elevation

- **What we use it for:** 2 m digital elevation model as the fallback terrain (`pipeline/fetch.py`) when the 2025 City of Richmond DEM is not available.
- **License:** Public domain
- **Required attribution:** USGS 3D Elevation Program
- **URL:** https://www.usgs.gov/3d-elevation-program

**LiDAR point clouds (fallback):** `pipeline/fetch_lidar.py --source usgs2014` uses the 3DEP lidar point cloud `USGS_LPC_VA_Sandy_2014_LAS_2015`, accessed as Entwine Point Tiles from the USGS public S3 bucket (`usgs-lidar-public`). Public domain (U.S. Government work).

## 2025 City of Richmond Lidar (NOAA Digital Coast)

- **What we use it for:** terrain (the 1 ft bare-earth DEM tiles, resampled to 1 m by `pipeline/dem_noaa.py`) and the default LiDAR source for building heights (normalized DSM) and roof-shape classification; flown 2025-02-14..03-01 by Sanborn for the City of Richmond, 0.35 m pulse spacing, classified LAS 1.4. Accessed as Entwine Point Tiles (`noaa-nos-coastal-lidar-pds`, dataset 14835, EPSG:3748 + NAVD88). The 1 ft DEM and 0.3 m DSM tiles ordered from the Data Access Viewer are kept in `data/raw/` for reference.
- **License:** CC0 1.0 Public Domain Dedication (U.S. Government work)
- **Required attribution:** none required; cite as "Office for Coastal Management, [date of access]: 2025 City of Richmond Lidar: Richmond, VA, https://www.fisheries.noaa.gov/inport/item/80312". Credit: City of Richmond, VA; Sanborn Map Company, Inc.
- **URL:** https://www.fisheries.noaa.gov/inport/item/80312

## USGS/USDA NAIP Imagery

- **What we use it for:** Public-domain aerial imagery for roof color sampling and land cover.
- **License:** Public domain
- **Required attribution:** USGS/USDA
- **URL:** https://www.usgs.gov

## Virginia Geographic Information Network (VGIN)

- **What we use it for:** Statewide LiDAR point clouds and VBMP orthoimagery (~6 in resolution). The `VBMP_Imagery/MostRecentImagery_WGS` MapServer (Spring 2022/2023/2025, whichever is newest per area) is the visual reference for hand-traced footprints in `assets/supplements/overrides.json`, e.g. the Allianz Amphitheater seating bowl (traced 2026-09-09). Copyright text on the service: "Virginia Geographic Information Network (VGIN)".
- **License:** Open data; check current terms
- **Required attribution:** Check current terms
- **URL:** https://vgin.vdem.virginia.gov

## City of Richmond GIS Open Data Portal

- **What we use it for:** Building footprints, parcels, zoning, address points, street tree inventory.
- **License:** Open data; check current terms
- **Required attribution:** City of Richmond
- **URL:** https://richmond-geo-hub-cor.hub.arcgis.com

**Used for:** `Addresses` (address points → building `addr`) and `ZoningDistricts` (height defaults) from the city's ArcGIS Hub feature services at `services1.arcgis.com/k3vhq11XkBNeeOfM`. The Esri basemap tiles are not used.

## Mapillary

- **What we use it for:** Street-level imagery for machine extraction and visual reference.
- **License:** CC BY-SA 4.0
- **Required attribution:** Mapillary contributors
- **URL:** https://www.mapillary.com

## three.js

- **What we use it for:** JavaScript 3D rendering library.
- **License:** MIT
- **Required attribution:** three.js contributors
- **URL:** https://threejs.org

## Reference Only (No Derived Data)

The following sources are used solely as visual reference for hand-modeling landmarks. Their terms of service forbid deriving datasets from their imagery, so no automated extraction occurs from these sources:

- **Google Photorealistic 3D Tiles and Street View:** Visual reference for landmark modeling and facade colors. Terms prohibit derived datasets.
- **Mapbox Satellite:** Visual reference. Terms prohibit derived datasets.

**Used for:** the Virginia building-footprint layer (`Richmond_Building_Footprints.shp`, jurisdiction-sourced, updated 2026-02) as a gap-fill footprint source behind OSM and Overture (`pipeline/fetch_vgin_footprints.py`). Its height and storey attributes are empty; heights come from LiDAR and zoning.
