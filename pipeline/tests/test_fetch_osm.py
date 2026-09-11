import pytest
import fetch


def test_bbox_query_unions_tags_before_single_geometry_expansion():
    query = fetch.osm_bbox_query((-77.486, 37.517, -77.418, 37.568), {
        "building": True, "landuse": ["grass", "forest"], "name": 'A "quoted" park',
    })
    assert query.count('(._;>;);') == 1
    assert query.count('nwr[') == 4
    assert 'nwr["building"](37.517000,-77.486000,37.568000,-77.418000);' in query
    assert '["landuse"="grass"]' in query and '["landuse"="forest"]' in query
    assert '["name"="A \\"quoted\\" park"]' in query


def test_partial_overpass_response_is_not_cached_as_empty_layer(monkeypatch, tmp_path):
    monkeypatch.setattr(fetch.ox._overpass, '_overpass_request', lambda _: {
        "remark": "runtime error: Query timed out", "elements": [],
    })
    with pytest.raises(RuntimeError, match='incomplete result'):
        fetch.fetch_osm((-77.486, 37.517, -77.418, 37.568), tmp_path)
    assert not list(tmp_path.glob('*.parquet'))


def test_malformed_response_is_not_saved_as_empty_layer(monkeypatch, tmp_path):
    def malformed(_):
        raise fetch.ox._errors.InsufficientResponseError('Invalid response')
    monkeypatch.setattr(fetch.ox._overpass, '_overpass_request', malformed)
    with pytest.raises(fetch.ox._errors.InsufficientResponseError):
        fetch.fetch_osm((-77.486, 37.517, -77.418, 37.568), tmp_path)
    assert not list(tmp_path.glob('*.parquet'))
