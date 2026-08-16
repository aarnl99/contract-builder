"""Redline auto-approval: given a placeholder's threshold rule and a
client's proposed new value for that field, decide whether it can be
auto-approved or needs a human to look at it.

Deliberately conservative: anything that doesn't unambiguously match the
rule (unparseable numbers, no rule set, an explicitly "locked" field) comes
back needs_review. Auto-approval only ever happens when the proposed value
clearly satisfies a rule the account owner set themselves.
"""
import json
import re
from typing import Optional

THRESHOLD_TYPES = ["none", "numeric_range", "approved_list", "locked"]

AUTO_APPROVED = "auto_approved"
NEEDS_REVIEW = "needs_review"

_NUMERIC_RE = re.compile(r"-?\d+(\.\d+)?")


def _extract_number(value: str) -> Optional[float]:
    """Pull the first number out of a free-form value like "$45,000" or
    "Net 45 days". Returns None if nothing numeric is found."""
    if value is None:
        return None
    cleaned = value.replace(",", "")
    m = _NUMERIC_RE.search(cleaned)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def validate_threshold_config(threshold_type: str, config: dict) -> dict:
    """Normalize/validate a threshold config for storage. Raises ValueError
    on a config that doesn't make sense for its type."""
    if threshold_type not in THRESHOLD_TYPES:
        raise ValueError(f"Unknown threshold type: {threshold_type}")
    if threshold_type == "numeric_range":
        lo = config.get("min")
        hi = config.get("max")
        if lo is None and hi is None:
            raise ValueError("Numeric range needs at least a minimum or a maximum.")
        if lo is not None and hi is not None and float(lo) > float(hi):
            raise ValueError("Minimum can't be greater than maximum.")
        return {"min": (float(lo) if lo is not None else None), "max": (float(hi) if hi is not None else None)}
    if threshold_type == "approved_list":
        allowed = [a.strip() for a in config.get("allowed", []) if a and a.strip()]
        if not allowed:
            raise ValueError("Add at least one approved value.")
        return {"allowed": allowed}
    return {}


def evaluate_edit(threshold_type: str, threshold_config_json: str, proposed_value: str) -> str:
    """Return AUTO_APPROVED or NEEDS_REVIEW for a proposed field value
    against the field's stored threshold rule."""
    proposed_value = (proposed_value or "").strip()
    if not proposed_value:
        return NEEDS_REVIEW

    if threshold_type == "numeric_range":
        try:
            config = json.loads(threshold_config_json or "{}")
        except (TypeError, ValueError):
            return NEEDS_REVIEW
        num = _extract_number(proposed_value)
        if num is None:
            return NEEDS_REVIEW
        lo, hi = config.get("min"), config.get("max")
        if lo is not None and num < lo:
            return NEEDS_REVIEW
        if hi is not None and num > hi:
            return NEEDS_REVIEW
        return AUTO_APPROVED

    if threshold_type == "approved_list":
        try:
            config = json.loads(threshold_config_json or "{}")
        except (TypeError, ValueError):
            return NEEDS_REVIEW
        allowed = {a.strip().lower() for a in config.get("allowed", [])}
        return AUTO_APPROVED if proposed_value.strip().lower() in allowed else NEEDS_REVIEW

    # "none" and "locked" both always need a human, by design.
    return NEEDS_REVIEW


def describe_threshold(threshold_type: str, threshold_config_json: str) -> Optional[str]:
    """Plain-language description of a field's threshold rule, for showing
    to the account owner alongside a proposed edit (e.g. "1,000-5,000" or
    "one of: Delaware, New York"). Returns None when there's no real rule to
    describe ("none" -- nothing set yet)."""
    if threshold_type == "none":
        return None
    if threshold_type == "locked":
        return "always needs your review"
    try:
        config = json.loads(threshold_config_json or "{}")
    except (TypeError, ValueError):
        return None
    if threshold_type == "numeric_range":
        lo, hi = config.get("min"), config.get("max")

        def fmt(n):
            return str(int(n)) if float(n).is_integer() else str(n)

        if lo is not None and hi is not None:
            return f"{fmt(lo)}–{fmt(hi)}"
        if lo is not None:
            return f"at least {fmt(lo)}"
        if hi is not None:
            return f"at most {fmt(hi)}"
        return None
    if threshold_type == "approved_list":
        allowed = config.get("allowed", [])
        if not allowed:
            return None
        return "one of: " + ", ".join(allowed)
    return None
