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

    # Email verification: a new account can't log in until they click the
    # link sent to verification_token. The token is cleared once used, so
    # it also can't be replayed. verification_sent_at drives the "resend"
    # flow's light rate limiting (see main.py).
    email_verified: bool = False
    verification_token: str = Field(default="", index=True)
    verification_sent_at: Optional[datetime] = None

    # Admin-only account hold: a suspended account can't log in, and any
    # existing session is rejected on the next request (see
    # auth.get_current_user), without deleting any of their data.
    is_suspended: bool = False

    # "Forgot password" flow: set when /api/forgot-password is requested,
    # cleared once used (or replaced by a fresh request) so it can't be
    # replayed. reset_sent_at both rate-limits repeat requests and expires
    # the link after an hour, the same pattern as email verification above.
    reset_token: str = Field(default="", index=True)
    reset_sent_at: Optional[datetime] = None

    # Set once someone signs in via "Continue with Google", so the login
    # page can tell them to use that button instead of a password if they
    # never set one, and so account creation on first Google sign-in knows
    # not to expect a password. Empty for accounts that only ever used
    # email/password.
    google_sub: str = Field(default="", index=True)

    # Per-type opt-outs for the owner-facing notifications a client's
    # actions can trigger -- both the in-app bell (see main.py's _notify
    # call sites) and the matching email. Each defaults on, since these are
    # about the account's own documents and someone would normally want to
    # hear about them; see GET/PATCH /api/account/notification-settings.
    # (A third toggle, notify_response_acknowledged, used to gate a "client
    # saw your response" notification -- removed because it fired on every
    # visit and produced too much low-value email. The column may still
    # exist on older rows in the live DB; it's just unused now.)
    notify_redline_submitted: bool = True  # a client sent back proposed edits
    # A client commented in a redline's thread (any redline, not just a
    # declined one, as of Phase 2 of the redline-negotiation overhaul).
    # Gates the in-app bell only -- thread replies never send email.
    notify_redline_comment: bool = True
    # A signer finished signing (bell only -- see _apply_signer_completed)
    # or an entire signature request is fully signed by everyone (gates both
    # the bell and the "Fully signed" email -- see _apply_submission_completed
    # and _send_signature_completed_email). Previously this was hardcoded
    # to email-only with no bell and no way to opt out at all; see bug
    # tracker entry on missing signature notifications.
    notify_signature_events: bool = True

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

    # The literal text that was selected and replaced with {{field_key}}
    # when this field was first marked -- captured so un-marking
    # (main.delete_placeholder) can restore the actual original wording
    # instead of having nothing to fall back on but the field's label.
    # "" for placeholders marked before this field existed; delete_placeholder
    # falls back to the label in that case, same as it always has.
    original_text: str = ""

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
    # Set when this revision was produced by the owner editing a prior
    # revision directly in the product (select text -> replace, applied
    # instantly, no client involved) rather than through a redline round --
    # its own lineage link, independent of source_submission_id, so direct
    # edits still slot into the same revision-history chain as redlines.
    source_generated_id: Optional[int] = Field(default=None, foreign_key="generatedcontract.id")

    owner: Optional[User] = Relationship(back_populates="generated_contracts")


class GenerationEvent(SQLModel, table=True):
    """Immutable log of every successful document-generation event (a fresh
    draft, an owner edit, an applied redline round, or an inbound-email
    draft -- anything that produces a new GeneratedContract row), used only
    to compute monthly plan usage. Kept as its own append-only table,
    separate from GeneratedContract itself, specifically so permanently
    deleting a generated document later (see delete_generated_forever)
    can't retroactively free up the plan quota it already used this month
    -- counting live GeneratedContract rows directly let a user at their
    cap delete an old draft to "unlock" another slot, which didn't match
    the "used X of Y this month" messaging shown to them."""

    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    generated_contract_id: Optional[int] = Field(default=None, foreign_key="generatedcontract.id")
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


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
    # Required as of the redline-negotiation overhaul (2026-08-17) for any
    # NEWLY created link -- see main.create_share_link -- both so a share
    # always has a real person attached (comments and, eventually,
    # signatures need an actual name, not a maybe-blank email) and so the
    # "document shared with you" / "sender responded" emails always have
    # somewhere to go. Links created before that change keep whatever they
    # had (possibly blank); nothing here retroactively enforces it.
    client_email: str = ""  # shown to the client as "Editing as", and where share/response emails go
    client_first_name: str = ""
    client_last_name: str = ""
    # Optional override for what the client sees as "the document sender"
    # (contact link, reply-to on outbound mail) -- falls back to the
    # account's own login email when blank, but lets an account holder who
    # drafts under a different address than they log in with show the right
    # one to this particular client.
    sender_email: str = ""
    status: str = "open"  # open | closed
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_viewed_at: Optional[datetime] = None
    # Set whenever the owner directly edits (see main.edit_generated_document)
    # the exact document this link points the client at, while the link is
    # still open. Compared against last_viewed_at (before it's overwritten)
    # on the client's next GET to decide whether to show them a "this was
    # updated since you last looked" notice -- naturally resets itself once
    # they've seen it, with no separate "acknowledged" flag needed.
    owner_edited_at: Optional[datetime] = None


