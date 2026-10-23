"""Guards for the phone fixes on the client pages. The behaviour itself was
checked in a phone-sized browser; these catch someone removing it.

Run with:  venv/bin/pytest tests/
"""
import os

STATIC = os.path.join(os.path.dirname(__file__), "..", "app", "static")


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


def test_client_page_reacts_to_touch_selection():
    # Phones never send a mouse-up after long-press selection.
    js = _read("share.js")
    assert 'addEventListener("selectionchange"' in js
    assert "processSelection" in js


def test_touch_screens_get_fingertip_sized_buttons():
    css = _read("styles.css")
    assert "@media (pointer: coarse)" in css
    assert "min-height: 44px" in css
