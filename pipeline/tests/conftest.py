"""Test bootstrap: pipeline/ modules import each other as top-level modules
(e.g. `from config import ...`), so put pipeline/ on sys.path for the tests.
"""
from __future__ import annotations

import sys
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))