class ShareLinkView(SQLModel, table=True):
    """One instance of a client opening a share link (after passing the
    access-code gate). Logged every time, not just the latest -- unlike
    ShareLink.last_viewed_at, which only ever holds the most recent visit --
    so a document's revision-history trail can show every view, in the
    viewer's local time, not just whether it's been seen at all."""

    id: Optional[int] = Field(default=None, primary_key=True)
    share_link_id: int = Field(foreign_key="sharelink.id", index=True)
    viewed_at: datetime = Field(default_factory=datetime.utcnow)


class RedlineSubmission(SQLModel, table=True):
    """One batch of proposed edits, submitted through a share link. Almost
    always the client (see `origin`), but as of the redline-negotiation
    overhaul phase 3 the owner can also originate one directly, to send a
    reconsidered decision back as its own scoped round -- see
    main.reconsider_redline_edit. Phase 5 adds a third originator: the
    owner's own direct edits, once a document is shared -- see
    main.edit_generated_document."""

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
    # client -- the normal case, a client's own batch (via Save progress /
    #           Finalize and submit).
    # owner_reconsideration -- created directly by main.reconsider_redline_edit
    #           when the owner changes their mind on an edit they'd already
    #           decided; contains exactly the one reconsidered edit, arrives
    #           already responded_at-set (see below), and must NOT be treated
    #           as "the client sent proposed changes for review" anywhere
    #           that branches on submission type (e.g. the document activity
    #           timeline in main.get_generated_history / app.js's
    #           chainItemFor -- gets its own "owner_reconsidered" event type
    #           there instead of "redline_submitted").
    # owner_edit -- created directly by main.edit_generated_document when the
    #           owner selects text and edits it on a document that's already
    #           shared (bug tracker #23, phase 5 of the overhaul). Once
    #           shared, a direct edit is never applied instantly -- it's
    #           queued as exactly one client-approvable RedlineEdit, decision
    #           "countered" from the moment it's created (the owner IS the
    #           counter -- there's no preceding client ask), so it flows
    #           through the exact same accept/reject/counter machinery as an
    #           ordinary counter, arrives already responded_at-set like an
    #           owner_reconsideration round, and counts toward phase 4's
    #           "N unresolved, Finalize blocked" gate for free, since that
    #           gate is keyed on any live "countered" edit regardless of
    #           origin. Deliberately has no owner-side bypass to apply it
    #           instantly instead -- see the phase 5 writeup in the Notion
    #           bug tracker for why.
    origin: str = "client"

    # Set when the owner reviews every edit (accept/reject/counter) and hits
    # "Send response" -- batches the whole outcome into one round the client
    # sees next time, rather than pinging them once per edit. For an
    # owner_reconsideration submission this is set immediately at creation
    # (the owner's action IS the response, there's no separate review step).
    responded_at: Optional[datetime] = None
    # Set once the client has seen the response and continued past it, so it
    # doesn't keep reappearing on later visits.
    client_ack_at: Optional[datetime] = None


