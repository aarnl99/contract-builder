"""Tiny in-process sliding-window rate limiter for the auth endpoints.

Deliberately simple: one Render instance, so process memory is enough and
there's no new infrastructure to run. (If the app is ever scaled to several
instances, each keeps its own counters -- still a real brake on guessing,
just a looser one; swap the store for Redis then.)

Used for login failures and password-reset requests. Keys are things like
"login:email:<addr>" and "login:ip:<ip>" so one attacker can't dodge the
per-account limit by rotating IPs, nor lock out everyone by sharing one.
"""
import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Tuple

_lock = threading.Lock()
_events: Dict[str, Deque[float]] = defaultdict(deque)
_MAX_KEYS = 50_000  # hard cap so a flood of unique keys can't grow memory forever


def _prune(q: Deque[float], now: float, window: float) -> None:
    while q and now - q[0] >= window:
        q.popleft()


def retry_after(key: str, limit: int, window: float, now: float = None) -> int:
    """Seconds until `key` may act again if it's at/over `limit` events in the
    last `window` seconds, else 0. Does not record anything."""
    now = time.monotonic() if now is None else now
    with _lock:
        q = _events.get(key)
        if not q:
            return 0
        _prune(q, now, window)
        if len(q) < limit:
            return 0
        return max(1, int(window - (now - q[0])) + 1)


def record(key: str, window: float, now: float = None) -> None:
    now = time.monotonic() if now is None else now
    with _lock:
        if len(_events) >= _MAX_KEYS and key not in _events:
            # Evict keys whose events have all expired; if still full, drop oldest-inserted.
            for k in [k for k, q in _events.items() if not q or now - q[-1] >= window]:
                _events.pop(k, None)
            if len(_events) >= _MAX_KEYS:
                _events.pop(next(iter(_events)), None)
        q = _events[key]
        _prune(q, now, window)
        q.append(now)


def clear(key: str) -> None:
    with _lock:
        _events.pop(key, None)


def reset_all() -> None:  # for tests
    with _lock:
        _events.clear()


def check(rules: "list[Tuple[str, int, float]]", now: float = None) -> int:
    """rules: [(key, limit, window_seconds), ...]. Returns the longest
    retry-after across all rules (0 means allowed)."""
    return max((retry_after(k, lim, win, now) for k, lim, win in rules), default=0)
