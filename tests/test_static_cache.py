"""Front-end files must be re-checked by the browser on every load: a stale
cached sign.js once showed a signer a camera prompt after the sender had
chosen no photo check.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

if "app.db" not in sys.modules:
    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="rotely_test_static_cache_")

from fastapi.testclient import TestClient  # noqa: E402

from app import main as m  # noqa: E402
from app.db import init_db  # noqa: E402

init_db()


@pytest.mark.parametrize("path", ["/sign.js", "/app.js", "/share.js", "/styles.css", "/sign/abc123"])
def test_front_end_files_are_revalidated_on_every_load(path):
    r = TestClient(m.app).get(path)
    assert r.status_code == 200, path
    assert r.headers["cache-control"] == "no-cache", path
