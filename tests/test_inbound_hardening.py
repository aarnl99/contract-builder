"""Hardening of the inbound-email path, from an independent review: who counts
as the sender, what counts as authenticated, malformed webhook calls, hostile
input that must stay cheap, and plain-text parsing of client names.

Run with:  venv/bin/pytest tests/
"""
import hmac
import hashlib
import base64
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, select  # noqa: E402

from test_multi_signer import env  # noqa: E402,F401
from test_email_send_flow import (AUTH_OK, PATH_SECRET, continuation, flow, make_draft, pending_request,  # noqa: E402,F401
                                  send_in)
from app import email_engine as ee  # noqa: E402
from app import main as m  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import EmailDraftRequest, ShareLink  # noqa: E402


# ---- who the sender is -------------------------------------------------------------------

@pytest.mark.parametrize("header,expected", [
    ("Aaron <owner@acme.test>", "owner@acme.test"),
    ("owner@acme.test", "owner@acme.test"),
    ("<owner@acme.test>", "owner@acme.test"),
    ('"owner@acme.test" <attacker@evil.test>', "attacker@evil.test"),
    ("Mallory <mallory@evil.io> (<owner@acme.test>)", "mallory@evil.io"),
    ("Mallory <m@evil.io>, Owner <owner@acme.test>", ""),
    ("owner@acme.test, other@acme.test", ""),
    ("", ""),
    ("no address here", ""),
    ("x" * 5000, ""),
])
def test_the_sender_is_the_one_real_address(header, expected):
    assert m._extract_email_address(header) == expected


def test_a_comment_in_the_from_line_cannot_pose_as_the_owner(flow):
    req = make_draft(flow)
    flow.mail.clear()
    spoof = f"Mallory <mallory@evilcorp.io> (<{flow.owner_email}>)"
    r = send_in(flow, spoof, "Re: x", "Mallory Evil, mallory@evilcorp.io", to=continuation(flow, req.id))
    assert r.json()["ok"] is False
    with Session(engine) as s:
        assert s.exec(select(ShareLink).where(ShareLink.generated_contract_id == req.generated_contract_id)).first() is None
    assert all("access code" not in x["body"].lower() and "secure link" not in x["body"].lower() for x in flow.mail)
    assert pending_request(flow).status == "awaiting_recipient"


def test_several_people_in_the_from_line_are_refused(flow):
    r = send_in(flow, f"Mallory <m@evilcorp.io>, Owner <{flow.owner_email}>", "Please draft an NDA", "Client Acme")
    assert r.json()["ok"] is False and pending_request(flow) is None


# ---- what counts as authenticated -----------------------------------------------------------

def test_a_dkim_pass_without_dmarc_is_not_enough(flow):
    r = send_in(flow, flow.owner_email, "Please draft an NDA", "Client Acme",
                auth={"spf": "fail", "dkim": "pass", "dmarc": "fail"})
    assert r.json()["ok"] is False and pending_request(flow) is None


def test_form_posts_are_refused_once_a_signing_secret_is_set(flow, monkeypatch):
    monkeypatch.setattr(ee, "RESEND_WEBHOOK_SECRET", "whsec_" + base64.b64encode(b"k").decode())
    r = TestClient(m.app).post(f"/api/email/inbound/{PATH_SECRET}", data={
        "to": flow.address, "from": flow.owner_email, "subject": "NDA", "text": "x", "dkim": "{@a.test : pass}"})
    assert r.status_code == 401 and pending_request(flow) is None


def test_a_sendgrid_dkim_pass_must_be_for_the_senders_own_domain(flow):
    domain = flow.owner_email.split("@")[1]
    post = lambda dkim: TestClient(m.app).post(f"/api/email/inbound/{PATH_SECRET}", data={  # noqa: E731
        "to": flow.address, "from": flow.owner_email, "subject": "Please draft an NDA", "text": "Client Acme",
        "dkim": dkim}).json()
    assert post("{@bypass.test : pass}")["ok"] is False
    assert post("{@%s : fail}" % domain)["ok"] is False
    assert pending_request(flow) is None
    assert post("{@%s : pass}" % domain)["ok"] is True
    assert m._dkim_passes_for("{@acme.test : pass}", "a@mail.acme.test")
    assert not m._dkim_passes_for("{@mail.acme.test : pass}", "a@acme.test")


# ---- malformed calls fail safely -------------------------------------------------------------

@pytest.mark.parametrize("body", ["[]", "null", '"x"', "7", '{"type": "email.received", "data": "s"}',
                                  '{"type": "email.received", "data": {"to": "not-a-list", "from": 5}}'])
def test_odd_json_bodies_get_a_clean_error_not_a_crash(flow, body):
    flow.state["text"] = ""
    r = TestClient(m.app).post(f"/api/email/inbound/{PATH_SECRET}", content=body,
                               headers={"content-type": "application/json"})
    assert r.status_code < 500


def test_a_non_ascii_path_secret_is_just_not_found(flow):
    assert TestClient(m.app).post("/api/email/inbound/%C3%A9", json={}).status_code == 404


