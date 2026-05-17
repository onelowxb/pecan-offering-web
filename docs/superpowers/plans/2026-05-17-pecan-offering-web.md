# Pecan Offering Web Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Netlify-hosted web app that lets Janie Narducci and Phil Walter upload either the Monday handwritten tally sheet or the Thursday EZ Tithe CSV and auto-post the resulting Deposit to QuickBooks Online via a FastAPI service on the Hostinger VPS — removing Ben from the routine weekly path.

**Architecture:** Plain-HTML/CSS/JS frontend on Netlify → HTTPS to FastAPI on VPS port 8090 (behind nginx + sslip TLS) → wraps the existing `quick-agent` engine. Auth = two-user shared password, signed-cookie session. Monday photo OCR is a new Anthropic vision call inside the backend (the existing engine has no OCR). Thursday CSV uses the engine's existing parser. Math validation gate kept; interactive name spot-check removed per the chosen auto-post flow.

**Tech Stack:**
- Frontend: HTML5, CSS3, vanilla JS (no framework), Netlify
- Backend: Python 3.11+, FastAPI, uvicorn, itsdangerous (signed cookies), python-multipart, anthropic SDK, pillow + pillow-heif (HEIC conversion), pytest, httpx
- Existing engine: `quick-agent` (Python) — moved to `/opt/quick-agent/` on VPS
- Infra: Hostinger VPS `76.13.126.85`, nginx, systemd, sslip.io TLS, QBO realm `9341455292146284`

**Spec reference:** `docs/superpowers/specs/2026-05-17-pecan-offering-web-design.md`

---

## File Structure

### Backend repo: `C:\Users\ben.holt\code\pecan-api\` (new repo, deploys to `/opt/pecan-api/` on VPS)

```
pecan-api/
├── main.py                 # FastAPI app + route handlers (≤120 lines)
├── auth.py                 # session cookie sign/verify + user check
├── dedupe.py               # SHA-256 hash + SQLite idempotency store
├── engine_bridge.py        # imports quick-agent, exposes process_monday/process_thursday
├── monday_ocr.py           # Anthropic vision call → CONTRIBUTIONS dict
├── errors.py               # engine error → user-friendly string mapping
├── logger.py               # append uploads.jsonl
├── requirements.txt
├── .env.example
├── conftest.py             # pytest fixtures
├── tests/
│   ├── test_auth.py
│   ├── test_dedupe.py
│   ├── test_monday_ocr.py
│   ├── test_engine_bridge.py
│   ├── test_errors.py
│   └── test_main.py        # endpoint tests w/ mocked engine
└── deploy/
    ├── pecan-api.service   # systemd unit
    ├── nginx-snippet.conf  # /pecan/ location block
    ├── install.sh          # one-shot VPS install
    └── qbo_reauth.py       # one-time OAuth dance on VPS
```

**Why this split:** each file has one job. `monday_ocr.py` and `dedupe.py` are independently testable without QBO or FastAPI. `engine_bridge.py` is the single seam where the existing `quick-agent` code is invoked — keeps imports of the legacy engine in one place and makes the rest of the backend mockable. `main.py` stays under ~120 lines and is mostly route plumbing.

### Frontend repo: `C:\Users\ben.holt\code\pecan-offering-web\` (already exists from spec phase, repo on GitHub)

```
pecan-offering-web/
├── index.html              # single-page (login + main + result divs)
├── style.css
├── app.js                  # state, API calls, screen show/hide
├── netlify.toml            # build + redirects + headers
└── docs/superpowers/{specs,plans}/
```

**Why this split:** v1 is three screens; SPA-style single HTML with show/hide divs is the simplest thing that works. No build step, no framework. ~150 lines of JS total.

---

## Task 1: Backend project scaffold

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\requirements.txt`
- Create: `C:\Users\ben.holt\code\pecan-api\.env.example`
- Create: `C:\Users\ben.holt\code\pecan-api\.gitignore`
- Create: `C:\Users\ben.holt\code\pecan-api\conftest.py`
- Create: `C:\Users\ben.holt\code\pecan-api\main.py` (stub)

- [ ] **Step 1: Make the directory and init git**

```bash
mkdir -p "/c/Users/ben.holt/code/pecan-api/tests" "/c/Users/ben.holt/code/pecan-api/deploy"
cd "/c/Users/ben.holt/code/pecan-api"
git init -q
python -m venv .venv
source .venv/Scripts/activate
```

- [ ] **Step 2: Write `requirements.txt`**

```
fastapi==0.115.*
uvicorn[standard]==0.32.*
itsdangerous==2.2.*
python-multipart==0.0.*
anthropic==0.40.*
pillow==11.*
pillow-heif==0.20.*
pytest==8.*
httpx==0.27.*
```

- [ ] **Step 3: Write `.env.example`**

```
# Session cookie signing key — generate with: python -c "import secrets; print(secrets.token_urlsafe(48))"
PECAN_SESSION_SECRET=replace-me

# Users + shared password (JSON). Rotate by editing this and restarting the service.
PECAN_USERS_JSON=[{"username":"Janie Narducci","display":"Janie"},{"username":"Phil Walter","display":"Phil"}]
PECAN_SHARED_PASSWORD=Pecan Offering

# Anthropic API key for Monday photo OCR
ANTHROPIC_API_KEY=sk-ant-...

# Allowed frontend origin (set after Netlify deploy)
PECAN_CORS_ORIGIN=https://pecan-offering-web.netlify.app

# Path to quick-agent engine (local dev = the Windows path; VPS = /opt/quick-agent)
QUICK_AGENT_DIR=C:\Users\ben.holt\code\quick-agent

# Where uploaded files are written (engine reads from here)
PECAN_INBOX_DIR=C:\Users\ben.holt\code\quick-agent\inbox

# Dedupe SQLite path
PECAN_DEDUPE_DB=C:\Users\ben.holt\code\pecan-api\posted_files.sqlite

# Upload log
PECAN_UPLOAD_LOG=C:\Users\ben.holt\code\quick-agent\logs\uploads.jsonl
```

- [ ] **Step 4: Write `.gitignore`**

```
.venv/
__pycache__/
*.pyc
.env
posted_files.sqlite
.pytest_cache/
```

- [ ] **Step 5: Write `conftest.py`**

```python
"""Shared pytest fixtures."""
import os
import tempfile
from pathlib import Path
import pytest

@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    """Provide a clean per-test env so tests never touch real config."""
    monkeypatch.setenv("PECAN_SESSION_SECRET", "test-secret-do-not-use")
    monkeypatch.setenv(
        "PECAN_USERS_JSON",
        '[{"username":"Janie Narducci","display":"Janie"},'
        '{"username":"Phil Walter","display":"Phil"}]',
    )
    monkeypatch.setenv("PECAN_SHARED_PASSWORD", "Pecan Offering")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("PECAN_CORS_ORIGIN", "https://example.test")
    monkeypatch.setenv("QUICK_AGENT_DIR", str(tmp_path / "engine"))
    monkeypatch.setenv("PECAN_INBOX_DIR", str(tmp_path / "inbox"))
    monkeypatch.setenv("PECAN_DEDUPE_DB", str(tmp_path / "dedupe.sqlite"))
    monkeypatch.setenv("PECAN_UPLOAD_LOG", str(tmp_path / "uploads.jsonl"))
    (tmp_path / "inbox").mkdir()
    (tmp_path / "engine").mkdir()
    yield