class RedlineEdit(SQLModel, table=True):
    """One proposed change to an exact spot in the document, within a
    submission. `evaluation` is computed automatically against the field's
    threshold at submit time (fields only); `decision` is the account
    owner's call.

    Historically this was always "a new value for a known placeholder
    field," applied by regenerating the whole document from the master
    template with a field_key -> value map. That meant every occurrence of
    a field sharing the same field_key changed together, and only
    previously-marked placeholder text could be redlined at all.

    Edits now carry `location_json`, the exact (container, paragraph, run
    segments) in the specific generated document this edit targets --
    captured by the browser the same way template authoring already maps a
    selection to an exact spot (see docx_engine.mark_placeholder). Applying
    an edit means splicing new text in at that one location in that one
    document (docx_engine.apply_text_edits), not re-filling a token
    everywhere it appears. That's what makes two occurrences of the same
    field independently redlinable, and what makes redlining any text --
    not just a previously-marked placeholder -- possible: a "text" edit
    simply has an empty field_key and no threshold rule."""

    id: Optional[int] = Field(default=None, primary_key=True)
    submission_id: int = Field(foreign_key="redlinesubmission.id", index=True)
    # "" for a free-text edit not tied to any known placeholder field.
    field_key: str = ""
    label: str  # snapshot of the field's label (or a short excerpt of the original text, for free-text edits)
    original_value: str
    proposed_value: str
    comment: str = ""  # optional, client's note on why they're suggesting this specific change
    evaluation: str = "needs_review"  # auto_approved | needs_review
    decision: str = "pending"  # pending | accepted | rejected | countered
    # Only set when decision == "countered": the owner's own proposed value,
    # sent back to the client instead of a flat accept/reject.
    counter_value: str = ""
    # {"container_path": [[t,r,c],...], "paragraph_index": int,
    #  "segments": [{"r","start","end"}, ...]} -- the exact spot in the
    # generated document (GeneratedContract.file_path, at submission time)
    # this edit targets. Empty "{}" only for rows written before this field
    # existed; such rows can no longer be applied and are skipped.
    location_json: str = "{}"
    # Superseded by RedlineComment (see below) as of the redline-negotiation
    # overhaul phase 2 -- a one-shot reply, settable only on a declined edit.
    # Columns kept (never written to going forward) so old rows aren't
    # dropped; nothing reads these anymore.
    client_reply: str = ""
    client_reply_at: Optional[datetime] = None
    # Independent of `decision` -- a thread can be resolved on a pending,
    # accepted, rejected, OR countered edit; "the conversation is done" is a
    # separate question from "what was decided." True only while explicitly
    # marked resolved (via RedlineComment thread endpoints); posting a new
    # comment while resolved auto-reopens it. See main.post_edit_comment /
    # main.post_share_edit_comment.
    comments_resolved: bool = False
    # Points at the prior RedlineEdit this one continues a negotiation
    # from -- two distinct producers as of phase 3 of the redline-
    # negotiation overhaul:
    #   1. The client responding (accepting exactly OR countering again) to
    #      a "countered" RedlineEdit of the sender's -- see
    #      main._resolve_edits' accepting_edit_id handling. Set regardless
    #      of whether the client took the counter's value as-is (decision
    #      also auto-set to "accepted" in that case) or suggested something
    #      different (decision stays "pending" for the owner to review) --
    #      before phase 3 this was only set on an exact match, so a client
    #      who suggested a different value after a counter lost the link
    #      back to the negotiation entirely (bug tracker #20).
    #   2. The owner reconsidering an edit they'd already decided -- see
    #      main.reconsider_redline_edit (#19). Points back at the edit
    #      being reconsidered; the new row carries the owner's updated
    #      decision and lives in its own `origin="owner_reconsideration"`
    #      RedlineSubmission (see RedlineSubmission.origin) rather than
    #      mutating the original row, so the original decision stays in
    #      the record as-was.
    # Persisted here (not just resolved in-memory at submit time) so a
    # client who "Save progress"s a counter-response and resumes on a later
    # visit still has it recognized on their eventual Finalize -- without
    # this, the resumed draft item looked like an ordinary fresh proposal
    # with nothing marking it as continuing an earlier round.
    # main._source_edit_summary turns this into a short "responds to ..."
    # preview shown in both the owner and client redline views.
    source_edit_id: Optional[int] = Field(default=None, foreign_key="redlineedit.id")


