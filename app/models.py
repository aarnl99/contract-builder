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
    field_type: str = "text"  # text | date | number | multiline | clause_preset
    required: bool = True
    order: int = 0

    # Only used when field_type == "clause_preset": named whole-paragraph
    # variants defined on this template (e.g. "Delaware" / "California"
    # versions of a governing-law clause), so drafting swaps in an entire
    # pre-written clause instead of a short value. JSON list of
    # {"name": <str>, "text": <str>}. Scoped to this one template for now,
    # not a shared library across templates.
    preset_options_json: str = "[]"

    # Redline auto-approval rule for this field. "none" (default) and
    # "locked" both always require manual review; they're kept as distinct
    # labels so the UI can show "no rule set" vs "deliberately always
    # flag" differently, even though they behave the same today.
    #   none            -- no rule set yet, always needs manual review
    #   numeric_range    -- threshold_config: {"min": <num|None>, "max": <num|None>}
    #   approved_list    -- threshold_config: {"allowed": ["Delaware", "New York"]}
    #   locked           -- always flagged for manual review, on purpose
    threshold_type: str = "none"
    threshold_config: str = "{}"  # JSON string, shape depends on threshold_type

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
    # Where each filled field landed in the document -- [{path, p, r,
    # field_key}, ...] from docx_engine.fill_template_tracked -- so the
    # share/redline page can highlight and edit each field inline, in
    # place in the document, instead of via a separate form below it.
    field_positions_json: str = "[]"
    # Who this contract is between, e.g. ["Rotely AI", "Swift Enterprises"],
    # entered on the draft form (party A defaults to the account's own
    # name). Shown on both the owner's side and the client's redline page.
    parties_json: str = "[]"
    archived: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # Set when this generated contract was produced by applying accepted
    # redlines from a client review round, so it's traceable back to the
    # submission that produced it (see RedlineSubmission below).
    source_submission_id: Optional[int] = Field(default=None, foreign_key="redlinesubmission.id")

    owner: Optional[User] = Relationship(back_populates="generated_contracts")


# ---------------------------------------------------------------------------
# Redlining: share a generated contract for review, with per-field
# auto-approval thresholds set by the account owner (see Placeholder above).
# ---------------------------------------------------------------------------

class ShareLink(SQLModel, table=True):
    """A reviewable link to one generated contract. The client opens this
    with no account of their own, enters the access code the sender gave
    them out of band, and can propose new values for the fields that were
    originally marked as placeholders."""

    id: Optional[int] = Field(default=None, primary_key=True)
    generated_contract_id: int = Field(foreign_key="generatedcontract.id", index=True)
    token: str = Field(index=True, unique=True)
    access_code: str  # short passcode the sender shares with the client out of band
    client_email: str = ""  # optional, set by the sender when creating the link -- shown to the client as "Editing as"
    status: str = "open"  # open | closed
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_viewed_at: Optional[datetime] = None


class RedlineSubmission(SQLModel, table=True):
    """One batch of proposed edits a client submitted through a share link."""

    id: Optional[int] = Field(default=None, primary_key=True)
    share_link_id: int = Field(foreign_key="sharelink.id", index=True)
    note: str = ""  # optional general comment from the client, not tied to a field
    submitted_at: datetime = Field(default_factory=datetime.utcnow)
    # draft   -- saved in progress via "Save progress", not yet sent to the owner;
    #            at most one draft submission exists per share link at a time.
    # pending -- finalized via "Finalize and submit", awaiting owner review.
    # reviewed -- the owner has processed it (applied accepted edits into a
    #             new draft; independent of whether a response was sent).
    status: str = "pending"  # draft | pending | reviewed

    # Set when the owner reviews every edit (accept/reject/counter) and hits
    # "Send response" -- batches the whole outcome into one round the client
    # sees next time, rather than pinging them once per edit.
    responded_at: Optional[datetime] = None
    # Set once the client has seen the response and continued past it, so it
    # doesn't keep reappearing on later visits.
    client_ack_at: Optional[datetime] = None


class RedlineEdit(SQLModel, table=True):
    """One proposed change to a single placeholder field, within a
    submission. `evaluation` is computed automatically against the field's
    threshold at submit time; `decision` is the account owner's call."""

    id: Optional[int] = Field(default=None, primary_key=True)
    submission_id: int = Field(foreign_key="redlinesubmission.id", index=True)
    field_key: str
    label: str  # snapshot of the field's label at proposal time
    original_value: str
    proposed_value: str
    comment: str = ""  # optional, client's note on why they're suggesting this specific change
    evaluation: str = "needs_review"  # auto_approved | needs_review
    decision: str = "pending"  # pending | accepted | rejected | countered
    # Only set when decision == "countered": the owner's own proposed value,
    # sent back to the client instead of a flat accept/reject.
    counter_value: str = ""


# ---------------------------------------------------------------------------
# Email drafting: one inbound alias per account, plus in-flight requests
# waiting on a reply for missing info.
# ---------------------------------------------------------------------------

class EmailAlias(SQLModel, table=True):
    """The one drafting email address assigned to an account, of the form
    drafts+{company_slug}+{number}@{EMAIL_DOMAIN}. The trailing number
    exists purely so the address can't be guessed from the company name."""

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, unique=True)
    company_slug: str
    number: str  # random digits, the actual secret part of the address
    active: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EmailDraftRequest(SQLModel, table=True):
    """One inbound "please draft this" email thread. Starts as
    awaiting_template or awaiting_info if the agent couldn't fully resolve
    it from the first message; a reply continues the same row rather than
    starting a new one."""

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    template_id: Optional[int] = Field(default=None, foreign_key="template.id")
    from_address: str
    subject: str = ""
    status: str = "awaiting_template"  # awaiting_template | awaiting_info | generating | done | failed
    values_json: str = "{}"  # best-known field_key -> value extracted so far
    missing_fields_json: str = "[]"  # field_keys still needed
    generated_contract_id: Optional[int] = Field(default=None, foreign_key="generatedcontract.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
