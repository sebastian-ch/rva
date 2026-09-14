from __future__ import annotations

from dataclasses import dataclass

import requests

import fetch_naip


@dataclass
class Response:
    content: bytes = b""
    payload: dict | None = None
    error: Exception | None = None

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return self.payload


def test_export_generates_a_url_then_downloads_the_tiff(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        if url == "service":
            return Response(payload={"href": "generated.tif"})
        return Response(content=b"II-tiff")

    monkeypatch.setattr(fetch_naip.requests, "get", get)
    assert fetch_naip._export("service", (1, 2, 3, 4), (100, 200)) == b"II-tiff"
    assert calls[0][1]["params"]["f"] == "json"
    assert calls[1][0] == "generated.tif"


def test_export_retries_a_failed_generation(monkeypatch):
    responses = iter([
        Response(error=requests.HTTPError("temporary")),
        Response(payload={"href": "generated.tif"}),
        Response(content=b"MM-tiff"),
    ])
    monkeypatch.setattr(fetch_naip.requests, "get", lambda *args, **kwargs: next(responses))
    monkeypatch.setattr(fetch_naip.time, "sleep", lambda _: None)
    assert fetch_naip._export("service", (1, 2, 3, 4), (100, 200)) == b"MM-tiff"
