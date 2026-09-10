import json
import tiles_inspect


def test_inspection_ignores_unlisted_tiles_and_layers(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles_inspect, 'DATA_TILES', tmp_path)
    (tmp_path / 'index.json').write_text(json.dumps({'tiles': [
        {'id': '0_0', 'layers': ['buildings']}, {'id': '1_0', 'layers': ['terrain']},
    ]}))
    for tid in ['0_0', '1_0', 'stale']:
        folder = tmp_path / tid
        folder.mkdir()
        (folder / 'buildings.geojson').write_text(json.dumps({'features': [{'id': tid}]}))
    assert list(tiles_inspect._iter_features('buildings')) == [('0_0', {'id': '0_0'})]
