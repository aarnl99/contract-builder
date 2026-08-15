"""Database models for the contract template tool."""
from datetime import datetime
from typing import Optional, List

from sqlmodel import SQLModel, Field, Relationship

# Plan tiers and their monthly generated-contract caps. None = unlimited.
# This mirrors the pricing tiers ($9.99 / $19.99 / $49.99) discussed for the
# product -- no real billing is wired up yet, this just enforces the caps so
# the mechanics are real ahead of adding a payment processor.
PLAN_LIMITS = {
    "starter": 5,
    "pro": 20,
    "unlimited": None,
}
DEFAULT_PLAN = "starter"

# Suggested document types shown on upload. Users can also type a custom one.
DOCUMENT_TYPES = [
    "NDA",
    "Services Agreement",
    "Consulting Agreement",
    "Employment Agreement",
    "Lease Agreement",
    "Sales Contract",
    "Other",
]


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    password_hash: str
    name: str = ""
    plan: str = DEFAULT_PLAN  # "starter" | "pro" | "unlimited"
    created_at: datetime = Field(default_factory=datetime.utcnow)

    templates: List["Template"] = Relationship(back_populates="owner")
    generated_contracts: List["GeneratedContract"] = Relationship(back_populates="owner")


class Template(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    name: str
    document_type: str = "Other"
    original_filename: str
    # Path to the *working* docx on disk. This copy accumulates {{token}}
    # placeholders as the user marks them, and is the source used both to
    # render the editor view and to generate finished contracts.
    working_path: str
    finalized: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    owner: Optional[User] = Relationship(back_populates="templates")
    placeholders: List["Placeholder"] = Relationship(
        back_populates="template",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "Placeholder.order"},
    )


class Placeholder(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    template_id: int = Field(foreign_key="template.id", index=True)
    field_key: str  # unique token key within the template, e.g. "client_name"
    label: str  # human readable label shown on the generate form, e.g. "Client Name"
    field_type: str = "text"  # text | date | number | multiline
    required: bool = True
    order: int = 0

    template: Optional[Template] = Relationship(back_populates="placeholders")


class GeneratedContract(SQLModel, table=True):
    """One finished, downloaded contract. Kept as its own row (not
    overwritten) so a user can see and re-download their generation history,
    and always trace an output back to the master document it came from."""

    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    template_id: Optional[int] = Field(default=None, foreign_key="template.id", index=True)
    # Snapshot of the source template's name/type at generation time, so
    # lineage and library grouping still work even if the master document is
    # later edited or deleted.
    template_name: str
    document_type: str = "Other"
    name: str  # display name for this generated contract
    file_path: str
    values_json: str  # JSON list of {label, field_key, value} used, for the detail view
    archived: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)

    owner: Optional[User] = Relationship(back_populates="generated_contracts")
