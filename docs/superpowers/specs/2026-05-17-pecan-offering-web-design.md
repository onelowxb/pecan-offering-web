# Pecan Offering Web — Design Spec

**Date:** 2026-05-17
**Status:** Draft for review
**Owner:** Ben Holt
**Users:** Janie Narducci, Phil Walter (Pecan Baptist Church bookkeeping volunteers)

## Purpose

Give Janie and Phil a self-serve web app to post the weekly Pecan Baptist Church offerings to QuickBooks Online — without Ben in the loop for every deposit. Today Ben runs `/pecan-offering` locally on his PC; the goal is to remove Ben from the routine path while keeping the existing `quick-agent` engine as the posting brain.

**Measurable outcome:** Janie or Phil can post both the Monday handwritten tally and the Thursday EZ Tithe CSV from a browser, with no involvement from Ben, for four consecutive weeks.

## Non-goals

Explicitly out of scope for v1:

- History or audit view for end users
- Email receipts after posting
- Admin panel / settings UI
- Multi-church / multi-tenant support
- Password reset flow (Ben rotates manually if needed)
- Telegram alerts on failure
- Preview-then-confirm step (auto-post is the chosen flow)

## Architecture

```
┌─────────────────────┐        HTTPS         ┌────────────────────────────┐
│  Netlify (static)   │  ───────────────►   │  Hostinger VPS              │
│  pecan-offering     │                      │  76.13.126.85               │
│  -web.netlify.app   │                      │                            │
│                     │  POST /pecan/login   │  nginx ──► :8090            │
│  HTML/CSS/JS        │  POST /pecan/upload  │  /opt/pecan-api  (FastAPI)  │
│  no framework       │                      │      │                     │
└─────────────────────┘                      │      ▼                     │
                                             │  /opt/quick-agent           │
                                             │  (existing engine)          │
                                             │      │                     │
                                             │      ▼                     │
                                             │  QuickBooks Online API      │
                                             │  realm 9341455292146284     │
                                             └────────────────────────────┘
```

**Frontend:** static site on Netlify. Plain HTML/CSS/JS — no framework. Three screens (login, upload, result). Repo: `github.com/onelowxb/pecan-offering-web`. Local path: `C:\Users\ben.holt\code\pecan-offering-web\`.

**Backend:** new FastAPI service at `/opt/pecan-api/` on the Hostinger VPS, running under systemd on port 8090, fronted by the existing nginx + sslip.io TLS cert. Two endpoints: `POST /pecan/login`, `POST /pecan/upload`.

**Engine:** existing `C:\Users\ben.holt\code\quick-agent\` code lifted to `/opt/quick-agent/` on the VPS. Same Python deps, same QBO posting logic. The FastAPI wrapper imports it directly — no rewrites.

**QBO token:** moves from Ben's PC to the VPS via a one-shot re-auth script. Refresh token lives in `/opt/pecan-api/.env`.

## Authentication

Two valid usernames, one shared password (per Ben's spec):

| Username         | Password         |
|------------------|------------------|
| Janie Narducci   | Pecan Offering   |
| Phil Walter      | Pecan Offering   |

**Implementation:**
- Username + password stored in `/opt/pecan-api/.env` as `PECAN_USERS_JSON` (rotatable without redeploying).
- Session = signed HTTP-only cookie, SameSite=Lax, 30-day expiry. Signing secret in `.env` as `PECAN_SESSION_SECRET`.
- Wrong credentials → 401 with generic message.
- `Sign out` link clears the cookie.

**Security caveats (documented, accepted by Ben):**
- Shared password — anyone with the URL and password can post to QBO.
- Acceptable for a 2-person internal church tool. Worth a rotation if either user leaves the role.

## User flow

### Login screen
- Dropdown: "Who are you?" → Janie Narducci / Phil Walter
- Password field
- "Sign in" button
- On failure: "That didn't work, try again."

### Main screen
- Header: "Hi Janie" (or Phil)
- Two large buttons (stacked on mobile, side-by-side on desktop):
  - **Upload Monday Tally Sheet** — accepts `.jpg`, `.jpeg`, `.png`, `.pdf`, `.heic`
  - **Upload Thursday EZ Tithe CSV** — accepts `.csv`
- Click → native file picker → file uploads → spinner with text "Posting to QuickBooks…"
- "Sign out" link top-right.

### Result screen
- **Success:** green checkmark + "Posted to QuickBooks. Deposit #11851." + "Upload another" button.
- **Failure:** red X + plain-English error message + "Try again" button.
- No history, no detail breakdown (per Ben's choice of "minimal" in Q4).

## Backend processing

### `POST /pecan/login`
**Request:** `{ "username": "Janie Narducci", "password": "Pecan Offering" }`
**Response (200):** sets session cookie, returns `{ "ok": true, "display_name": "Janie" }`
**Response (401):** `{ "ok": false, "error": "Invalid credentials" }`

### `POST /pecan/upload`
**Request:** multipart form
- `type`: `"monday"` or `"thursday"`
- `file`: binary
- Requires valid session cookie (else 401)

**Processing:**
1. Validate `type` and file extension matches type (Monday = image/PDF, Thursday = CSV).
2. Compute SHA-256 of file contents.
3. Check `posted_files.json` (or SQLite `posted_files` table) — if same hash posted in last 7 days, return idempotency error with the prior deposit ID.
4. Save to `/opt/quick-agent/inbox/<type>-YYYYMMDD-HHMMSS.<ext>`.
5. Call existing engine:
   - Monday → Claude vision OCR → parse cash + check totals by account → create QBO Deposit
   - Thursday → parse EZ Tithe CSV → map to QBO accounts → create QBO Deposit
6. On success: record `{hash, deposit_id, timestamp, user, type}` to `posted_files` store.
7. Append upload to `/opt/quick-agent/logs/uploads.jsonl`.

**Response (200, success):** `{ "ok": true, "deposit_id": "11851" }`
**Response (200, failure):** `{ "ok": false, "error": "Couldn't read the photo — try a clearer one" }`

### Error mapping (user-facing strings)
| Engine error            | User sees                                                |
|-------------------------|----------------------------------------------------------|
| OCR low confidence      | "Couldn't read the photo — try a clearer one."          |
| CSV parse failure       | "That CSV doesn't look like an EZ Tithe export."        |
| QBO 401 / token expired | "QuickBooks connection needs a refresh — text Ben."     |
| QBO 5xx                 | "QuickBooks is having issues — try again in a minute."  |
| Duplicate file          | "Looks like this file was already posted (Deposit #X)." |
| Unknown                 | "Something went wrong — text Ben."                       |

## Infrastructure

### Netlify
- New repo `pecan-offering-web` connected to Netlify
- Auto-deploy on push to `main`
- Env var: `API_BASE=https://76-13-126-85.sslip.io/pecan` (or chosen host)
- Default `*.netlify.app` URL fine for v1; custom subdomain optional later

