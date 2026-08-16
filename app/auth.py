import re
from typing import Optional

from fastapi import Request, HTTPException, Depends
from sqlmodel import Session, select
from passlib.context import CryptContext

from .db import get_session
from .models import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def validate_password_strength(password: str) -> Optional[str]:
    """Returns a human-readable error message if the password is too weak,
    or None if it passes. Kept as one place both register (and, later, any
    password-change flow) can call so the rule stays consistent."""
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[a-z]", password):
        return "Password must include at least one lowercase letter."
    if not re.search(r"[A-Z]", password):
        return "Password must include at least one uppercase letter."
    if not re.search(r"[0-9]", password):
        return "Password must include at least one number."
    return None


def get_current_user(request: Request, session: Session = Depends(get_session)) -> User:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.is_suspended:
        # Checked here (not just at login) so an admin suspending someone
        # mid-session kicks them out on their very next request, rather than
        # waiting for their cookie session to expire on its own.
        request.session.clear()
        raise HTTPException(status_code=403, detail={"code": "account_suspended", "message": "This account has been suspended."})
    return user


def get_optional_user(request: Request, session: Session = Depends(get_session)):
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    user = session.get(User, user_id)
    if user and user.is_suspended:
        request.session.clear()
        return None
    return user