def test_signature_checks_never_raise():
    key = base64.b64encode(b"k").decode()
    secret = "whsec_" + key
    body = b"{}"
    good = base64.b64encode(hmac.new(b"k", b"i.%d." % 1000 + body, hashlib.sha256).digest()).decode()
    assert ee.verify_resend_signature(secret, "i", "1000", "v1," + good, body, now=1000)
    assert not ee.verify_resend_signature(secret, "i", "9" * 400, "v1," + good, body)
    assert not ee.verify_resend_signature(secret, "i", "1000", "v1,éé", body, now=1000)
    # a mistyped secret that decodes to nothing must not validate a signature made with an empty key
    empty = base64.b64encode(hmac.new(b"", b"i.1000." + body, hashlib.sha256).digest()).decode()
    assert not ee.verify_resend_signature("whsec_!!!", "i", "1000", "v1," + empty, body, now=1000)


# ---- hostile input stays cheap -----------------------------------------------------------------

def test_a_pile_of_unclosed_tags_is_cheap():
    start = time.time()
    ee.html_to_text("<blockquote>" * 20000)
    ee.html_to_text("<script>" * 20000)
    ee.html_to_text("<" * 50000)
    assert time.time() - start < 2


def test_a_long_run_of_address_characters_is_cheap():
    start = time.time()
    ee.parse_recipient("a" * 20000)
    m._extract_email_address("a" * 20000)
    assert time.time() - start < 1


def test_nested_quoted_replies_stay_out_of_the_text():
    html = "<p>Tiffany Xia, tiffany@virio.ai</p><blockquote>a<blockquote>b</blockquote>leak@z.com</blockquote>"
    text = ee.html_to_text(html)
    assert "tiffany@virio.ai" in text and "leak" not in text


# ---- reading a client's name and address ---------------------------------------------------------

@pytest.mark.parametrize("text,first,last", [
    ("Mary-Jane O'Brien, mj@client.io", "Mary-Jane", "O'Brien"),
    ("Tiffany Smith-Jones, t@client.io", "Tiffany", "Smith-Jones"),
    ("Dr. Tiffany Xia, t@client.io", "Tiffany", "Xia"),
    ("José García, t@client.io", "José", "García"),
    ("Renée Anne Smith, t@client.io", "Renée", "Anne Smith"),
    ("Tiffany Xia (CEO), t@client.io", "Tiffany", "Xia"),
    ("Tiffany Xia, Acme Corp, t@acme.com", "Tiffany", "Xia"),
    ("Can Yilmaz, t@client.io", "Can", "Yilmaz"),
    ("Marcus Go, t@client.io", "Marcus", "Go"),
    ("Please send it to Tiffany Xia at t@client.io", "Tiffany", "Xia"),
    ("First name: Tiffany Last name: Xia\nt@client.io", "Tiffany", "Xia"),
    ("Tiffany Xia <t@client.io>", "Tiffany", "Xia"),
    ("Tiffany Xia\nt@client.io", "Tiffany", "Xia"),
])
def test_names_are_read_correctly(text, first, last):
    got = ee.parse_recipient(text)
    assert (got["first_name"], got["last_name"]) == (first, last) and got["email"]


@pytest.mark.parametrize("text", [
    "t@client.io\nAaron Luan",         # a name below the address is the owner's signature
    "Hello Rotely\nt@client.io",       # a greeting is not the client
    "Hi there,\nt@client.io",
    "Tiffany, t@client.io",            # one name is not two
])
def test_unclear_names_are_left_blank_so_the_owner_is_asked(text):
    got = ee.parse_recipient(text)
    assert got["email"] and not (got["first_name"] and got["last_name"])


def test_placeholder_domains_match_on_the_domain_not_the_ending():
    assert ee.parse_recipient("Bob Lee, bob@bestexample.com")["email"] == "bob@bestexample.com"
    assert ee.parse_recipient("Bob Lee, bob@myexample.org")["email"] == "bob@myexample.org"
    for blocked in ("bob@example.com", "bob@mail.example.com", "bob@client.test", "bob@x.invalid", "bob@foo.example"):
        assert ee.parse_recipient("Bob Lee, " + blocked)["email"] == ""


# ---- a closed request does not quietly become a new draft ---------------------------------------

@pytest.mark.parametrize("status", ["failed", "generating", "done"])
def test_replying_to_a_closed_request_does_not_start_a_new_draft(flow, status):
    req = make_draft(flow)
    with Session(engine) as s:
        row = s.get(EmailDraftRequest, req.id)
        row.status = status
        s.add(row)
        s.commit()
        before = len(s.exec(select(EmailDraftRequest)).all())
    flow.mail.clear()
    r = send_in(flow, flow.owner_email, "Re: x", "Tiffany Xia, tiffany@virio.ai", to=continuation(flow, req.id))
    assert r.json() == {"ok": True}
    with Session(engine) as s:
        assert len(s.exec(select(EmailDraftRequest)).all()) == before
    assert [x["to"] for x in flow.mail] == [flow.owner_email] and "isn't waiting" in flow.mail[0]["body"]
