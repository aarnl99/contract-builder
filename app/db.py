import os
from sqlmodel import SQLModel, create_engine, Session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# On Render, DATA_DIR points at a mounted persistent disk (see render.yaml)
# so the database and uploaded/generated documents survive deploys and
# restarts. Falls back to a folder next to this file for local development,
# where there's no separate disk to mount.
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "data.db")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def init_db():
    from . import models  # noqa: F401  (ensure models are registered)
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
