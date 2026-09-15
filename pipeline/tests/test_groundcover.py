import geopandas as gpd
import numpy as np
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon, box

from groundcover import classify_arrays, polygonize


def test_classifies_low_lawn_paving_and_bare_but_not_canopy():
    naip = np.zeros((4, 8, 12), np.uint8)
    rgb = np.zeros((3, 8, 12), np.uint8)
    ndsm = np.zeros((8, 12), np.float32)
    # Four broad vertical regions: healthy lawn, grey paving, brown soil, elevated vegetation.
    naip[:, :, :3] = np.array([[[50]], [[90]], [[40]], [[180]]], np.uint8)
    rgb[:, :, :3] = np.array([[[70]], [[105]], [[55]]], np.uint8)
    naip[:, :, 3:6] = np.array([[[100]], [[100]], [[100]], [[90]]], np.uint8)
    rgb[:, :, 3:6] = 125
    naip[:, :, 6:9] = np.array([[[115]], [[85]], [[55]], [[95]]], np.uint8)
    rgb[:, :, 6:9] = np.array([[[150]], [[105]], [[70]]], np.uint8)
    naip[:, :, 9:] = np.array([[[50]], [[90]], [[40]], [[180]]], np.uint8)
    rgb[:, :, 9:] = np.array([[[70]], [[105]], [[55]]], np.uint8)
    ndsm[:, 9:] = 8

    out = classify_arrays(naip, rgb, ndsm)

    assert set(np.unique(out[2:-2, 1:3])) == {1}
    assert set(np.unique(out[2:-2, 4:6])) == {2}
    assert set(np.unique(out[2:-2, 7:9])) == {3}
    assert set(np.unique(out[2:-2, 10:])) == {0}


def test_polygonize_drops_small_regions_and_honors_exclusion():
    classes = np.zeros((10, 12), np.uint8)
    classes[:, :5] = 1
    classes[:, 6:] = 2
    classes[0, 11] = 3
    exclusion = np.zeros_like(classes, bool)
    exclusion[:, :2] = True

    result = polygonize(classes, from_origin(0, 30, 3, 3), exclusion)

    assert set(result.kind) == {"groundcover_lawn", "groundcover_paved"}
    lawn = result[result.kind == "groundcover_lawn"].geometry.area.sum()
    assert lawn == 270


def test_polygonize_subtracts_source_resolution_vectors_after_raster_classification():
    classes = np.ones((20, 20), np.uint8)
    building = Polygon([(12.2, 12.7), (31.4, 16.1), (28.8, 31.6), (9.5, 28.2)])

    result = polygonize(classes, from_origin(0, 60, 3, 3), vector_exclusion=[building])

    cover = result.geometry.union_all()
    assert cover.intersection(building).area < 1e-6
    # The cut follows the rotated source footprint, rather than 3 m raster steps.
    assert max(Point(xy).distance(cover.boundary) for xy in building.exterior.coords) < 1e-6


def test_polygonize_reapplies_minimum_area_to_fragments_after_vector_subtraction():
    classes = np.full((20, 20), 2, np.uint8)
    exclusion = box(55, 0, 59, 60)

    result = polygonize(classes, from_origin(0, 60, 3, 3), vector_exclusion=[exclusion])

    parts = [part for geom in result.geometry for part in getattr(geom, "geoms", [geom])]
    assert all(part.area >= 120 for part in parts)
    assert not result.geometry.union_all().covers(Point(59.5, 30))


def test_polygonize_supports_class_specific_vector_exclusions():
    classes = np.full((20, 20), 2, np.uint8)
    building_apron = box(20, 20, 40, 40)

    result = polygonize(classes, from_origin(0, 60, 3, 3),
                        kind_vector_exclusion={"groundcover_paved": [building_apron]})

    assert result.geometry.union_all().intersection(building_apron).area == 0