class RedlineComment(SQLModel, table=True):
    """One message in the open comment thread on a RedlineEdit -- lightweight,
    Google-Docs-suggest-edit-style back-and-forth, open on ANY redline
    regardless of its accept/reject/counter decision (see the redline-
    negotiation overhaul, phase 2). Either side can post; `author_name` is a
    snapshot at post time (the owner's account name, or the client's
    first+last name collected at share creation -- see ShareLink), not a
    live foreign key, so a thread still reads correctly even if the
    account/client details change later."""

    id: Optional[int] = Field(default=None, primary_key=True)
    edit_id: int = Field(foreign_key="redlineedit.id", index=True)
    author_type: str  # "owner" | "client"
    author_name: str
    body: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


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


# ---------------------------------------------------------------------------
# E-signature: send a finished, redline-settled document out through
# DocuSeal for signing. See app/docuseal_engine.py for the API integration
# itself; these two tables are just Rotely's own record of each request.
# ---------------------------------------------------------------------------

class SigningRequest(SQLModel, table=True):
    """One send-for-signature request for a single, specific
    GeneratedContract revision -- not a whole lineage family the way
    ShareLink intentionally is. The document being signed is the exact
    decided-upon .docx; if the owner creates another revision later,
    sending that for signature is its own new SigningRequest, never a
    silent repoint onto a request already in flight.
    `docuseal_submission_id` is a one-off DocuSeal "submission" (see
    docuseal_engine.create_submission_from_docx) -- never a reusable
    DocuSeal "template" object."""

    id: Optional[int] = Field(default=None, primary_key=True)
    generated_contract_id: int = Field(foreign_key="generatedcontract.id", index=True)
    docuseal_submission_id: int
    status: str = "pending"  # pending | completed | declined | cancelled | expired
    # Populated once every signer has completed, by downloading from
    # DocuSeal immediately (its document URLs expire ~40 minutes after
    # being issued -- see docuseal_engine.get_submission_documents) rather
    # than ever storing a DocuSeal URL. Relative-to-UPLOADS_DIR path, same
    # convention as GeneratedContract.file_path / Template.working_path.
    signed_file_path: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None


class SigningRequestSigner(SQLModel, table=True):
    """One signer within a SigningRequest. `token` gates Rotely's own
    consent + photo-capture page (see main.py's GET/POST /api/sign/{token})
    -- a signer never sees DocuSeal's own signing form (reached via
    `embed_src`) until they've explicitly consented and a photo has been
    captured, both recorded here. This is deliberately a record kept
    alongside the signature, not an identity-verification step: a bare
    photo with nothing to match it against proves someone's face was in
    front of a camera, not that it's the face it claims to be."""

    id: Optional[int] = Field(default=None, primary_key=True)
    signing_request_id: int = Field(foreign_key="signingrequest.id", index=True)
    docuseal_submitter_id: int
    role: str  # must exactly match the role= used in the document's {{...}} field tags
    name: str
    email: str
    token: str = Field(index=True, unique=True)
    # DocuSeal's own per-signer signing-form URL, taken verbatim from its API
    # response ("embed_src", e.g. "https://docuseal.com/s/pAMimKcyrLjqVt").
    # Unlike the submission's *document* URLs (see
    # docuseal_engine.get_submission_documents), this one is stable until the
    # submission completes, so it's fine to store rather than re-fetch.
    embed_src: str = ""
    status: str = "awaiting_consent"  # awaiting_consent | ready_to_sign | completed | declined
    consent_given_at: Optional[datetime] = None
    photo_path: str = ""  # relative-to-UPLOADS_DIR path to the captured consent photo
    photo_captured_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Notification(SQLModel, table=True):
    """One in-app bell notification for an account owner. Deliberately
    narrow-scoped: only two things ever create a row here -- a client
    submitting redlines for review, and a client commenting on a redline the
    owner declined (see main.py's submit_redlines and reply_to_redline_edit).
    Nothing else should write to this table. (A third trigger,
    "response_acknowledged" -- a client acknowledging the owner's response --
    used to write here too; it was retired for firing too often with too
    little value. Old rows of that type may still exist and still render.)"""

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    type: str  # "redline_submitted" | "redline_comment" (legacy rows may also be "response_acknowledged")
    title: str
    body: str = ""
    generated_contract_id: Optional[int] = Field(default=None, foreign_key="generatedcontract.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    read_at: Optional[datetime] = None
