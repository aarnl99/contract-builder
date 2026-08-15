# Draftly

Draftly turns a Word contract into a reusable master document: upload a
`.docx`, select the parts that change from contract to contract (client
name, dates, dollar amounts, and so on), and draft a finished, formatted
`.docx` any time by filling in a short form.

## How it works

1. **Upload a master document.** Give it a name and a document type (NDA,
   Services Agreement, Lease, and so on) and upload a `.docx`.
2. **Mark placeholders.** Select any text in the rendered contract and click
   "Mark as placeholder." Give it a label and a type (text, date, number, or
   long text). The selected text is replaced with a token inside the working
   copy of the document, and the surrounding text and formatting (bold,
   italic, underline) are preserved exactly.
3. **Draft.** Pick a master document from the Draft tab, fill in the blanks
   in the popup, and click Generate. You get a live preview of the finished
   contract plus a real `.docx` download, ready to open in Word or import
   into Google Docs.
4. **Library.** Every drafted contract is saved in the Documents tab,
   grouped by document type, and always traceable back to the master
   document it came from. Archive a copy to hide it without deleting it, or
   delete it forever.

Each account has its own master documents and drafted documents. Plans
(starter, pro, unlimited) cap how many contracts can be drafted per month.
There is no real payment processor wired up yet, an account's plan can be
changed from the account menu for testing, and upgrading it does not charge
a card.

## Project layout

```
app/
  main.py         FastAPI app: auth, master documents, marking, drafting, library, plans
  docx_engine.py  Core .docx manipulation (render, split runs, fill tokens)
  models.py       Database tables (User, Template, Placeholder, GeneratedContract)
  auth.py         Password hashing and session-based auth
  db.py           SQLite engine/session setup
  static/         Frontend (vanilla HTML/CSS/JS, no build step)
tests/
  test_docx_engine.py   Unit tests for the docx engine
render.yaml       Render Blueprint (see Deploying below)
requirements.txt
```

## Running it locally

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then open http://localhost:8000, create an account, and upload a `.docx`
file.

The first run creates `app/data.db` (SQLite) and `app/secret.key` (session
signing key) automatically. Uploaded master documents and drafted contracts
are stored under `app/uploads/<user_id>/<template_id>/`.

## Running the tests

```bash
source venv/bin/activate
pip install pytest
pytest tests/
```

A full browser end-to-end test (register, upload, mark placeholders, draft,
archive, delete, switch plans) was written with Playwright and run during
development. It is not included here to keep the deliverable small, but
`tests/test_docx_engine.py` covers the core engine, which is the part most
worth guarding with tests.

## Deploying

This build was put together overnight in a sandboxed environment that can
reach GitHub for git operations but cannot reach hosting provider APIs
(Render, Vercel, Railway, and similar were all unreachable). So the code is
committed locally and ready to push, but it has not been pushed or deployed
anywhere yet. Two steps get it live:

1. **Create an empty GitHub repository** (no README, no `.gitignore`, no
   license, so the first push is clean), then push this code to it:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Deploy on Render** (or any host that runs a Python web process): go to
   Render's dashboard, choose New, then Blueprint, and point it at the repo.
   `render.yaml` in this project tells Render exactly how to build and run
   it, including generating a session secret automatically, so this step
   does not require filling in any fields by hand. If you would rather use
   a different host, the equivalent manual settings are:
   - Build command: `pip install -r requirements.txt`
   - Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - Environment variable: `SESSION_SECRET_KEY` set to any random string

**A note on the free tier:** most hosts' free web service tiers do not
include persistent disk storage, so the SQLite database and uploaded files
will reset on redeploys and sometimes on restarts after inactivity. That is
fine for trying the app out, but before real users rely on it, either
attach a persistent disk (a paid tier on most hosts) or move the database to
a hosted Postgres instance (the SQLModel models will work unchanged, only
`db.py`'s connection string needs to change).

## What is built and what is not

**Built and working tonight:** accounts, master documents with a name and
document type, click-to-mark placeholder editing that preserves formatting,
the draft flow (pick a template, fill in a popup, get a live preview and a
`.docx` download), the documents library grouped by type with archive and
permanent delete, and real usage limits tied to a plan.

**Not built yet, on purpose:**
- **Real billing.** Plans can be switched from the account menu for testing
  the limits, but no payment processor is connected, so nothing is actually
  charged.
- **Email and Slack drafting.** The idea (email or Slack a request, get a
  reply with the blanks to fill in, or send the filled-in values directly)
  needs its own accounts and credentials, an inbound email service and a
  registered Slack app, neither of which exist yet.
- **In-document editing.** "Manually edit" currently means reopening the
  fill-in popup with your previous answers and changing them, which creates
  a new saved draft. Freeform editing of the generated document's text
  inside the browser is a bigger feature on its own and was deliberately
  left out of this build.

## Known limitations (v1)

- **Headers and footers.** These live in separate document parts and are
  not rendered or markable yet. Body content and table content (including
  signature blocks, which are commonly built as tables) are both fully
  supported.
- **One paragraph per placeholder.** A selection cannot span two
  paragraphs (or a paragraph and a table cell), the editor will ask you to
  select within a single paragraph.
- **Merged table cells** render as a single cell without recomputing
  colspan/rowspan, so a merged region may look slightly narrower/shorter in
  the marking view than it does in Word. The content itself is still fully
  present and markable.
- **No PDF export.** Output is always `.docx`.
- **Removing a placeholder** replaces its token with the label text rather
  than perfectly restoring the original wording. Use "Start over" on a
  master document to fully revert to the original upload.

## Ideas for v2

- Header/footer support in the renderer and marker.
- Team or organization sharing of master documents.
- PDF export alongside `.docx`.
- Real in-document editing (or a Google Docs handoff for editing only, kept
  separate from the primary `.docx` delivery).
- Email and Slack drafting once the supporting accounts exist.
- Real billing.
