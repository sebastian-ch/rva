"""Download Overture Maps building footprints for the bbox (second height source).

    python pipeline/fetch_overture.py [--bbox W S E N] [--force]

Output: data/raw/overture_<slug>.parquet (GeoParquet, EPSG:4326). Uses the `overturemaps` CLI.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from config import DATA_RAW, DEFAULT_BBOX, bbox_slug


def overture_path(bbox) -> Path:
    return DATA_RAW / f"overture_{bbox_slug(bbox)}.parquet"


def fetch_overture(bbox, force: bool = False) -> Path:
    dst = overture_path(bbox)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and not force:
        print(f"  [skip] {dst.name} exists")
        return dst
    env = dict(os.environ)
    if "SSL_CERT_FILE" not in env:  # python.org builds lack system CA certs for urllib
        try:
            import certifi
            env["SSL_CERT_FILE"] = certifi.where()
        except ImportError:
            pass
    exe = Path(sys.executable).with_name("overturemaps")
    cmd = [str(exe) if exe.exists() else "overturemaps", "download", f"--bbox={','.join(f'{c:.6f}' for c in bbox)}",
           "-f", "geoparquet", "--type=building", "-o", str(dst)]
    print("  " + " ".join(cmd))
    subprocess.run(cmd, check=True, env=env)
    print(f"  wrote {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")
    return dst


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"), default=DEFAULT_BBOX)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    fetch_overture(tuple(a.bbox), force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