```

- [ ] **Step 6: Write `main.py` stub**

```python
"""Pecan Offering API — FastAPI app."""
from fastapi import FastAPI

app = FastAPI(title="Pecan Offering API")

@app.get("/health")
def health():
    return {"ok": True}
```

- [ ] **Step 7: Install deps and smoke-test**

```bash
pip install -r requirements.txt
uvicorn main:app --port 8090 &
sleep 1
curl -s http://127.0.0.1:8090/health
kill %1
```

Expected: `{"ok":true}`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold pecan-api FastAPI service"
```

---

## Task 2: Auth module (sign/verify session, validate credentials)

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\auth.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_auth.py`

- [ ] **Step 1: Write failing tests**

`tests/test_auth.py`:
```python
import auth

def test_valid_credentials_return_display_name():
    assert auth.check_credentials("Janie Narducci", "Pecan Offering") == "Janie"
    assert auth.check_credentials("Phil Walter", "Pecan Offering") == "Phil"

def test_invalid_username_returns_none():
    assert auth.check_credentials("Random Person", "Pecan Offering") is None

def test_invalid_password_returns_none():
    assert auth.check_credentials("Janie Narducci", "wrong") is None

def test_sign_and_verify_session_roundtrip():
    token = auth.sign_session("Janie")
    assert auth.verify_session(token) == "Janie"

def test_verify_rejects_tampered_token():
    token = auth.sign_session("Janie") + "x"
    assert auth.verify_session(token) is None

def test_verify_rejects_garbage():
    assert auth.verify_session("nonsense") is None
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
pytest tests/test_auth.py -v
```

Expected: all FAIL (no `auth` module yet).

- [ ] **Step 3: Implement `auth.py`**

```python
"""Credential check + signed session cookies."""
import json
import os
from itsdangerous import TimestampSigner, BadSignature, SignatureExpired

SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

def _signer():
    return TimestampSigner(os.environ["PECAN_SESSION_SECRET"])

def check_credentials(username: str, password: str) -> str | None:
    """Return display name on success, None on failure."""
    if password != os.environ["PECAN_SHARED_PASSWORD"]:
        return None
    for user in json.loads(os.environ["PECAN_USERS_JSON"]):
        if user["username"] == username:
            return user["display"]
    return None

def sign_session(display_name: str) -> str:
    return _signer().sign(display_name.encode()).decode()

def verify_session(token: str | None) -> str | None:
    if not token:
        return None
    try:
        raw = _signer().unsign(token.encode(), max_age=SESSION_MAX_AGE)
        return raw.decode()
    except (BadSignature, SignatureExpired):
        return None
