"""
Encrypted storage for the photos a signer can be asked for before signing:
a selfie and, optionally, a photo of their ID.

Why a module of its own: an ID photo is one of the most sensitive things
Rotely ever holds, so everything about how it is written and read lives in
one small place that is easy to audit and to test without a database.

  * Images are checked, not trusted. The "data:image/..." header the browser
    sends is ignored; the bytes themselves must start like a JPEG or PNG.
    Anything else (a PDF, a script, junk) is refused.
  * Images are encrypted (Fernet: AES-128-CBC + HMAC-SHA256) before they are
    written to disk, so a copy of the disk or a backup alone is not enough
    to read them.
  * The key comes from PHOTO_ENCRYPTION_KEY if set (a Fernet key), otherwise
    it is derived from the app's session secret with a label, so it works
    with no extra setup. Changing that secret later makes older encrypted
    photos unreadable, which is why a dedicated PHOTO_ENCRYPTION_KEY is the
    better long-term choice.
  * Files written here end in ".enc". Selfies saved before this module
    existed are plain .jpg/.png files; read_image() serves those unchanged
    so nothing already stored is lost.
"""
import base64
import binascii
import hashlib
import os
from typing import Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken

ENC_SUFFIX = ".enc"
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # same ceiling the selfie step always had


class PhotoError(ValueError):
    """A photo the signer sent couldn't be accepted. The message is safe to
    show to them."""


def _fernet(secret: str) -> Fernet:
    configured = os.environ.get("PHOTO_ENCRYPTION_KEY", "").strip()
    if configured:
        return Fernet(configured.encode("ascii"))
    digest = hashlib.sha256(b"rotely-photo-v1:" + secret.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def sniff_mime(data: bytes) -> str:
    """'image/jpeg' or 'image/png' judged from the bytes themselves, else ''."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return ""


def parse_data_url(data_url: str, max_bytes: Optional[int] = None) -> Tuple[bytes, str]:
    """Turns "data:image/jpeg;base64,...." into (bytes, mime). Raises
    PhotoError for anything that isn't a real, reasonably small JPEG/PNG."""
    if not data_url or "," not in data_url:
        raise PhotoError("A photo is required before continuing.")
    _, _, b64data = data_url.partition(",")
    try:
        raw = base64.b64decode(b64data, validate=True)
    except (binascii.Error, ValueError):
        raise PhotoError("That photo couldn't be read. Try again.")
    if not raw:
        raise PhotoError("That photo couldn't be read. Try again.")
    if len(raw) > (max_bytes or MAX_IMAGE_BYTES):
        raise PhotoError("That photo is too large.")
    mime = sniff_mime(raw)
    if not mime:
        raise PhotoError("That photo couldn't be read. Try again.")
    return raw, mime


def save_image(path_without_suffix: str, data: bytes, secret: str) -> str:
    """Encrypts `data` and writes it to `<path_without_suffix>.enc`.
    Returns the full path written."""
    path = path_without_suffix + ENC_SUFFIX
    os.makedirs(os.path.dirname(path), exist_ok=True)
    token = _fernet(secret).encrypt(data)
    with open(path, "wb") as f:
        f.write(token)
    return path


def read_image(path: str, secret: str) -> Tuple[bytes, str]:
    """(bytes, mime) for a stored photo, decrypting if it was written by
    save_image(); a legacy plain file is returned as-is. Raises
    FileNotFoundError if it is gone, PhotoError if it can't be decrypted."""
    with open(path, "rb") as f:
        stored = f.read()
    if path.endswith(ENC_SUFFIX):
        try:
            data = _fernet(secret).decrypt(stored)
        except (InvalidToken, ValueError):
            raise PhotoError("This photo can't be decrypted.")
    else:
        data = stored
    return data, sniff_mime(data) or "application/octet-stream"
