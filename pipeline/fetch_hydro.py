"""Cache the official NOAA 2025 Richmond hydro breakline GeoPackage."""
from config import DATA_RAW, REGION
from fetch_richmond import _session
from hydro import BREAKLINES_URL


def main():
    if REGION != "richmond":
        raise SystemExit("Richmond hydro data cannot be used for another region")
    dst = DATA_RAW / "richmond_hydro_2025.gpkg"
    if dst.exists():
        print(f"[skip] {dst}")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    r = _session().get(BREAKLINES_URL, timeout=120)
    r.raise_for_status()
    tmp = dst.with_suffix(".download")
    tmp.write_bytes(r.content)
    tmp.replace(dst)
    print(f"Downloaded {len(r.content) / 1e6:.1f} MB -> {dst}")


if __name__ == "__main__":
    main()
