"""Monthly cap on AI suggestions, per account.

Rotely pays for the model calls, so every account gets a fixed number of AI
suggestions per calendar month (UTC). The counter is shared by every feature
that asks Claude for something on the owner's behalf (redline counter
suggestions now; drafting from a client email later). The scheduled-job
suggestion of a contract's end date is not counted: it happens on its own
once per signed document.
"""
from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from .models import AiUsage

MONTHLY_LIMIT = 50


def month_key(now: Optional[datetime] = None) -> str:
    return (now or datetime.utcnow()).strftime("%Y-%m")


def _row(session: Session, user_id: int, month: str) -> Optional[AiUsage]:
    return session.exec(select(AiUsage).where(AiUsage.user_id == user_id, AiUsage.month == month)).first()


def used(session: Session, user_id: int, now: Optional[datetime] = None) -> int:
    row = _row(session, user_id, month_key(now))
    return row.count if row else 0


def status(session: Session, user_id: int, now: Optional[datetime] = None) -> dict:
    n = used(session, user_id, now)
    return {"used": n, "limit": MONTHLY_LIMIT, "remaining": max(0, MONTHLY_LIMIT - n), "month": month_key(now)}


def reserve(session: Session, user_id: int, now: Optional[datetime] = None) -> bool:
    """Takes one suggestion from the month's allowance. False (and nothing
    is taken) when the allowance is used up."""
    month = month_key(now)
    row = _row(session, user_id, month)
    if row is None:
        row = AiUsage(user_id=user_id, month=month, count=0)
    if row.count >= MONTHLY_LIMIT:
        return False
    row.count += 1
    session.add(row)
    session.commit()
    return True


def refund(session: Session, user_id: int, now: Optional[datetime] = None) -> None:
    """Gives a suggestion back when the model call failed, so an outage on
    our side never costs the owner anything."""
    row = _row(session, user_id, month_key(now))
    if row and row.count > 0:
        row.count -= 1
        session.add(row)
        session.commit()


LIMIT_MESSAGE = (
    "You've used all {limit} AI suggestions for this month. The count starts over on the 1st. "
    "You can still write your own counter."
)
