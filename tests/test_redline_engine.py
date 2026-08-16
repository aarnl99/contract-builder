"""Unit tests for redline auto-approval evaluation.

Run with:  venv/bin/pytest tests/
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from app import redline_engine as rl


def test_no_rule_always_needs_review():
    assert rl.evaluate_edit("none", "{}", "anything") == rl.NEEDS_REVIEW


def test_locked_always_needs_review_even_with_config():
    assert rl.evaluate_edit("locked", "{}", "anything") == rl.NEEDS_REVIEW


def test_numeric_range_inside_bounds_auto_approves():
    config = json.dumps({"min": 30, "max": 45})
    assert rl.evaluate_edit("numeric_range", config, "35") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("numeric_range", config, "30") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("numeric_range", config, "45") == rl.AUTO_APPROVED


def test_numeric_range_outside_bounds_needs_review():
    config = json.dumps({"min": 30, "max": 45})
    assert rl.evaluate_edit("numeric_range", config, "29") == rl.NEEDS_REVIEW
    assert rl.evaluate_edit("numeric_range", config, "46") == rl.NEEDS_REVIEW
    assert rl.evaluate_edit("numeric_range", config, "1000") == rl.NEEDS_REVIEW


def test_numeric_range_extracts_number_from_free_text():
    config = json.dumps({"min": 30, "max": 45})
    assert rl.evaluate_edit("numeric_range", config, "Net 40 days") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("numeric_range", config, "$45,000") == rl.NEEDS_REVIEW  # 45000 > 45


def test_numeric_range_open_ended_bounds():
    min_only = json.dumps({"min": 30, "max": None})
    assert rl.evaluate_edit("numeric_range", min_only, "1000000") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("numeric_range", min_only, "29") == rl.NEEDS_REVIEW

    max_only = json.dumps({"min": None, "max": 45})
    assert rl.evaluate_edit("numeric_range", max_only, "0") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("numeric_range", max_only, "46") == rl.NEEDS_REVIEW


def test_numeric_range_unparseable_value_needs_review():
    config = json.dumps({"min": 30, "max": 45})
    assert rl.evaluate_edit("numeric_range", config, "not a number at all") == rl.NEEDS_REVIEW


def test_approved_list_case_insensitive_match():
    config = json.dumps({"allowed": ["Delaware", "New York"]})
    assert rl.evaluate_edit("approved_list", config, "Delaware") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("approved_list", config, "delaware") == rl.AUTO_APPROVED
    assert rl.evaluate_edit("approved_list", config, "  New York  ") == rl.AUTO_APPROVED


def test_approved_list_rejects_anything_not_listed():
    config = json.dumps({"allowed": ["Delaware", "New York"]})
    assert rl.evaluate_edit("approved_list", config, "California") == rl.NEEDS_REVIEW


def test_empty_proposed_value_always_needs_review():
    config = json.dumps({"allowed": ["Delaware"]})
    assert rl.evaluate_edit("approved_list", config, "   ") == rl.NEEDS_REVIEW


def test_validate_threshold_config_numeric_range():
    normalized = rl.validate_threshold_config("numeric_range", {"min": "30", "max": "45"})
    assert normalized == {"min": 30.0, "max": 45.0}


def test_validate_threshold_config_numeric_range_requires_a_bound():
    with pytest.raises(ValueError):
        rl.validate_threshold_config("numeric_range", {})


def test_validate_threshold_config_numeric_range_rejects_backwards_bounds():
    with pytest.raises(ValueError):
        rl.validate_threshold_config("numeric_range", {"min": 50, "max": 10})


def test_validate_threshold_config_approved_list_requires_a_value():
    with pytest.raises(ValueError):
        rl.validate_threshold_config("approved_list", {"allowed": []})


def test_validate_threshold_config_approved_list_strips_blanks():
    normalized = rl.validate_threshold_config("approved_list", {"allowed": ["Delaware", "  ", "", "New York"]})
    assert normalized == {"allowed": ["Delaware", "New York"]}


def test_validate_threshold_config_unknown_type_rejected():
    with pytest.raises(ValueError):
        rl.validate_threshold_config("not-a-real-type", {})
