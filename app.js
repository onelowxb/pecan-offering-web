// API base. Overridden by config.js for local dev (loaded before this file).
const API_BASE = window.PECAN_API_BASE || "https://76-13-126-85.sslip.io/pecan";
const TOKEN_KEY = "pecan_token";

const SCREENS = ["login", "main", "review", "busy", "result"];

// Holds the in-flight review state between /upload and /confirm.
let REVIEW = null; // { parsed, computed, mismatches, review_token, filename }

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

function showResult(ok, message, depositId) {
  const okEl = document.getElementById("result-ok");
  const failEl = document.getElementById("result-fail");
  if (ok) {
    okEl.hidden = false;
    failEl.hidden = true;
    document.getElementById("deposit-id").textContent = depositId;
  } else {
    okEl.hidden = true;
    failEl.hidden = false;
    document.getElementById("result-error").textContent = message || "Something went wrong — text Ben.";
  }
  show("result");
}

for (const type of ["monday", "thursday"]) {
  document.getElementById("picker-" + type).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    show("busy");
    document.querySelector("#busy-screen .lead").textContent =
      type === "monday" ? "Reading the sheet…" : "Posting to QuickBooks…";
    const fd = new FormData();
    fd.append("type", type);
    fd.append("file", file);
    const { status, body } = await post("/upload", fd, true);
    e.target.value = "";

    if (status === 401) {
      clearToken();
      show("login");
      return;
    }
    if (status === 200 && body.ok && body.stage === "review") {
      REVIEW = {
        parsed: body.parsed,
        computed: body.computed,
        mismatches: body.mismatches || [],
        review_token: body.review_token,
        filename: body.filename || "",
      };
      renderReview();
      show("review");
      return;
    }
    if (status === 200 && body.ok && body.deposit_id) {
      showResult(true, null, body.deposit_id);
      return;
    }
    showResult(false, body.error);
  });
}

// ---------- Review screen ----------

const FIELD_LABELS = {
  total_contributions: "Total",
  tithe: "Tithe",
  building: "Building",
  missions: "Missions",
  manna: "Manna",
  youth: "Youth",
  missionary: "Missionary",
  total_cash: "Cash",
  total_checks: "Checks",
};

// printed_totals key -> fund_splits key on each contribution row.
const FUND_KEY = {
  tithe: "Tithe",
  building: "Building",
  missions: "Missions",
  manna: "Manna",
  youth: "Youth",
  missionary: "Missionary",
};

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}
function fmt(v) {
  return num(v).toFixed(2);
}

function rowSplitSum(c) {
  const fs = c.fund_splits || {};
  let s = 0;
  for (const fk of Object.values(FUND_KEY)) s += num(fs[fk]);
  return +s.toFixed(2);
}

