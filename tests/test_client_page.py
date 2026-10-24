"""Tests for owner branding (logo / name) on client pages and the one-link
"ready to sign" state on the client's review page.

Covers: logo upload checks (PNG/JPG by content, 1 MB cap, empty/odd files,
replace, remove), the public brand endpoints for share and sign links, the
fallback to the owner's name, and the signing state offered on the share
page (none / negotiating / ready / waiting turn / signed / all signed), plus
that the emailed signing links still work.

Run with:  venv/bin/pytest tests/
"""
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env, place, place_all, send, webhook, SIGNERS3  # noqa: E402,F401
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import (  # noqa: E402
    GeneratedContract, RedlineEdit, RedlineSubmission, ShareLink, SigningRequest, SigningRequestSigner, User,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def upload(env, data, name="logo.png", mime="image/png"):
    return env.post("/api/account/logo", files={"file": (name, data, mime)})


def owner(env):
    with Session(engine) as s:
        return s.get(GeneratedContract, env.gid).owner_id


def make_link(env, client_email="client@x.test"):
    with Session(engine) as s:
        link = ShareLink(generated_contract_id=env.gid, token="tok-%d" % time.time_ns(), access_code="ABCD",
                         client_email=client_email, client_first_name="Jamie", client_last_name="Client")
        s.add(link)
        s.commit()
        s.refresh(link)
        return link.token, link.id


def share_get(token, link_id):
    c = TestClient(m.app)
    return c.get(f"/api/share/{token}", headers={"x-share-session": m._issue_share_session(link_id)})


def signing_state(token, link_id):
    r = share_get(token, link_id)
    assert r.status_code == 200, r.text
    return r.json()["signing"]


def signers_for(client_email):
    tag = uuid.uuid4().hex[:8]
    out = [{**s, "email": f"{tag}-{s['email']}"} for s in SIGNERS3]
    out[2] = {**out[2], "email": client_email}  # the Client signer
    return out


def rows(sr_id):
    with Session(engine) as s:
        return {r.role: r for r in s.exec(select(SigningRequestSigner).where(SigningRequestSigner.signing_request_id == sr_id)).all()}


# ---- logo upload --------------------------------------------------------------------

def test_no_logo_falls_back_to_the_owners_name(env):
    got = env.get("/api/account/branding").json()
    assert got["has_logo"] is False and got["logo_url"] is None and got["name"] == "Owner"
    assert got["max_bytes"] == 1024 * 1024


def test_upload_png_and_jpg(env):
    r = upload(env, PNG)
    assert r.status_code == 200, r.text
    assert r.json()["has_logo"] is True and r.json()["logo_url"].startswith("/api/account/logo?v=")
    got = env.get("/api/account/logo")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == PNG
    # replacing with a JPG swaps the file
    assert upload(env, JPG, "l.jpg", "image/jpeg").status_code == 200
    got = env.get("/api/account/logo")
    assert got.headers["content-type"] == "image/jpeg" and got.content == JPG


def test_type_is_judged_by_content_not_name(env):
    assert upload(env, b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "logo.png", "image/png").status_code == 400
    assert upload(env, b"MZ not an image", "logo.png", "image/png").status_code == 400
    assert upload(env, b"GIF89a....", "logo.gif", "image/gif").status_code == 400
    # a real PNG with a misleading name is fine
    assert upload(env, PNG, "logo.txt", "text/plain").status_code == 200


def test_size_limit_is_one_megabyte(env):
    assert upload(env, PNG + b"\x00" * (1024 * 1024 - len(PNG))).status_code == 200  # exactly 1 MB
    r = upload(env, PNG + b"\x00" * (1024 * 1024))
    assert r.status_code == 400 and "1 MB" in r.json()["detail"]


def test_empty_file_is_rejected(env):
    assert upload(env, b"").status_code == 400


def test_remove_logo(env):
    upload(env, PNG)
    r = env.delete("/api/account/logo")
    assert r.status_code == 200 and r.json()["has_logo"] is False
    assert env.get("/api/account/logo").status_code == 404
    assert env.delete("/api/account/logo").status_code == 200  # removing nothing is fine


def test_logo_endpoints_need_login():
    c = TestClient(m.app)
    assert c.get("/api/account/branding").status_code in (401, 403)
    assert c.post("/api/account/logo", files={"file": ("a.png", PNG, "image/png")}).status_code in (401, 403)
    assert c.delete("/api/account/logo").status_code in (401, 403)


# ---- what clients see ----------------------------------------------------------------

def test_share_brand_is_public_and_shows_name_without_logo(env):
    token, _ = make_link(env)
    got = TestClient(m.app).get(f"/api/share/{token}/brand")
    assert got.status_code == 200
    assert got.json() == {"name": "Owner", "has_logo": False, "logo_url": None, "link": None}
    assert TestClient(m.app).get(f"/api/share/{token}/logo").status_code == 404


def test_share_brand_with_logo(env):
    upload(env, PNG)
    token, _ = make_link(env)
    c = TestClient(m.app)
    got = c.get(f"/api/share/{token}/brand").json()
    assert got["has_logo"] is True and got["logo_url"].startswith(f"/api/share/{token}/logo?v=")
    img = c.get(f"/api/share/{token}/logo")
    assert img.status_code == 200 and img.content == PNG and img.headers["content-type"] == "image/png"


def test_unknown_tokens_are_404(env):
    c = TestClient(m.app)
    assert c.get("/api/share/nope/brand").status_code == 404
    assert c.get("/api/share/nope/logo").status_code == 404
    assert c.get("/api/sign/nope/brand").status_code == 404
    assert c.get("/api/sign/nope/logo").status_code == 404


def test_brand_falls_back_to_email_when_the_owner_has_no_name(env):
    with Session(engine) as s:
        u = s.get(User, owner(env))
        u.name = ""
        s.add(u)
        s.commit()
        email = u.email
    token, _ = make_link(env)
    assert TestClient(m.app).get(f"/api/share/{token}/brand").json()["name"] == email


def test_sign_brand_with_logo(env):
    upload(env, PNG)
    place_all(env)
    data = send(env, signers=signers_for("client@x.test")).json()
    tok = rows(data["id"])["Client"].token
    c = TestClient(m.app)
    got = c.get(f"/api/sign/{tok}/brand").json()
    assert got["has_logo"] is True and got["name"] == "Owner"
    assert c.get(f"/api/sign/{tok}/logo").content == PNG


def test_removed_logo_stops_being_served_to_clients(env):
    upload(env, PNG)
    token, _ = make_link(env)
    env.delete("/api/account/logo")
    c = TestClient(m.app)
    assert c.get(f"/api/share/{token}/brand").json()["has_logo"] is False
    assert c.get(f"/api/share/{token}/logo").status_code == 404


# ---- one link: signing state on the share page ------------------------------------------

def test_no_signature_request_means_no_signing_offer(env):
    token, link_id = make_link(env)
    assert signing_state(token, link_id) == {"state": "none"}


def test_ready_to_sign_points_at_the_clients_own_signing_page(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    data = send(env, signers=signers_for(email)).json()
    token, link_id = make_link(env, email)
    got = signing_state(token, link_id)
    assert got["state"] == "ready" and got["role"] == "Client"
    assert got["sign_url"] == "/sign/" + rows(data["id"])["Client"].token


def test_email_match_ignores_case_and_spaces(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    send(env, signers=signers_for(email))
    token, link_id = make_link(env, "  " + email.upper() + " ")
    assert signing_state(token, link_id)["state"] == "ready"


def test_someone_who_is_not_a_signer_gets_no_offer(env):
    place_all(env)
    send(env, signers=signers_for("client-%d@x.test" % time.time_ns()))
    token, link_id = make_link(env, "stranger@x.test")
    assert signing_state(token, link_id) == {"state": "none"}


def test_link_without_an_email_gets_no_offer(env):
    place_all(env)
    send(env, signers=signers_for("client-%d@x.test" % time.time_ns()))
    token, link_id = make_link(env, "")
    assert signing_state(token, link_id) == {"state": "none"}


def test_in_order_waits_for_the_clients_turn(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    data = send(env, signers=signers_for(email), sign_in_order=True).json()
    token, link_id = make_link(env, email)
    got = signing_state(token, link_id)
    assert got["state"] == "waiting_turn" and got["waiting_on"] == ["Casey CEO", "Fran CFO"]
    # once the two ahead have signed, the button appears
    r = rows(data["id"])
    webhook(env, "form.completed", r["CEO"].docuseal_submitter_id)
    webhook(env, "form.completed", r["CFO"].docuseal_submitter_id)
    assert signing_state(token, link_id)["state"] == "ready"


def test_after_signing_the_client_sees_who_is_left(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    data = send(env, signers=signers_for(email)).json()
    token, link_id = make_link(env, email)
    webhook(env, "form.completed", rows(data["id"])["Client"].docuseal_submitter_id)
    got = signing_state(token, link_id)
    assert got["state"] == "signed" and got["waiting_on"] == ["Casey CEO", "Fran CFO"]


def test_everyone_signed(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    data = send(env, signers=signers_for(email)).json()
    token, link_id = make_link(env, email)
    for r in rows(data["id"]).values():
        webhook(env, "form.completed", r.docuseal_submitter_id)
    with Session(engine) as s:
        sr = s.get(SigningRequest, data["id"])
        sr.status = "completed"
        s.add(sr)
        s.commit()
    assert signing_state(token, link_id) == {"state": "all_signed"}


def test_cancelled_request_offers_nothing(env, monkeypatch):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    send(env, signers=signers_for(email))
    token, link_id = make_link(env, email)
    monkeypatch.setattr(m.ds, "archive_submission", lambda *_: None)
    assert env.post(f"/api/generated/{env.gid}/signature-request/cancel").status_code == 200
    assert signing_state(token, link_id) == {"state": "none"}


def test_still_negotiating_hides_signing(env):
    """A countered redline still waiting on the client means it isn't agreed."""
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    send(env, signers=signers_for(email))
    token, link_id = make_link(env, email)
    with Session(engine) as s:
        sub = RedlineSubmission(share_link_id=link_id, status="pending", origin="owner_edit")
        s.add(sub)
        s.commit()
        s.refresh(sub)
        s.add(RedlineEdit(submission_id=sub.id, label="Fee", original_value="$5", proposed_value="$5",
                          counter_value="$4", decision="countered"))
        s.commit()
    assert signing_state(token, link_id)["state"] == "negotiating"


def test_client_round_waiting_on_the_owner_hides_signing(env):
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    send(env, signers=signers_for(email))
    token, link_id = make_link(env, email)
    with Session(engine) as s:
        sub = RedlineSubmission(share_link_id=link_id, status="pending", origin="client")
        s.add(sub)
        s.commit()
        s.refresh(sub)
        s.add(RedlineEdit(submission_id=sub.id, label="Fee", original_value="$5", proposed_value="$3"))
        s.commit()
    assert signing_state(token, link_id)["state"] == "negotiating"


def test_the_old_links_keep_working(env):
    """Emailed signing links and the access-code gate are unchanged."""
    place_all(env)
    email = "client-%d@x.test" % time.time_ns()
    data = send(env, signers=signers_for(email)).json()
    tok = rows(data["id"])["Client"].token
    c = TestClient(m.app)
    got = c.get(f"/api/sign/{tok}")
    assert got.status_code == 200 and got.json()["role"] == "Client"
    token, link_id = make_link(env, email)
    assert c.get(f"/api/share/{token}").status_code == 401  # still needs the access code
    r = c.post(f"/api/share/{token}/verify", json={"access_code": "abcd"})
    assert r.status_code == 200 and "session_token" in r.json()
    assert c.get(f"/api/share/{token}", headers={"x-share-session": r.json()["session_token"]}).status_code == 200


# ---- the logo's website link --------------------------------------------------------

def set_link(env, link):
    return env.patch("/api/account/branding", json={"link": link})


def test_logo_is_not_a_link_until_the_owner_sets_one(env):
    assert env.get("/api/account/branding").json()["link"] is None
    token, _ = make_link(env)
    assert TestClient(m.app).get(f"/api/share/{token}/brand").json()["link"] is None


def test_owner_sets_a_website_and_clients_see_it_on_both_pages(env):
    r = set_link(env, "  acme.com/about  ")
    assert r.status_code == 200, r.text
    assert r.json()["link"] == "https://acme.com/about"
    assert env.get("/api/account/branding").json()["link"] == "https://acme.com/about"
    token, _ = make_link(env)
    c = TestClient(m.app)
    assert c.get(f"/api/share/{token}/brand").json()["link"] == "https://acme.com/about"
    # the signing page's brand endpoint reads the same owner setting
    place_all(env)
    data = send(env, signers=signers_for("client@x.test")).json()
    tok = rows(data["id"])["Client"].token
    assert c.get(f"/api/sign/{tok}/brand").json()["link"] == "https://acme.com/about"


def test_a_blank_website_makes_the_logo_unclickable_again(env):
    set_link(env, "https://acme.com")
    r = set_link(env, "")
    assert r.status_code == 200 and r.json()["link"] is None


def test_the_website_survives_replacing_or_removing_the_logo(env):
    set_link(env, "acme.com")
    upload(env, PNG)
    assert env.get("/api/account/branding").json()["link"] == "https://acme.com"
    env.delete("/api/account/logo")
    assert env.get("/api/account/branding").json()["link"] == "https://acme.com"


@pytest.mark.parametrize("bad", [
    "javascript:alert(1)", "data:text/html,hi", "mailto:a@b.com", "ftp://acme.com", "https://user:pw@acme.com",
    "acme", "http://", "https://acme.com/a b", 'https://acme.com/"x', "https://acme.com/<x>", "https://-bad.com",
    "https://acme.com:99999", "http://[::1]/", "a" * 400 + ".com",
])
def test_only_plain_web_addresses_are_accepted(env, bad):
    r = set_link(env, bad)
    assert r.status_code == 400, bad
    assert env.get("/api/account/branding").json()["link"] is None


def test_the_website_needs_a_logged_in_owner(env):
    assert TestClient(m.app).patch("/api/account/branding", json={"link": "acme.com"}).status_code in (401, 403)
