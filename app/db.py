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


def _run_light_migrations():
    """SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and
    SQLModel.metadata.create_all() only creates missing TABLES -- it never
    adds a missing COLUMN to a table that already exists in the live
    database. Any new Optional/defaulted field added to an existing model
    (e.g. GeneratedContract.source_generated_id, User.is_suspended) would
    otherwise make every query touching that table start throwing
    "no such column" the moment the new code deploys, since production's
    on-disk schema is frozen at whatever it was when the table was first
    created. This walks every mapped table/column and adds whatever the
    live schema is missing, so a plain deploy is always enough on its own
    -- no manual migration step, ever. Safe to run on every startup: it
    only touches columns that don't already exist.
    """
    with engine.connect() as conn:
        # .tables.values() (not sorted_tables) -- we're only diffing existing
        # columns, not creating tables, so no FK ordering is needed, and this
        # sidesteps SQLAlchemy's cyclic-FK sort warning between the
        # generatedcontract/redlinesubmission/sharelink tables.
        for table in SQLModel.metadata.tables.values():
            existing_cols = {
                row[1] for row in conn.exec_driver_sql(f'PRAGMA table_info("{table.name}")').fetchall()
            }
            if not existing_cols:
                continue  # brand-new table -- create_all() already made it in full
            for column in table.columns:
                if column.name in existing_cols:
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                default_sql = ""
                default = column.default
                if default is not None and getattr(default, "is_scalar", False):
                    val = default.arg
                    if isinstance(val, bool):
                        default_sql = f" DEFAULT {1 if val else 0}"
                    elif isinstance(val, (int, float)):
                        default_sql = f" DEFAULT {val}"
                    elif isinstance(val, str):
                        default_sql = " DEFAULT " + "'" + val.replace("'", "''") + "'"
                elif not column.nullable:
                    default_sql = " DEFAULT ''"
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}{default_sql}'
                )
        conn.commit()


def init_db():
    from . import models  # noqa: F401  (ensure models are registered)
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    SQLModel.metadata.create_all(engine)
    _run_light_migrations()


def get_session():
    with Session(engine) as session:
        yield session
