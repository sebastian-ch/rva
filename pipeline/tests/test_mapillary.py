import geopandas as gpd
from shapely.geometry import LineString, Point, box

import fetch_mapillary
from mapillary import detection_pois, kind_of, merge_detections
from poi_table import encode_pois

CRS = "EPSG:32618"


def _raw(rows):
    """rows: (id, value, last_seen, x, y)"""
    return gpd.GeoDataFrame({"id": [r[0] for r in rows], "value": [r[1] for r in rows],
                             "first_seen": [None] * len(rows), "last_seen": [r[2] for r in rows]},
                            geometry=[Point(r[3], r[4]) for r in rows], crs=CRS)


def _pois(rows):
    return gpd.GeoDataFrame({"id": [r[0] for r in rows], "name": [None] * len(rows), "kind": [r[1] for r in rows]},
                            geometry=[Point(r[2], r[3]) for r in rows], crs=CRS)


ROADS = gpd.GeoDataFrame({"id": ["r1"], "highway": ["residential"], "width": [8.0], "tunnel": [False]},
                         geometry=[LineString([(0, 0), (400, 0)])], crs=CRS)
BUILDINGS = gpd.GeoDataFrame({"id": ["b1"], "hidden": [False]}, geometry=[box(300, 20, 320, 40)], crs=CRS)


def test_kind_of_maps_hydrants_benches_and_sign_classes():
    assert kind_of("object--fire-hydrant") == "hydrant"
    assert kind_of("object--bench") == "bench"
    assert kind_of("regulatory--stop--g1") == "stop_sign"
    assert kind_of("regulatory--no-parking--g2") == "street_sign"
    assert kind_of("information--parking--g1") == "street_sign"
    assert kind_of("warning--pedestrians-crossing--g4") == "warning_sign"
    assert kind_of("complementary--chevron-left--g1") is None      # a plate under another sign
    assert kind_of("object--manhole") is None
    assert kind_of("other-sign") is None


def test_detections_drop_stale_features_and_collapse_duplicates_to_the_newest():
    out = detection_pois(_raw([
        (1, "object--fire-hydrant", "2019-05-01", 10, 10),
        (2, "object--fire-hydrant", "2023-05-01", 11, 10),    # same hydrant, seen later: wins
        (3, "object--fire-hydrant", "2014-01-01", 50, 50),    # not seen since 2014
        (4, "warning--curve-left--g1", None, 11, 10),         # different kind at the same spot stays
        (5, "object--manhole", "2023-01-01", 70, 70),
    ])).set_index("id")
    assert sorted(out.index) == ["mly:2", "mly:4"]
    assert out.loc["mly:4", "kind"] == "warning_sign"
    assert set(out["source"]) == {"mapillary"}
    assert out["heading"].isna().all()


def test_merge_keeps_osm_benches_and_inferred_stops_and_clears_the_road():
    pois = _pois([("osm:node/1", "bench", 100, 20), ("inferred:1", "stop_sign", 200, 6)])
    raw = _raw([
        (1, "object--bench", "2022-01-01", 103, 20),           # OSM has it
        (2, "object--bench", "2022-01-01", 150, 20),           # OSM does not
        (3, "regulatory--stop--g1", "2022-01-01", 215, 6),      # covered by the inferred sign
        (4, "regulatory--stop--g1", "2022-01-01", 380, 6),      # no inferred sign near: drawn
        (5, "object--fire-hydrant", "2022-01-01", 60, 2),       # on the asphalt: pushed to the curb
        (6, "regulatory--one-way-left--g1", "2022-01-01", 90, 0),  # centreline: too far in, dropped
        (7, "object--fire-hydrant", "2022-01-01", 310, 30),     # inside a building
    ])
    out = merge_detections(pois, raw, ROADS, BUILDINGS)
    added = out[out["source"] == "mapillary"].set_index("id")
    assert sorted(added.index) == ["mly:2", "mly:4", "mly:5"]
    hydrant = added.loc["mly:5"].geometry
    assert hydrant.x == 60 and abs(hydrant.y - 4.6) < 1e-6
    assert len(out) == len(pois) + 3
    encode_pois(out, (0, -50, 400, 50))   # every new kind has a code in the POI table


def test_merge_without_matches_returns_the_input():
    pois = _pois([("osm:node/1", "bench", 100, 20)])
    assert merge_detections(pois, _raw([(1, "object--manhole", "2022-01-01", 5, 5)]), ROADS, BUILDINGS) is pois


class _Session:
    def __init__(self, respond):
        self.respond, self.calls = respond, []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return _Response(self.respond(url, params))


class _Response:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


def _feature(i, x, y, seen=1_650_000_000_000):
    return {"id": str(i), "object_value": "object--fire-hydrant", "last_seen_at": seen, "first_seen_at": seen,
            "geometry": {"type": "Point", "coordinates": [x, y]}}


def test_fetch_splits_full_cells_follows_paging_and_dedupes_edge_features(monkeypatch):
    monkeypatch.setattr(fetch_mapillary, "FULL_AT", 3)
    monkeypatch.setattr(fetch_mapillary, "CELL_DEG", 0.01)

    def respond(url, params):
        if url == "next-page":
            return {"data": [_feature(99, -77.4, 37.5)]}
        w, s, e, n = map(float, params["bbox"].split(","))
        if e - w > 0.006:                       # the big cell comes back full
            return {"data": [_feature(i, w, s) for i in range(3)]}
        if w == -77.49:
            return {"data": [_feature("edge", -77.485, 37.5)], "paging": {"next": "next-page"}}
        return {"data": [_feature("edge", -77.485, 37.5)]}

    session = _Session(respond)
    rows = fetch_mapillary.fetch_features(session, (-77.49, 37.50, -77.48, 37.51))
    assert sorted(r["id"] for r in rows) == ["99", "edge"]
    assert len([c for c in session.calls if c[0] == fetch_mapillary.URL]) == 5   # one cell, then its quarters
    frame = fetch_mapillary.to_frame(rows)
    assert frame.crs == "EPSG:4326" and set(frame["last_seen"]) == {"2022-04-15"}


def test_grid_covers_the_bbox_without_overshooting():
    cells = fetch_mapillary.grid((0.0, 0.0, 0.025, 0.01), 0.01)
    assert len(cells) == 3 and cells[-1][2] == 0.025
