#!/usr/bin/env python3
"""Build canonical planning constraints from cached source-specific data."""
from __future__ import annotations

import argparse
from pathlib import Path

from config import DATA_RAW
from planning import RULE_FIELDS, build_manchester_constraints


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", default="Scenario 1")
    parser.add_argument("--raw-dir", type=Path, default=DATA_RAW / "manchester_test_2" / "urban_design_database")
    parser.add_argument("--output", type=Path, default=DATA_RAW / "canonical_planning_constraints.parquet")
    args = parser.parse_args()
    result = build_manchester_constraints(args.raw_dir, args.output, args.branch)
    populated = {field: int(result[field].notna().sum()) for field in RULE_FIELDS}
    print(f"wrote {len(result)} parcels to {args.output}")
    print("populated rules:", populated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
