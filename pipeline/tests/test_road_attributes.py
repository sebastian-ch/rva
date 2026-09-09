import pandas as pd
from process import _sidewalk_side


def test_separate_sidewalk_is_not_generated_twice():
    row = pd.Series({"sidewalk:left": "no", "sidewalk:right": "separate"})
    assert _sidewalk_side(row, "left") is False
    assert _sidewalk_side(row, "right") is False


def test_sidewalk_side_precedence_and_unknown():
    row = pd.Series({"sidewalk": "both", "sidewalk:left": "no"})
    assert _sidewalk_side(row, "left") is False
    assert _sidewalk_side(row, "right") is True
    assert _sidewalk_side(pd.Series(dtype=object), "right") is None
