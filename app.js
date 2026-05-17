// API base. Overridden by config.js for local dev (loaded before this file).
const API_BASE = window.PECAN_API_BASE || "https://76-13-126-85.sslip.io/pecan";
const TOKEN_KEY = "pecan_token";

const SCREENS = ["login", "main", "busy", "result"];

function show(name) {
  for (const s of SCREENS) {
    document.getElementById(s + "-screen").hidden = (s !== name);
  }
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
}
function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

async function post(path, body, isForm) {
  const opts = { method: "POST", headers: {} };
  const token = getToken();
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  if (isForm) {
    opts.body = body;
  } else {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(API_BASE + path, opts);
  } catch (e) {
    return { status: 0, body: { ok: false, error: "Can't reach the server. Check your wi-fi." } };
  }
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

// On load: if we have a stored token, skip to main screen (best effort — server
// will 401 on /upload if the token is stale, and we'll bounce back to login then).
if (getToken()) {
  // We don't know the display name without round-tripping; leave blank — it's cosmetic.
  document.getElementById("display-name").textContent = "";
  show("main");
} else {
  show("login");
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
  if (status === 200 && body.ok && body.token) {
    setToken(body.token);
    document.getElementById("display-name").textContent = body.display_name;
    show("main");
  } else {
    err.textContent = "That didn't work, try again.";
    err.hidden = false;
  }
});

document.getElementById("signout").addEventListener("click", async () => {
  clearToken();
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
    e.target.value = ""; // reset picker so same file can be retried
    const ok = document.getElementById("result-ok");
    const fail = document.getElementById("result-fail");
    if (status === 200 && body.ok) {
      ok.hidden = false;
      fail.hidden = true;
      document.getElementById("deposit-id").textContent = body.deposit_id;
    } else if (status === 401) {
      // Token expired or rejected — bounce to login.
      clearToken();
      show("login");
      return;
    } else {
      ok.hidden = true;
      fail.hidden = false;
      document.getElementById("result-error").textContent =
        body.error || "Something went wrong — text Ben.";
    }
    show("result");
  });
}

document.getElementById("again").addEventListener("click", () => show("main"));