```

- [ ] **Step 4: Re-run tests**

```bash
pytest tests/test_auth.py -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add auth.py tests/test_auth.py
git commit -m "feat(auth): credential check + signed session helpers"
```

---

## Task 3: Login endpoint

**Files:**
- Modify: `C:\Users\ben.holt\code\pecan-api\main.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_main.py`

- [ ] **Step 1: Add failing login tests**

`tests/test_main.py`:
```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_login_success_sets_cookie():
    r = client.post("/login", json={"username": "Janie Narducci", "password": "Pecan Offering"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "display_name": "Janie"}
    assert "pecan_session" in r.cookies

def test_login_wrong_password_returns_401():
    r = client.post("/login", json={"username": "Janie Narducci", "password": "nope"})
    assert r.status_code == 401
    assert r.json()["ok"] is False
    assert "pecan_session" not in r.cookies

def test_login_unknown_user_returns_401():
    r = client.post("/login", json={"username": "Stranger", "password": "Pecan Offering"})
    assert r.status_code == 401

def test_logout_clears_cookie():
    client.post("/login", json={"username": "Janie Narducci", "password": "Pecan Offering"})
    r = client.post("/logout")
    assert r.status_code == 200
    assert r.cookies.get("pecan_session") in (None, "")
```

- [ ] **Step 2: Run, confirm fail**

```bash
pytest tests/test_main.py -v
```

- [ ] **Step 3: Add login/logout to `main.py`**

```python
"""Pecan Offering API — FastAPI app."""
from fastapi import FastAPI, Response, Cookie, HTTPException
from pydantic import BaseModel
import auth

app = FastAPI(title="Pecan Offering API")

class LoginIn(BaseModel):
    username: str
    password: str

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/login")
def login(body: LoginIn, response: Response):
    display = auth.check_credentials(body.username, body.password)
    if not display:
        raise HTTPException(status_code=401, detail={"ok": False, "error": "Invalid credentials"})
    token = auth.sign_session(display)
    response.set_cookie(
        "pecan_session", token,
        max_age=auth.SESSION_MAX_AGE,
        httponly=True, secure=True, samesite="lax",
    )
    return {"ok": True, "display_name": display}

@app.post("/logout")
def logout(response: Response):
    response.delete_cookie("pecan_session")
    return {"ok": True}

def require_session(pecan_session: str | None = Cookie(default=None)) -> str:
    display = auth.verify_session(pecan_session)
    if not display:
        raise HTTPException(status_code=401, detail={"ok": False, "error": "Not signed in"})
    return display
```

Note: `HTTPException` with a dict `detail` returns `{"detail": {...}}` from FastAPI. The test expects `r.json()["ok"] is False`, so adjust either the assertion or use a custom exception handler. Simpler — use a custom handler:

Add at top of `main.py`:
```python
from fastapi.responses import JSONResponse
from fastapi.exceptions import HTTPException as _HTTPException

@app.exception_handler(_HTTPException)
def _handler(_req, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {"ok": False, "error": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=detail)
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
pytest tests/test_main.py -v
```

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_main.py
git commit -m "feat(api): login + logout endpoints with session cookie"
```

---

## Task 4: Dedupe module (SHA-256 + SQLite)

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\dedupe.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_dedupe.py`

- [ ] **Step 1: Failing tests**

`tests/test_dedupe.py`:
```python
import time
import dedupe

def test_hash_is_stable():
    assert dedupe.hash_bytes(b"abc") == dedupe.hash_bytes(b"abc")

def test_hash_differs_by_content():
    assert dedupe.hash_bytes(b"abc") != dedupe.hash_bytes(b"abd")

def test_unseen_returns_none():
    assert dedupe.previous_post(dedupe.hash_bytes(b"x")) is None

def test_record_and_lookup_returns_deposit_id():
    h = dedupe.hash_bytes(b"sheet-1")
    dedupe.record(h, deposit_id="11851")
    prev = dedupe.previous_post(h)
    assert prev == "11851"

def test_record_older_than_7_days_is_ignored():
    h = dedupe.hash_bytes(b"old-sheet")
    dedupe.record(h, deposit_id="11000", ts=time.time() - (8 * 86400))
    assert dedupe.previous_post(h) is None
```

- [ ] **Step 2: Run, confirm fail**

```bash
pytest tests/test_dedupe.py -v
```

- [ ] **Step 3: Implement `dedupe.py`**

```python
"""SHA-256 + SQLite-backed 7-day idempotency store."""
import hashlib
import os
import sqlite3
import time

WINDOW_SECONDS = 7 * 86400

def _conn():
    db = os.environ["PECAN_DEDUPE_DB"]
    c = sqlite3.connect(db)
    c.execute("""CREATE TABLE IF NOT EXISTS posted_files (
        hash TEXT PRIMARY KEY,
        deposit_id TEXT NOT NULL,
        posted_at REAL NOT NULL
    )""")
    return c

def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def previous_post(file_hash: str) -> str | None:
    cutoff = time.time() - WINDOW_SECONDS
    with _conn() as c:
        row = c.execute(
            "SELECT deposit_id FROM posted_files WHERE hash=? AND posted_at>=?",
            (file_hash, cutoff),
        ).fetchone()
    return row[0] if row else None

def record(file_hash: str, deposit_id: str, ts: float | None = None) -> None:
    ts = ts if ts is not None else time.time()
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO posted_files(hash, deposit_id, posted_at) VALUES(?,?,?)",
            (file_hash, deposit_id, ts),
        )
```

- [ ] **Step 4: Run, confirm pass**

```bash
pytest tests/test_dedupe.py -v
```

- [ ] **Step 5: Commit**

```bash
git add dedupe.py tests/test_dedupe.py
git commit -m "feat(dedupe): 7-day SHA-256 idempotency store"
```

---

## Task 5: Monday OCR (Anthropic vision)

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\monday_ocr.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_monday_ocr.py`

**Reference:** `C:\Users\ben.holt\.claude\skills\pecan-offering\references\extraction-schema.md` — the prompt below must instruct the model to emit JSON matching the `CONTRIBUTIONS` list shape that `offering_data.py` expects.

- [ ] **Step 1: Read the extraction schema**

```bash
cat "/c/Users/ben.holt/.claude/skills/pecan-offering/references/extraction-schema.md"
```

Copy the column list and example rows into the prompt below.

- [ ] **Step 2: Failing tests**

`tests/test_monday_ocr.py`:
```python
from unittest.mock import patch, MagicMock
import json
import monday_ocr

FAKE_API_JSON = {
    "service_date": "2026-05-12",
    "contributions": [
        {"donor": "Hamilton, Bill & Gennie", "fund": "Tithe", "payment": "Check", "check_num": "1234", "total": 100.00}
    ],
    "printed_totals": {"total_contributions": 100.00, "cash_total": 0.00, "check_total": 100.00},
}

def _mock_api_response(json_payload):
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(json_payload))]
    return msg

def test_extract_returns_structured_dict():
    with patch("monday_ocr._client") as m:
        m.return_value.messages.create.return_value = _mock_api_response(FAKE_API_JSON)
        result = monday_ocr.extract(b"fake-jpg-bytes", media_type="image/jpeg")
    assert result["service_date"] == "2026-05-12"
    assert result["contributions"][0]["donor"] == "Hamilton, Bill & Gennie"
    assert result["printed_totals"]["total_contributions"] == 100.00

def test_heic_is_converted_to_jpeg(tmp_path):
    # Verify we call Pillow's HEIF opener for HEIC bytes.
    with patch("monday_ocr._client") as m, patch("monday_ocr._heic_to_jpeg") as conv:
        conv.return_value = b"converted-jpeg-bytes"
        m.return_value.messages.create.return_value = _mock_api_response(FAKE_API_JSON)
        monday_ocr.extract(b"fake-heic-bytes", media_type="image/heic")
    conv.assert_called_once_with(b"fake-heic-bytes")

def test_invalid_json_response_raises():
    bad = MagicMock()
    bad.content = [MagicMock(text="not json at all")]
    with patch("monday_ocr._client") as m:
        m.return_value.messages.create.return_value = bad
        try:
            monday_ocr.extract(b"x", media_type="image/jpeg")
        except monday_ocr.OCRError:
            return
    raise AssertionError("expected OCRError")
```

- [ ] **Step 3: Run, confirm fail**

- [ ] **Step 4: Implement `monday_ocr.py`**

```python
"""Anthropic vision call: Monday tally sheet image -> structured CONTRIBUTIONS dict.

Replaces the human-driven 'Read tool + spot-check' step in the pecan-offering skill.
Auto-post path means we do NOT show a spot-check screen — math validation in the
engine is the only safety net for misreads.
"""
import base64
import io
import json
import os
from anthropic import Anthropic
from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()

class OCRError(Exception):
    pass

# Prompt distilled from ~/.claude/skills/pecan-offering/references/extraction-schema.md.
# When that schema changes, update this constant.
EXTRACTION_PROMPT = """You are reading a handwritten Pecan Baptist Church offering tally sheet.

Return ONLY a JSON object (no prose) with this exact shape:
{
  "service_date": "YYYY-MM-DD",
  "contributions": [
    {"donor": "Last, First & Spouse",
     "fund": "Tithe" | "Building Fund" | "Missions" | "<Missionary Name>" | "Convenience Fee",
     "payment": "Cash" | "Check",
     "check_num": "1234" or null,
     "total": 123.45}
  ],
  "printed_totals": {
    "total_contributions": 0.00,
    "cash_total": 0.00,
    "check_total": 0.00
  }
}

Rules:
- Transcribe the donor name exactly as written, in 'Last, First' format.
- 'fund' must match one of the listed strings; missionary lines use the missionary's name verbatim.
- check_num is null for cash lines.
- Read printed totals from the sheet's totals row. These are validation values.
- Do not infer or correct math — copy what's printed.
"""

def _client() -> Anthropic:
    return Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

def _heic_to_jpeg(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data))
    out = io.BytesIO()
    img.convert("RGB").save(out, format="JPEG", quality=90)
    return out.getvalue()

def extract(image_bytes: bytes, media_type: str) -> dict:
    if media_type == "image/heic":
        image_bytes = _heic_to_jpeg(image_bytes)
        media_type = "image/jpeg"

    b64 = base64.standard_b64encode(image_bytes).decode()
    msg = _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": EXTRACTION_PROMPT},
            ],
        }],
    )
    text = msg.content[0].text.strip()
    # Strip code fences if present.
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise OCRError(f"Model returned non-JSON: {e}") from e
```

- [ ] **Step 5: Run, confirm pass**

- [ ] **Step 6: Commit**

```bash
git add monday_ocr.py tests/test_monday_ocr.py
git commit -m "feat(ocr): Anthropic vision extraction for Monday tally sheet"
```

---

## Task 6: Engine bridge (wraps quick-agent for both flows)

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\engine_bridge.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_engine_bridge.py`

**Reading first:** the bridge has to know how the engine wants its inputs. Re-read these to confirm shape:

```bash
head -60 "/c/Users/ben.holt/code/quick-agent/offering_data.py"
head -60 "/c/Users/ben.holt/code/quick-agent/thursday_offering_data.py"
head -40 "/c/Users/ben.holt/code/quick-agent/post_offering.py"
head -40 "/c/Users/ben.holt/code/quick-agent/post_thursday.py"
head -40 "/c/Users/ben.holt/code/quick-agent/validate.py"
```

The bridge writes the parsed data into the engine's expected module files, then invokes the post script in-process. The engine writes to `posted.json`; capture the new entry to get the `DocNumber` and `Id`.

- [ ] **Step 1: Failing tests (with engine calls mocked at subprocess boundary)**

`tests/test_engine_bridge.py`:
```python
from pathlib import Path
from unittest.mock import patch, MagicMock
import engine_bridge

def test_process_thursday_returns_deposit_id(tmp_path):
    csv = tmp_path / "p.csv"
    csv.write_bytes(b"Date,Donor,Gross Gift\n2026-05-15,Smith John,50.00\n")
    fake_post = MagicMock(returncode=0, stdout="DocNumber: 11852\nId: 999\n", stderr="")
    with patch("engine_bridge._run_engine", return_value=fake_post), \
         patch("engine_bridge._write_thursday_data") as w:
        result = engine_bridge.process_thursday(csv)
    assert result == {"ok": True, "deposit_id": "11852"}
    w.assert_called_once()

def test_process_monday_runs_validate_then_post(tmp_path):
    parsed = {
        "service_date": "2026-05-12",
        "contributions": [{"donor": "Doe, Jane", "fund": "Tithe", "payment": "Cash", "check_num": None, "total": 50.0}],
        "printed_totals": {"total_contributions": 50.0, "cash_total": 50.0, "check_total": 0.0},
    }
    validate_ok = MagicMock(returncode=0, stdout="OK", stderr="")
    post_ok = MagicMock(returncode=0, stdout="DocNumber: 11851\nId: 888\n", stderr="")
    with patch("engine_bridge._run_engine", side_effect=[validate_ok, post_ok]), \
         patch("engine_bridge._write_monday_data") as w:
        result = engine_bridge.process_monday(parsed)
    assert result == {"ok": True, "deposit_id": "11851"}
    w.assert_called_once_with(parsed)

def test_monday_validate_failure_short_circuits():
    parsed = {"service_date": "2026-05-12", "contributions": [], "printed_totals": {}}
    bad = MagicMock(returncode=1, stdout="", stderr="column total mismatch")
    with patch("engine_bridge._run_engine", return_value=bad), \
         patch("engine_bridge._write_monday_data"):
        result = engine_bridge.process_monday(parsed)
    assert result["ok"] is False
    assert "validation" in result["error"].lower() or "mismatch" in result["error"].lower()

def test_thursday_engine_nonzero_exit_returns_error(tmp_path):
    csv = tmp_path / "p.csv"
    csv.write_bytes(b"x")
    bad = MagicMock(returncode=2, stdout="", stderr="boom")
    with patch("engine_bridge._run_engine", return_value=bad), \
         patch("engine_bridge._write_thursday_data"):
        result = engine_bridge.process_thursday(csv)
    assert result["ok"] is False
    assert result["error"]
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Implement `engine_bridge.py`**

```python
"""Bridge between the FastAPI app and the existing quick-agent engine.

The engine reads from offering_data.py / thursday_offering_data.py and writes
posts via post_offering.py / post_thursday.py. The bridge:
  1. Writes uploaded data into the engine's expected data module.
  2. Runs validate.py (Monday) — abort if column sums disagree.
  3. Runs the post script with --live.
  4. Parses DocNumber from stdout and returns it.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

DEPOSIT_RE = re.compile(r"DocNumber[:\s]+(\d+)", re.IGNORECASE)

def _engine_dir() -> Path:
    return Path(os.environ["QUICK_AGENT_DIR"])

def _run_engine(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, script, *args],
        cwd=_engine_dir(),
        capture_output=True,
        text=True,
        timeout=120,
    )

def _write_monday_data(parsed: dict) -> None:
    """Render parsed dict into offering_data.py."""
    path = _engine_dir() / "offering_data.py"
    lines = [
        '"""Auto-generated by pecan-api. Do not edit by hand."""',
        f'SERVICE_DATE = "{parsed["service_date"]}"',
        'SHEET_SOURCE = "pecan-api upload"',
        "CONTRIBUTIONS = [",
    ]
    for c in parsed["contributions"]:
        check = f'"{c["check_num"]}"' if c.get("check_num") else "None"
        donor = c["donor"].replace('"', '\\"')
        fund = c["fund"].replace('"', '\\"')
        lines.append(
            f'    {{"donor": "{donor}", "fund": "{fund}", '
            f'"payment": "{c["payment"]}", "check_num": {check}, '
            f'"total": {float(c["total"]):.2f}}},'
        )
    lines.append("]")
    pt = parsed["printed_totals"]
    lines.append("PRINTED_TOTALS = {")
    for k, v in pt.items():
        lines.append(f'    "{k}": {float(v):.2f},')
    lines.append("}")
    path.write_text("\n".join(lines), encoding="utf-8")

def _write_thursday_data(csv_path: Path) -> None:
    """Invoke the engine's existing CSV parser to populate thursday_offering_data.py."""
    proc = _run_engine("parse_thursday_csv.py", str(csv_path))
    if proc.returncode != 0:
        raise RuntimeError(f"parse_thursday_csv failed: {proc.stderr}")

def _extract_deposit_id(stdout: str) -> str | None:
    m = DEPOSIT_RE.search(stdout)
    return m.group(1) if m else None

def process_monday(parsed: dict) -> dict:
    _write_monday_data(parsed)
    v = _run_engine("validate.py")
    if v.returncode != 0:
        return {"ok": False, "error": f"validation: {(v.stderr or v.stdout).strip()[:300]}"}
    p = _run_engine("post_offering.py", "--live")
    if p.returncode != 0:
        return {"ok": False, "error": (p.stderr or p.stdout).strip()[:300]}
    dep = _extract_deposit_id(p.stdout)
    if not dep:
        return {"ok": False, "error": "post succeeded but no DocNumber in output"}
    return {"ok": True, "deposit_id": dep}

def process_thursday(csv_path: Path) -> dict:
    try:
        _write_thursday_data(csv_path)
    except RuntimeError as e:
        return {"ok": False, "error": str(e)[:300]}
    p = _run_engine("post_thursday.py", "--live")
    if p.returncode != 0:
        return {"ok": False, "error": (p.stderr or p.stdout).strip()[:300]}
    dep = _extract_deposit_id(p.stdout)
    if not dep:
        return {"ok": False, "error": "post succeeded but no DocNumber in output"}
    return {"ok": True, "deposit_id": dep}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Spot-check the engine's actual stdout format**

```bash
# On Ben's PC, where the engine works:
cd "/c/Users/ben.holt/code/quick-agent"
# Use a known-posted hash to trigger the idempotency message OR run a dry-run:
python post_offering.py 2>&1 | grep -iE "doc|id" | head -5
```

If the engine prints `DocNumber: 11851` literally → regex matches → leave as-is. If it prints differently (e.g., `Created Deposit #11851`), update `DEPOSIT_RE` and rerun tests.

- [ ] **Step 6: Commit**

```bash
git add engine_bridge.py tests/test_engine_bridge.py
git commit -m "feat(bridge): wrap quick-agent engine for monday/thursday processing"
```

---

## Task 7: Error mapping

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\errors.py`
- Create: `C:\Users\ben.holt\code\pecan-api\tests\test_errors.py`

- [ ] **Step 1: Failing tests**

`tests/test_errors.py`:
```python
import errors

def test_validation_error_maps_to_friendly():
    msg = errors.friendly("validation: column total mismatch on cash")
    assert msg == "Couldn't read the photo — try a clearer one."

def test_csv_parse_error_maps_to_friendly():
    msg = errors.friendly("parse_thursday_csv failed: bad header row")
    assert msg == "That CSV doesn't look like an EZ Tithe export."

def test_qbo_401_maps_to_token_refresh():
    msg = errors.friendly("QBO 401 Unauthorized")
    assert "text Ben" in msg

def test_qbo_5xx_maps_to_retry():
    msg = errors.friendly("QBO 503 Service Unavailable")
    assert "try again" in msg.lower()

def test_unknown_error_maps_to_generic():
    msg = errors.friendly("something exploded")
    assert "text Ben" in msg
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Implement `errors.py`**

```python
"""Map raw engine errors to plain-English strings shown to mom/Phil."""

_PATTERNS = [
    ("validation",                   "Couldn't read the photo — try a clearer one."),
    ("column total mismatch",        "Couldn't read the photo — try a clearer one."),
    ("parse_thursday_csv",           "That CSV doesn't look like an EZ Tithe export."),
    ("bad header",                   "That CSV doesn't look like an EZ Tithe export."),
    ("qbo 401",                      "QuickBooks connection needs a refresh — text Ben."),
    ("token",                        "QuickBooks connection needs a refresh — text Ben."),
    ("qbo 5",                        "QuickBooks is having issues — try again in a minute."),
    ("qbo 503",                      "QuickBooks is having issues — try again in a minute."),
]

GENERIC = "Something went wrong — text Ben."

def friendly(raw: str) -> str:
    low = (raw or "").lower()
    for needle, msg in _PATTERNS:
        if needle in low:
            return msg
    return GENERIC
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add errors.py tests/test_errors.py
git commit -m "feat(errors): map engine errors to user-friendly strings"
```

---

## Task 8: Upload logger

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\logger.py`

- [ ] **Step 1: Implement (trivial, one-line)**

```python
"""Append-only JSONL audit log for every upload."""
import json
import os
import time
from pathlib import Path

def record(user: str, file_type: str, filename: str, result: dict) -> None:
    path = Path(os.environ["PECAN_UPLOAD_LOG"])
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.time(),
        "user": user,
        "type": file_type,
        "filename": filename,
        "ok": bool(result.get("ok")),
        "deposit_id": result.get("deposit_id"),
        "error": result.get("error"),
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
```

- [ ] **Step 2: One sanity test**

`tests/test_logger.py`:
```python
import json, os
import logger

def test_record_appends_line():
    logger.record("Janie", "monday", "sheet.jpg", {"ok": True, "deposit_id": "11851"})
    logger.record("Phil", "thursday", "p.csv", {"ok": False, "error": "boom"})
    with open(os.environ["PECAN_UPLOAD_LOG"]) as f:
        lines = [json.loads(l) for l in f]
    assert len(lines) == 2
    assert lines[0]["deposit_id"] == "11851"
    assert lines[1]["error"] == "boom"
```

- [ ] **Step 3: Run, confirm pass + commit**

```bash
pytest tests/test_logger.py -v
git add logger.py tests/test_logger.py
git commit -m "feat(logger): jsonl audit log for uploads"
```

---

## Task 9: Upload endpoint — wire everything together

**Files:**
- Modify: `C:\Users\ben.holt\code\pecan-api\main.py`
- Modify: `C:\Users\ben.holt\code\pecan-api\tests\test_main.py`

- [ ] **Step 1: Failing tests for upload endpoint**

Add to `tests/test_main.py`:
```python
from unittest.mock import patch

def _signed_in_client():
    c = TestClient(app)
    c.post("/login", json={"username": "Janie Narducci", "password": "Pecan Offering"})
    return c

def test_upload_requires_auth():
    r = TestClient(app).post("/upload",
        files={"file": ("x.csv", b"hi", "text/csv")}, data={"type": "thursday"})
    assert r.status_code == 401

def test_upload_thursday_success():
    c = _signed_in_client()
    with patch("main.engine_bridge.process_thursday",
               return_value={"ok": True, "deposit_id": "11852"}):
        r = c.post("/upload",
            files={"file": ("p.csv", b"Date,Donor\n2026-05-15,Smith", "text/csv")},
            data={"type": "thursday"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "deposit_id": "11852"}

def test_upload_monday_success_runs_ocr_then_engine():
    c = _signed_in_client()
    parsed = {"service_date": "2026-05-12", "contributions": [], "printed_totals": {}}
    with patch("main.monday_ocr.extract", return_value=parsed) as ocr, \
         patch("main.engine_bridge.process_monday",
               return_value={"ok": True, "deposit_id": "11851"}) as eng:
        r = c.post("/upload",
            files={"file": ("sheet.jpg", b"\xff\xd8fake", "image/jpeg")},
            data={"type": "monday"})
    assert r.status_code == 200
    assert r.json()["deposit_id"] == "11851"
    ocr.assert_called_once()
    eng.assert_called_once_with(parsed)

def test_upload_thursday_with_wrong_extension_rejected():
    c = _signed_in_client()
    r = c.post("/upload",
        files={"file": ("sheet.jpg", b"x", "image/jpeg")},
        data={"type": "thursday"})
    assert r.status_code == 400

def test_upload_duplicate_returns_friendly_error():
    c = _signed_in_client()
    body = b"Date,Donor\n2026-05-15,Smith"
    with patch("main.engine_bridge.process_thursday",
               return_value={"ok": True, "deposit_id": "11852"}):
        c.post("/upload", files={"file": ("p.csv", body, "text/csv")}, data={"type": "thursday"})
    # Second upload of identical bytes → blocked by dedupe
    r = c.post("/upload", files={"file": ("p.csv", body, "text/csv")}, data={"type": "thursday"})
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "already posted" in r.json()["error"].lower()

def test_upload_engine_failure_returns_friendly_error():
    c = _signed_in_client()
    with patch("main.monday_ocr.extract", return_value={"service_date":"x","contributions":[],"printed_totals":{}}), \
         patch("main.engine_bridge.process_monday",
               return_value={"ok": False, "error": "validation: column total mismatch"}):
        r = c.post("/upload",
            files={"file": ("sheet.jpg", b"x", "image/jpeg")},
            data={"type": "monday"})
    assert r.json()["ok"] is False
    assert r.json()["error"] == "Couldn't read the photo — try a clearer one."
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Add upload endpoint to `main.py`**

Add to imports:
```python
import os
from pathlib import Path
from datetime import datetime
from fastapi import UploadFile, File, Form, Depends
import dedupe, engine_bridge, monday_ocr, errors, logger
```

Add the endpoint:
```python
ALLOWED = {
    "monday":   {"image/jpeg", "image/png", "application/pdf", "image/heic"},
    "thursday": {"text/csv", "application/vnd.ms-excel", "application/octet-stream"},  # browsers vary on CSV mimetype
}
EXT = {
    "monday":   {".jpg", ".jpeg", ".png", ".pdf", ".heic"},
    "thursday": {".csv"},
}

@app.post("/upload")
async def upload(
    type: str = Form(...),
    file: UploadFile = File(...),
    display: str = Depends(require_session),
):
    if type not in ALLOWED:
        raise _HTTPException(status_code=400, detail={"ok": False, "error": "Unknown upload type"})
    ext = Path(file.filename or "").suffix.lower()
    if ext not in EXT[type]:
        raise _HTTPException(status_code=400, detail={"ok": False, "error": f"Wrong file type for {type} upload"})

    data = await file.read()
    h = dedupe.hash_bytes(data)
    prior = dedupe.previous_post(h)
    if prior:
        result = {"ok": False, "error": f"Looks like this file was already posted (Deposit #{prior})."}
        logger.record(display, type, file.filename or "", result)
        return result

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    inbox = Path(os.environ["PECAN_INBOX_DIR"])
    inbox.mkdir(parents=True, exist_ok=True)
    saved = inbox / f"{type}-{stamp}{ext}"
    saved.write_bytes(data)

    if type == "monday":
        media = "image/heic" if ext == ".heic" else ("application/pdf" if ext == ".pdf" else "image/jpeg" if ext in {".jpg",".jpeg"} else "image/png")
        try:
            parsed = monday_ocr.extract(data, media_type=media)
        except monday_ocr.OCRError as e:
            result = {"ok": False, "error": errors.friendly(str(e))}
            logger.record(display, type, file.filename or "", result)
            return result
        result = engine_bridge.process_monday(parsed)
    else:
        result = engine_bridge.process_thursday(saved)

    if result.get("ok"):
        dedupe.record(h, deposit_id=result["deposit_id"])
        logger.record(display, type, file.filename or "", result)
        return result

    friendly = {"ok": False, "error": errors.friendly(result.get("error", ""))}
    logger.record(display, type, file.filename or "", friendly)
    return friendly
```

- [ ] **Step 4: Run, confirm all tests pass**

```bash
pytest -v
```

- [ ] **Step 5: Commit**

```bash
git add main.py tests/test_main.py
git commit -m "feat(api): /upload endpoint with dedupe, ocr, engine, logging"
```

---

## Task 10: CORS

**Files:**
- Modify: `C:\Users\ben.holt\code\pecan-api\main.py`

- [ ] **Step 1: Add CORS middleware**

At top of `main.py`:
```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("PECAN_CORS_ORIGIN", "*")],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
```

- [ ] **Step 2: Add test confirming origin is reflected**

In `tests/test_main.py`:
```python
def test_cors_origin_reflected_in_preflight():
    r = TestClient(app).options(
        "/login",
        headers={
            "Origin": "https://example.test",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "https://example.test"
```

- [ ] **Step 3: Run + commit**

```bash
pytest -v
git add main.py tests/test_main.py
git commit -m "feat(api): CORS locked to PECAN_CORS_ORIGIN"
```

---

## Task 11: Frontend HTML + CSS

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-offering-web\index.html`
- Create: `C:\Users\ben.holt\code\pecan-offering-web\style.css`

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pecan Offering</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <main id="login-screen" class="screen">
    <h1>Pecan Offering</h1>
    <p>Sign in to post the weekly offering.</p>
    <form id="login-form">
      <label>Who are you?
        <select name="username" required>
          <option value="">— pick one —</option>
          <option>Janie Narducci</option>
          <option>Phil Walter</option>
        </select>
      </label>
      <label>Password
        <input type="password" name="password" required autocomplete="current-password">
      </label>
      <button type="submit">Sign in</button>
      <p class="error" id="login-error" hidden></p>
    </form>
  </main>

  <main id="main-screen" class="screen" hidden>
    <header>
      <h1>Hi <span id="display-name"></span></h1>
      <button id="signout" class="link">Sign out</button>
    </header>
    <p>Pick what you're uploading.</p>
    <div class="actions">
      <button class="big" data-type="monday">📄 Upload Monday Tally Sheet</button>
      <button class="big" data-type="thursday">📊 Upload Thursday EZ Tithe CSV</button>
    </div>
    <input type="file" id="picker-monday"   accept=".jpg,.jpeg,.png,.pdf,.heic" hidden>
    <input type="file" id="picker-thursday" accept=".csv" hidden>
  </main>

  <main id="busy-screen" class="screen" hidden>
    <div class="spinner"></div>
    <p>Posting to QuickBooks…</p>
  </main>

  <main id="result-screen" class="screen" hidden>
    <div id="result-ok" hidden>
      <div class="check">✓</div>
      <h1>Posted to QuickBooks.</h1>
      <p>Deposit #<span id="deposit-id"></span></p>
    </div>
    <div id="result-fail" hidden>
      <div class="x">✕</div>
      <h1>That didn't work.</h1>
      <p id="result-error"></p>
    </div>
    <button id="again">Upload another</button>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `style.css`**

```css
:root {
  --bg: #f7f5ef; --fg: #2a2a2a; --accent: #6b8e23; --err: #b03a2e;
  --card: #fff; --border: #d8d4c8;
}
* { box-sizing: border-box }
body {
  margin: 0; font: 17px/1.5 system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
  min-height: 100vh; display: grid; place-items: center; padding: 24px;
}
.screen { width: 100%; max-width: 480px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
h1 { margin: 0 0 12px; font-size: 28px; }
header { display: flex; justify-content: space-between; align-items: center; }
label { display: block; margin: 16px 0; }
input, select { width: 100%; padding: 10px; font: inherit; border: 1px solid var(--border); border-radius: 6px; margin-top: 4px; }
button { font: inherit; padding: 12px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
button.big { display: block; width: 100%; padding: 24px; margin: 12px 0; font-size: 18px; text-align: left; }
button.link { background: transparent; color: var(--accent); padding: 0; text-decoration: underline; }
.actions { margin-top: 16px; }
.error { color: var(--err); }
.spinner { width: 36px; height: 36px; border: 4px solid var(--border); border-top-color: var(--accent); border-radius: 50%; margin: 24px auto; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg) } }
.check { font-size: 64px; color: var(--accent); text-align: center; }
.x { font-size: 64px; color: var(--err); text-align: center; }
```

- [ ] **Step 3: Open `index.html` in a browser; eyeball login + main screens**

```bash
start "" "/c/Users/ben.holt/code/pecan-offering-web/index.html"   # Windows
```

Expected: login screen renders; buttons present; nothing is wired up yet.

- [ ] **Step 4: Commit**

```bash
cd "/c/Users/ben.holt/code/pecan-offering-web"
git add index.html style.css
git commit -m "feat(web): static HTML + CSS for login, main, busy, result"
```

---

## Task 12: Frontend JS — login + upload + result

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-offering-web\app.js`

- [ ] **Step 1: Write `app.js`**

```javascript
// API base set at deploy time by Netlify build env (or fallback for local dev).
const API_BASE = window.PECAN_API_BASE || "https://76-13-126-85.sslip.io/pecan";

const screens = ["login", "main", "busy", "result"];
function show(name) {
  for (const s of screens) document.getElementById(s + "-screen").hidden = (s !== name);
}

async function post(path, body, isForm) {
  const opts = { method: "POST", credentials: "include" };
  if (isForm) {
    opts.body = body;
  } else {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const err = document.getElementById("login-error");
  err.hidden = true;
  const { status, body } = await post("/login", {
    username: fd.get("username"),
    password: fd.get("password"),
  });
  if (status === 200 && body.ok) {
    document.getElementById("display-name").textContent = body.display_name;
    show("main");
  } else {
    err.textContent = "That didn't work, try again.";
    err.hidden = false;
  }
});

document.getElementById("signout").addEventListener("click", async () => {
  await post("/logout", {});
  show("login");
});

for (const btn of document.querySelectorAll("button.big")) {
  btn.addEventListener("click", () => {
    document.getElementById("picker-" + btn.dataset.type).click();
  });
}

for (const type of ["monday", "thursday"]) {
  document.getElementById("picker-" + type).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    show("busy");
    const fd = new FormData();
    fd.append("type", type);
    fd.append("file", file);
    const { status, body } = await post("/upload", fd, true);
    e.target.value = ""; // reset picker so same file can be re-tried
    const ok = document.getElementById("result-ok");
    const fail = document.getElementById("result-fail");
    if (status === 200 && body.ok) {
      ok.hidden = false; fail.hidden = true;
      document.getElementById("deposit-id").textContent = body.deposit_id;
    } else {
      ok.hidden = true; fail.hidden = false;
      document.getElementById("result-error").textContent =
        body.error || "Something went wrong — text Ben.";
    }
    show("result");
  });
}

document.getElementById("again").addEventListener("click", () => show("main"));
```

- [ ] **Step 2: Commit**

```bash
git add app.js
git commit -m "feat(web): login, upload, result wiring"
```

---

## Task 13: Netlify config

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-offering-web\netlify.toml`

- [ ] **Step 1: Write `netlify.toml`**

```toml
[build]
  publish = "."
  # No build step — static files only.

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

- [ ] **Step 2: Commit + push to GitHub**

```bash
git add netlify.toml
git commit -m "chore(web): netlify config"
gh repo create onelowxb/pecan-offering-web --public --source=. --push
```

- [ ] **Step 3: Wire Netlify to the repo**

In the Netlify UI (manual step):
1. Add new site from Git → pick `pecan-offering-web`
2. Build command: empty
3. Publish directory: `.`
4. Deploy
5. Record the assigned URL (e.g., `https://pecan-offering-web.netlify.app`) — needed for backend `PECAN_CORS_ORIGIN`.

---

## Task 14: Local integration smoke test against QBO sandbox

This is a manual checkpoint, not a coded task. Confirms the wired-up system works against the existing sandbox before we touch the VPS.

- [ ] **Step 1: Point engine at sandbox**

```bash
cd "/c/Users/ben.holt/code/quick-agent"
cp tokens.sandbox.json tokens.json   # or however the engine is configured to switch
```

- [ ] **Step 2: Boot backend locally**

```bash
cd "/c/Users/ben.holt/code/pecan-api"
cp .env.example .env
# Fill in real ANTHROPIC_API_KEY; generate a fresh PECAN_SESSION_SECRET; leave QBO_REFRESH_TOKEN unset (engine handles its own).
uvicorn main:app --port 8090
```

- [ ] **Step 3: Boot frontend locally**

In another shell:
```bash
cd "/c/Users/ben.holt/code/pecan-offering-web"
# Override the API base for local dev:
cat > local-config.js <<'EOF'
window.PECAN_API_BASE = "http://127.0.0.1:8090";
EOF
# Edit index.html to add <script src="local-config.js"></script> ABOVE app.js
python -m http.server 5173
```

- [ ] **Step 4: In browser at http://127.0.0.1:5173**

- Sign in as Janie / `Pecan Offering`
- Upload a known Monday tally sheet photo → expect green check + sandbox DocNumber
- Upload a known Thursday EZ Tithe CSV → expect green check + sandbox DocNumber
- Verify both in the QBO sandbox UI

- [ ] **Step 5: Revert local-config and engine to prod**

```bash
cd "/c/Users/ben.holt/code/quick-agent"
git checkout tokens.json   # or restore prod tokens
cd "/c/Users/ben.holt/code/pecan-offering-web"
rm local-config.js
# revert index.html script tag edit
```

Don't commit `local-config.js` or the script-tag edit.

---

## Task 15: VPS — move quick-agent + re-auth QBO

- [ ] **Step 1: SSH to VPS and create dirs**

```bash
ssh root@76.13.126.85 << 'EOF'
mkdir -p /opt/quick-agent /opt/pecan-api
useradd -r -s /usr/sbin/nologin pecan 2>/dev/null || true
EOF
```

- [ ] **Step 2: Copy engine**

From Ben's PC:
```bash
cd "/c/Users/ben.holt/code"
tar --exclude='__pycache__' --exclude='.venv' --exclude='*.pyc' --exclude='tokens.json' --exclude='tokens.sandbox.json' -czf qa.tgz quick-agent
scp qa.tgz root@76.13.126.85:/tmp/
ssh root@76.13.126.85 'tar -xzf /tmp/qa.tgz -C /opt/ && chown -R pecan:pecan /opt/quick-agent && rm /tmp/qa.tgz'
rm qa.tgz
```

- [ ] **Step 3: Install engine deps on VPS**

```bash
ssh root@76.13.126.85 << 'EOF'
cd /opt/quick-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # whatever the engine needs; add a requirements.txt if missing
EOF
```

- [ ] **Step 4: Re-auth QBO from the VPS**

Write `deploy/qbo_reauth.py` (in the pecan-api repo) that mirrors `quick-agent/oauth_init.py` and prints the new refresh token. Run it on the VPS:

```bash
ssh -L 8001:127.0.0.1:8001 root@76.13.126.85
# inside VPS:
cd /opt/quick-agent
.venv/bin/python oauth_init.py
# Open the printed URL on your laptop (port-forwarded), grant Pecan Baptist Church, capture refresh token.
# Token lands in /opt/quick-agent/tokens.json — verify realm is 9341455292146284.
```

- [ ] **Step 5: Sanity check the engine in place**

```bash
ssh root@76.13.126.85 'cd /opt/quick-agent && .venv/bin/python -c "import qbo; print(qbo.company_info())"'
```

Expected: prints `{"CompanyName":"Pecan Baptist Church", ...}` or similar.

---

## Task 16: VPS — deploy pecan-api

**Files:**
- Create: `C:\Users\ben.holt\code\pecan-api\deploy\pecan-api.service`
- Create: `C:\Users\ben.holt\code\pecan-api\deploy\nginx-snippet.conf`
- Create: `C:\Users\ben.holt\code\pecan-api\deploy\install.sh`

- [ ] **Step 1: Write `deploy/pecan-api.service`**

```ini
[Unit]
Description=Pecan Offering API
After=network.target

[Service]
Type=simple
User=pecan
Group=pecan
WorkingDirectory=/opt/pecan-api
EnvironmentFile=/opt/pecan-api/.env
ExecStart=/opt/pecan-api/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8090
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `deploy/nginx-snippet.conf`**

```nginx
location /pecan/ {
    proxy_pass http://127.0.0.1:8090/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 25M;
    proxy_read_timeout 120s;
}
```

- [ ] **Step 3: Write `deploy/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET=/opt/pecan-api
cd "$(dirname "$0")/.."

rsync -a --delete \
  --exclude='.venv' --exclude='__pycache__' --exclude='.pytest_cache' \
  --exclude='tests' --exclude='.env' --exclude='posted_files.sqlite' \
  ./ root@76.13.126.85:$TARGET/

ssh root@76.13.126.85 << 'EOF'
set -euo pipefail
cd /opt/pecan-api
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
chown -R pecan:pecan /opt/pecan-api
cp deploy/pecan-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pecan-api
systemctl restart pecan-api
sleep 1
curl -s http://127.0.0.1:8090/health
EOF
```

- [ ] **Step 4: Create the prod `.env` on the VPS**

```bash
ssh root@76.13.126.85 << 'EOF'
cat > /opt/pecan-api/.env << 'ENV'
PECAN_SESSION_SECRET=<generated>
PECAN_USERS_JSON=[{"username":"Janie Narducci","display":"Janie"},{"username":"Phil Walter","display":"Phil"}]
PECAN_SHARED_PASSWORD=Pecan Offering
ANTHROPIC_API_KEY=<from Ben's vault>
PECAN_CORS_ORIGIN=https://pecan-offering-web.netlify.app
QUICK_AGENT_DIR=/opt/quick-agent
PECAN_INBOX_DIR=/opt/quick-agent/inbox
PECAN_DEDUPE_DB=/opt/pecan-api/posted_files.sqlite
PECAN_UPLOAD_LOG=/opt/quick-agent/logs/uploads.jsonl
ENV
chown pecan:pecan /opt/pecan-api/.env
chmod 600 /opt/pecan-api/.env
mkdir -p /opt/quick-agent/inbox /opt/quick-agent/logs
chown -R pecan:pecan /opt/quick-agent/inbox /opt/quick-agent/logs
EOF
```

Generate secret first: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

- [ ] **Step 5: Run installer**

```bash
chmod +x deploy/install.sh
./deploy/install.sh
```

Expected final line: `{"ok":true}`.

- [ ] **Step 6: Wire nginx**

```bash
ssh root@76.13.126.85 << 'EOF'
# Add the snippet to the existing sslip server block — exact file location depends on current setup.
# Find the right file:
grep -lr '76-13-126-85.sslip.io' /etc/nginx/
# Then edit that file to include the location /pecan/ block inside the server { ... }.
nginx -t && systemctl reload nginx
EOF
```

- [ ] **Step 7: Smoke test through nginx**

```bash
curl -s https://76-13-126-85.sslip.io/pecan/health
```

Expected: `{"ok":true}`.

- [ ] **Step 8: Commit deploy files**

```bash
cd "/c/Users/ben.holt/code/pecan-api"
git add deploy/
git commit -m "chore(deploy): systemd unit, nginx snippet, install script"
```

---

## Task 17: End-to-end dry run against QBO sandbox from the live Netlify URL

- [ ] **Step 1: Point VPS engine at sandbox** (one-time, before exposing to mom/Phil)

```bash
ssh root@76.13.126.85 'cd /opt/quick-agent && cp tokens.sandbox.json tokens.json && systemctl restart pecan-api'
```

If no sandbox tokens exist on the VPS yet, re-run `oauth_init.py` against the sandbox app first.

- [ ] **Step 2: From the Netlify URL, sign in and upload one Monday + one Thursday file**

- Expect deposits land in the QBO sandbox.
- Verify totals match what you'd post manually.

- [ ] **Step 3: Check the upload log**

```bash
ssh root@76.13.126.85 'tail -5 /opt/quick-agent/logs/uploads.jsonl'
```

Should show your two test uploads, both `"ok": true`.

---

## Task 18: Production cutover

- [ ] **Step 1: Swap to prod QBO realm**

```bash
ssh root@76.13.126.85 'cd /opt/quick-agent && cp tokens.prod.json tokens.json && systemctl restart pecan-api'
```

(Or whatever filename you stashed the prod refresh token under in Task 15.)

- [ ] **Step 2: Ben uploads one known-good Monday sheet himself from the Netlify URL**

- Verify the deposit in QBO matches what `/pecan-offering` would have produced manually.
- If anything looks off → `systemctl stop pecan-api` and investigate.

- [ ] **Step 3: Ben uploads one known-good Thursday CSV himself**

- Same verification.

- [ ] **Step 4: Hand off**

- Telegram Janie + Phil:
  - URL: `https://pecan-offering-web.netlify.app`
  - Username: their name from the dropdown
  - Password: `Pecan Offering`
  - "Two buttons — pick the one that matches what you have, upload, you're done."

- [ ] **Step 5: Update vault memory**

```bash
# Add a one-liner to MEMORY.md under Active Projects:
# - [Pecan Offering Web](memory/pecan-offering-web.md) — LIVE since YYYY-MM-DD. Janie & Phil self-serve via Netlify; VPS pecan-api wraps quick-agent. URL + creds in [...]. Kill switch: `systemctl stop pecan-api`.
```

---

## Out of scope (do not build)

Restated from spec — these are deliberate v1 omissions:

- History/audit view for end users
- Email receipts after posting
- Admin panel / settings UI
- Multi-church / multi-tenant
- Password reset flow
- Telegram alerts on failure (Q5: A)
- Preview-then-confirm (Q2: A)
- Double-extract OCR safety net (raised during planning, Ben chose A)

## Rollback

If anything goes wrong post-launch:
```bash
ssh root@76.13.126.85 'systemctl stop pecan-api'
```
Netlify frontend shows a network error. Ben falls back to running `/pecan-offering` locally as today. Every upload is logged to `/opt/quick-agent/logs/uploads.jsonl` so no data is lost.