### VPS — file layout
```
/opt/quick-agent/                # lifted from C:\Users\ben.holt\code\quick-agent\
    ├── inbox/                   # uploaded files land here
    ├── logs/uploads.jsonl       # one line per upload
    └── ... (existing engine code)

/opt/pecan-api/
    ├── main.py                  # FastAPI app
    ├── auth.py                  # session cookie helpers
    ├── posted_files.sqlite      # idempotency store
    ├── .env                     # QBO refresh token, session secret, user creds
    └── requirements.txt
```

### systemd
`/etc/systemd/system/pecan-api.service`:
- Runs `uvicorn main:app --host 127.0.0.1 --port 8090`
- `Restart=always`, `RestartSec=5`
- `EnvironmentFile=/opt/pecan-api/.env`

### nginx
Add to existing sslip server block:
```
location /pecan/ {
    proxy_pass http://127.0.0.1:8090/;
    client_max_body_size 25M;
    proxy_read_timeout 120s;
}
```

### CORS
Backend only accepts requests from the configured Netlify origin (`Access-Control-Allow-Origin` set explicitly, `credentials: true`).

### QBO token migration (one-time)
1. SSH to VPS, copy `quick-agent` from PC (`scp` or git).
2. Run `python /opt/quick-agent/scripts/qbo_auth.py` — walks the OAuth dance, prints refresh token.
3. Paste token into `/opt/pecan-api/.env` as `QBO_REFRESH_TOKEN`.
4. Engine auto-refreshes from then on. Same realm: `9341455292146284`.

## Testing & rollout

### Local
- Run backend on Ben's PC against a QBO **sandbox** company.
- Run frontend on `localhost:5173`.
- Post a known Monday photo and a known Thursday CSV; verify deposits land in sandbox.

### VPS dry run
- Deploy backend to VPS, point at QBO sandbox.
- Upload from live Netlify URL.
- Confirm green-check + sandbox deposit.

### Production cutover
- Switch backend `.env` to real QBO realm `9341455292146284`.
- Ben uploads one known-good Monday sheet and one known-good Thursday CSV from the Netlify URL himself — verifies the deposits match what he would have posted manually.
- Share URL + credentials with Janie and Phil.

### Rollback
- `sudo systemctl stop pecan-api` → Netlify frontend shows network error → Ben falls back to local `/pecan-offering` workflow as today.
- All uploads logged to `uploads.jsonl` — no data loss.

## Data flow summary

```
User clicks button → file picker → POST /pecan/upload (multipart)
  → backend validates session + type
  → hash file, check duplicate
  → save to /opt/quick-agent/inbox/
  → call existing quick-agent engine
  → engine OCRs/parses → posts to QBO
  → record hash + deposit_id in posted_files
  → append to uploads.jsonl
  → return {ok, deposit_id} or {ok: false, error}
frontend → green check + deposit # OR red X + error
```

## Dependencies

- Existing `quick-agent` codebase (no changes required to engine, only deployment target)
- Hostinger VPS with existing nginx + sslip.io TLS cert
- QBO sandbox company for testing
- QBO realm `9341455292146284` for production
- Netlify account (`onelowxb`)
- GitHub repo creation under `onelowxb`

## Open questions

None at design time. All raised during brainstorming were answered:
- Architecture: VPS (Q1: C)
- Posting: auto-post, no preview (Q2: A)
- Upload UI: two labeled buttons (Q3: B)
- Result: minimal — checkmark + deposit # (Q4: A)
- Errors: show user, stop (Q5: A)