function computeFromParsed(parsed) {
  const contribs = parsed.contributions || [];
  const out = { total_contributions: 0, total_cash: 0, total_checks: 0 };
  for (const k of Object.keys(FUND_KEY)) out[k] = 0;
  for (const c of contribs) {
    const t = num(c.total);
    out.total_contributions += t;
    const fs = c.fund_splits || {};
    for (const [pk, fk] of Object.entries(FUND_KEY)) out[pk] += num(fs[fk]);
    if ((c.payment || "").toLowerCase() === "cash") out.total_cash += t;
    else out.total_checks += t;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

function diffTotals(computed, printed) {
  const out = [];
  for (const k of Object.keys(FIELD_LABELS)) {
    const c = +num(computed[k]).toFixed(2);
    const p = +num((printed || {})[k]).toFixed(2);
    if (Math.abs(c - p) > 0.005) out.push(k);
  }
  return out;
}

function renderReview() {
  const { parsed } = REVIEW;
  document.getElementById("rv-date").value = parsed.service_date || "";
  document.getElementById("rv-date").oninput = (e) => {
    parsed.service_date = e.target.value.trim();
  };

  parsed.printed_totals = parsed.printed_totals || {};
  for (const input of document.querySelectorAll(".num-in[data-printed]")) {
    const key = input.dataset.printed;
    input.value = fmt(parsed.printed_totals[key]);
    input.oninput = () => {
      parsed.printed_totals[key] = num(input.value);
      refreshTotals();
    };
  }

  renderDonors();
  refreshTotals();
}

function refreshTotals() {
  const { parsed } = REVIEW;
  const computed = computeFromParsed(parsed);
  REVIEW.computed = computed;
  const mismatches = new Set(diffTotals(computed, parsed.printed_totals));

  for (const cell of document.querySelectorAll(".num[data-computed]")) {
    const key = cell.dataset.computed;
    cell.textContent = "$" + fmt(computed[key]);
  }
  for (const cell of document.querySelectorAll(".totals-grid .num[data-computed], .totals-grid .num-in[data-printed]")) {
    const key = cell.dataset.computed || cell.dataset.printed;
    cell.classList.toggle("mismatch", mismatches.has(key));
  }

  const warn = document.getElementById("review-warn");
  if (mismatches.size) {
    const fields = [...mismatches].map(k => FIELD_LABELS[k]).join(", ");
    warn.textContent = `Heads up: row sums don't match the printed totals for ${fields}. QuickBooks will reject this until they match — fix the wrong number(s) below.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function makeEl(tag, props, children) {
  const el = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    if (k === "class") el.className = props[k];
    else if (k === "data") for (const dk of Object.keys(props.data)) el.dataset[dk] = props.data[dk];
    else if (k.startsWith("on")) el[k] = props[k];
    else if (k in el) el[k] = props[k];
    else el.setAttribute(k, props[k]);
  }
  for (const c of (children || [])) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function donorEditField(label, k, value, opts) {
  opts = opts || {};
  const input = opts.select
    ? makeEl("select", { data: { k } }, opts.options.map(o =>
        makeEl("option", { value: o, selected: o === value }, [o])))
    : makeEl("input", {
        type: "text",
        inputmode: opts.numeric ? "decimal" : undefined,
        value: opts.numeric ? fmt(value) : (value || ""),
        data: { k, ...(opts.split ? { split: "1" } : {}) },
      });
  return makeEl("label", null, [label + " ", input]);
}

function renderDonors() {
  const { parsed } = REVIEW;
  const wrap = document.getElementById("rv-donors");
  wrap.textContent = "";
  const contribs = parsed.contributions || (parsed.contributions = []);
  document.getElementById("rv-count").textContent = contribs.length;

  contribs.forEach((c, idx) => {
    const fs = c.fund_splits || {};
    const splitSum = rowSplitSum(c);
    const total = num(c.total);
    const rowOff = Math.abs(splitSum - total) > 0.005;
    const flagEl = rowOff
      ? makeEl("div", { class: "row-flag" }, [`Splits sum to $${fmt(splitSum)}, but total is $${fmt(total)}. Fix below.`])
      : null;
    const nameEl = makeEl("div", { class: "donor-name" }, [c.name || "(no name)"]);
    const metaEl = makeEl("div", { class: "donor-meta" }, [donorMeta(c)]);
    const totEl = makeEl("div", { class: "donor-total" }, ["$" + fmt(c.total)]);
    const row = makeEl("div", { class: "donor-row" }, [
      makeEl("div", null, [nameEl, metaEl, flagEl].filter(Boolean)),
      totEl,
    ]);

    const grid = makeEl("div", { class: "grid" }, [
      donorEditField("Name", "name", c.name),
      donorEditField("Payment", "payment", c.payment || "Check", { select: true, options: ["Check", "Cash"] }),
      donorEditField("Check #", "check", c.check),
      donorEditField("Total $", "total", c.total, { numeric: true }),
      donorEditField("Tithe $", "Tithe", fs.Tithe, { numeric: true, split: true }),
      donorEditField("Building $", "Building", fs.Building, { numeric: true, split: true }),
      donorEditField("Missions $", "Missions", fs.Missions, { numeric: true, split: true }),
      donorEditField("Manna $", "Manna", fs.Manna, { numeric: true, split: true }),
      donorEditField("Youth $", "Youth", fs.Youth, { numeric: true, split: true }),
      donorEditField("Missionary $", "Missionary", fs.Missionary, { numeric: true, split: true }),
      donorEditField("Missionary memo", "missionary", c.missionary),
    ]);
    const delBtn = makeEl("button", { type: "button", class: "danger" }, ["Delete row"]);
    const doneBtn = makeEl("button", { type: "button", class: "done" }, ["Done"]);
    const actions = makeEl("div", { class: "row-actions" }, [delBtn, doneBtn]);
    const edit = makeEl("div", { class: "donor-edit" }, [grid, actions]);

    const el = makeEl("div", { class: rowOff ? "donor row-mismatch open" : "donor" }, [row, edit]);

    row.onclick = () => el.classList.toggle("open");

    grid.querySelectorAll("input, select").forEach(inp => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.k;
        const isSplit = inp.dataset.split !== undefined;
        if (isSplit) {
          c.fund_splits = c.fund_splits || {};
          c.fund_splits[k] = num(inp.value);
        } else if (k === "total") {
          c.total = num(inp.value);
        } else if (k === "payment") {
          c.payment = inp.value;
        } else {
          c[k] = inp.value;
        }
        nameEl.textContent = c.name || "(no name)";
        totEl.textContent = "$" + fmt(c.total);
        metaEl.textContent = donorMeta(c);
        const newSum = rowSplitSum(c);
        const newTotal = num(c.total);
        const stillOff = Math.abs(newSum - newTotal) > 0.005;
        el.classList.toggle("row-mismatch", stillOff);
        if (flagEl) {
          flagEl.textContent = stillOff
            ? `Splits sum to $${fmt(newSum)}, but total is $${fmt(newTotal)}. Fix below.`
            : "";
          flagEl.hidden = !stillOff;
        }
        refreshTotals();
      });
    });
    doneBtn.onclick = (ev) => { ev.stopPropagation(); el.classList.remove("open"); };
    delBtn.onclick = (ev) => {
      ev.stopPropagation();
      contribs.splice(idx, 1);
      renderDonors();
      refreshTotals();
    };

    wrap.append(el);
  });
}

function donorMeta(c) {
  const parts = [(c.payment || "Check")];
  if ((c.payment || "Check") === "Check" && c.check) parts.push("#" + c.check);
  const fs = c.fund_splits || {};
  const splits = [];
  const tag = [["Tithe","T"],["Building","B"],["Missions","Ms"],["Manna","Mn"],["Youth","Y"],["Missionary","Mi"]];
  for (const [k, abbr] of tag) {
    if (num(fs[k])) splits.push(abbr + " " + fmt(fs[k]));
  }
  if (splits.length) parts.push(splits.join(" / "));
  return parts.join(" · ");
}

document.getElementById("review-cancel").addEventListener("click", () => {
  REVIEW = null;
  show("main");
});

document.getElementById("rv-post").addEventListener("click", async () => {
  if (!REVIEW) { show("main"); return; }
  REVIEW.parsed.service_date = document.getElementById("rv-date").value.trim();
  show("busy");
  document.querySelector("#busy-screen .lead").textContent = "Posting to QuickBooks…";
  const { status, body } = await post("/confirm", {
    review_token: REVIEW.review_token,
    parsed: REVIEW.parsed,
    filename: REVIEW.filename,
  });
  if (status === 401) {
    clearToken();
    show("login");
    return;
  }
  if (status === 200 && body.ok && body.deposit_id) {
    REVIEW = null;
    showResult(true, null, body.deposit_id);
    return;
  }
  if (body.review_token) REVIEW.review_token = body.review_token;
  show("review");
  const warn = document.getElementById("review-warn");
  warn.textContent = body.error || "Posting failed. Check the numbers and try again.";
  warn.hidden = false;
});

document.getElementById("again").addEventListener("click", () => {
  REVIEW = null;
  show("main");
});
