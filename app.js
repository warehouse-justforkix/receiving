import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const VERSION = "v1";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: "recv-auth" } });
const $  = (id) => document.getElementById(id);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));

/* The three sheet statuses. The stored values are historical; these are the
   words the warehouse uses, and the only ones shown anywhere. */
const STATUS_LABEL = {
  counting:  "Counting",
  submitted: "Pending Action",
  partial:   "Partially Received",
  closed:    "Items Received",
};
const statusLabel = (v) => STATUS_LABEL[v] || v;

let me = null, isAdmin = false, sheets = [], sheet = null, groups = [], lines = [], boxes = [];
let sizeAliases = {}, settings = {}, signupMode = false, acMatches = [], acSel = -1;

/* ---------------- utilities ---------------- */
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}
function when(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const sizeLabel = (s) => sizeAliases[s] || s;
async function fail(where, error) { console.error(where, error); toast(error?.message ? `${where}: ${error.message}` : `${where} failed`); }

/* ---------------- auth ---------------- */
$("signupToggle").addEventListener("click", () => {
  signupMode = !signupMode;
  $("authBtn").textContent = signupMode ? "Create account" : "Sign in";
  $("signupToggle").textContent = signupMode ? "Already have an account? Sign in" : "First time here? Create your account";
  $("authErr").hidden = true;
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim().toLowerCase(), password = $("authPass").value;
  $("authBtn").disabled = true; $("authErr").hidden = true;
  const { error } = signupMode
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  $("authBtn").disabled = false;
  if (error) { $("authErr").textContent = error.message; $("authErr").hidden = false; return; }
  boot();
});

$("signOut").addEventListener("click", async () => { await sb.auth.signOut({ scope: "local" }); location.reload(); });

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $("authGate").hidden = false; $("app").hidden = true; return; }

  // promote an invited email into a person row on first sign-in
  await sb.rpc("recv_handle_login");

  const { data: person, error } = await sb
    .from("recv_people").select("*").eq("auth_user_id", session.user.id).maybeSingle();
  if (error) return fail("Loading profile", error);
  if (!person) {
    $("authErr").textContent = "That email hasn't been invited to Receiving yet. Ask Karley to add it in Admin.";
    $("authErr").hidden = false;
    // local scope only: a global signOut would also end this person's
    // Hub and Returns sessions, which share this Supabase project.
    await sb.auth.signOut({ scope: "local" });
    $("authGate").hidden = false; $("app").hidden = true;
    return;
  }
  me = person; isAdmin = !!person.is_admin;

  $("authGate").hidden = true; $("app").hidden = false;
  $("whoName").textContent = person.name + (isAdmin ? " · admin" : "");
  $("version").textContent = `JFK Receiving ${VERSION}`;
  document.querySelectorAll(".admin-only").forEach((n) => { n.hidden = !isAdmin; });

  await Promise.all([loadSizeAliases(), loadSettings()]);
  await loadSheets();
  await loadDoc();
  if (isAdmin) loadAdmin();
  refreshNotifStatus();
  maybeShowNotifBanner();
  refreshNotifStatus();
}

async function loadSizeAliases() {
  const { data } = await sb.from("recv_size_labels").select("*");
  sizeAliases = {}; (data || []).forEach((r) => { sizeAliases[r.ns_size] = r.display_label; });
}
async function loadSettings() {
  const { data } = await sb.from("recv_settings").select("*");
  settings = {}; (data || []).forEach((r) => { settings[r.key] = r.value; });
}

/* ---------------- view switching ---------------- */
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab"); if (!b) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
  show(b.dataset.view);
});
function show(v) {
  ["sheets", "sheet", "procedure", "admin"].forEach((k) => { $("view-" + k).hidden = k !== v; });
}
$("backToList").addEventListener("click", () => {
  show("sheets");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === "sheets"));
  loadSheets();
});

/* ---------------- sheet list ---------------- */
async function loadSheets() {
  const { data, error } = await sb
    .from("recv_sheets")
    .select("*, lines:recv_sheet_lines!recv_sheet_lines_sheet_fk(po_qty,counted_qty), grps:recv_sheet_groups!recv_sheet_groups_sheet_fk(style_color)")
    .order("created_at", { ascending: false });
  if (error) return fail("Loading sheets", error);
  sheets = data || [];
  renderSheets();
}

function sheetStats(s) {
  const ls = s.lines || [];
  let off = 0, counted = 0, po = 0, withPo = 0;
  ls.forEach((l) => {
    counted += l.counted_qty || 0;
    if (l.po_qty != null) { po += l.po_qty; withPo++; if ((l.counted_qty || 0) !== l.po_qty) off++; }
  });
  return { lines: ls.length, off, counted, po, withPo };
}

function renderSheets() {
  const q = $("sheetSearch").value.trim().toLowerCase();
  const st = $("statusFilter").value;
  const only = $("discrepOnly").checked;
  const box = $("sheetList"); box.textContent = "";

  const rows = sheets.filter((s) => {
    const stats = sheetStats(s);
    if (st && s.status !== st) return false;
    if (only && stats.off === 0) return false;
    if (!q) return true;
    const hay = [s.title, s.po_number, s.vendor, ...(s.grps || []).map((g) => g.style_color)]
      .join(" ").toLowerCase();
    return hay.includes(q);
  });

  const totalOff = sheets.reduce((n, s) => n + (sheetStats(s).off > 0 ? 1 : 0), 0);
  $("sheetsSummary").textContent =
    `${sheets.length} sheet${sheets.length === 1 ? "" : "s"} · ${totalOff} with discrepancies`;

  if (!rows.length) {
    box.append(el("div", "empty-state", sheets.length
      ? "No sheets match those filters."
      : "No count sheets yet. Start one when a truck arrives."));
    return;
  }

  const sectionHead = (text, note) => {
    const h = el("p", "list-section");
    h.append(el("span", null, text));
    if (note) h.append(el("span", "list-section-note", note));
    return h;
  };

  // Work in progress first, finished work filed underneath.
  ["counting", "submitted", "partial"].forEach((key) => {
    const inThis = rows.filter((s) => s.status === key);
    if (!inThis.length) return;
    box.append(sectionHead(statusLabel(key), `${inThis.length}`));
    inThis
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .forEach((s) => box.append(sheetRow(s)));
  });

  // Received sheets are filed by the month they were completed.
  const done = rows.filter((s) => s.status === "closed");
  if (done.length) {
    box.append(sectionHead(statusLabel("closed"), `${done.length}`));
    const byMonth = new Map();
    done.forEach((s) => {
      const d = new Date(s.closed_at || s.updated_at || s.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
      if (!byMonth.has(key)) {
        byMonth.set(key, { when: d, label: d.toLocaleDateString([], { month: "long", year: "numeric" }), items: [] });
      }
      byMonth.get(key).items.push(s);
    });
    [...byMonth.values()]
      .sort((a, b) => b.when - a.when)
      .forEach((m) => {
        box.append(sectionHead(m.label, `${m.items.length}`, true));
        m.items
          .sort((a, b) => new Date(b.closed_at || b.created_at) - new Date(a.closed_at || a.created_at))
          .forEach((s) => box.append(sheetRow(s)));
      });
  }
}

function sheetRow(s) {
  const stats = sheetStats(s);
  // the stripe down the left is the sheet's status, not its discrepancy count
  const row = el("button", `sheet-row st-${s.status}`);
  row.type = "button";
  row.append(el("h3", null, s.title || "(untitled)"));
  const sub = el("p", "sub");
  sub.textContent = `PO# ${s.po_number || "—"}` +
    (s.vendor ? ` · ${s.vendor}` : "") +
    ` · ${(s.grps || []).length} style-color · ${when(s.created_at)}`;
  const tally = el("div", "tally");
  tally.append(el("span", `pill ${s.status}`, statusLabel(s.status)));
  const n = el("p", "sub");
  n.textContent = stats.withPo === 0 ? "no PO qty yet"
    : stats.off > 0 ? `${stats.off} off` : "all matched";
  if (stats.off > 0) n.className = "sub off-note";
  tally.append(n);
  row.append(sub, tally);
  row.addEventListener("click", () => openSheet(s.id));
  return row;
}

["sheetSearch", "statusFilter", "discrepOnly"].forEach((id) =>
  $(id).addEventListener("input", renderSheets));

/* ---------------- new sheet ---------------- */
$("newSheetBtn").addEventListener("click", async () => {
  const po = prompt("PO number for this sheet?");
  if (po === null) return;
  const today = new Date().toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  const { data, error } = await sb.from("recv_sheets")
    .insert({ title: `PO ${po.trim() || "—"} · ${today}`, po_number: po.trim(), status: "counting", created_by: me.id })
    .select().single();
  if (error) return fail("Creating sheet", error);
  await loadSheets();
  openSheet(data.id);
});

/* ---------------- open one sheet ---------------- */
async function openSheet(id) {
  const [{ data: s, error: e1 }, { data: g }, { data: l }] = await Promise.all([
    sb.from("recv_sheets").select("*").eq("id", id).single(),
    sb.from("recv_sheet_groups").select("*").eq("sheet_id", id).order("sort_order"),
    sb.from("recv_sheet_lines").select("*").eq("sheet_id", id).order("sort_order"),
  ]);
  if (e1) return fail("Opening sheet", e1);
  sheet = s; groups = g || []; lines = l || [];
  const ids = lines.map((x) => x.id);
  boxes = [];
  if (ids.length) {
    const { data: b } = await sb.from("recv_line_boxes").select("*").in("line_id", ids).order("box_no");
    boxes = b || [];
  }
  $("sheetTitle").value = s.title || "";
  $("sheetPo").value = s.po_number || "";
  $("sheetVendor").value = s.vendor || "";
  $("sheetStatus").value = s.status;
  $("sheetAdj").value = s.adjustment_number || "";
  $("emailOut").hidden = true; $("copyEmailBtn").hidden = true;
  renderGroups(); renderTotals(); loadComments(); loadAudit();
  show("sheet");
}

/* save sheet header fields on change */
[["sheetTitle", "title"], ["sheetPo", "po_number"], ["sheetVendor", "vendor"],
 ["sheetStatus", "status"], ["sheetAdj", "adjustment_number"]].forEach(([id, col]) => {
  $(id).addEventListener("change", async () => {
    const v = $(id).value.trim();
    const REQUIRED = { title: "Title", po_number: "PO number", status: "Status" };
    if (REQUIRED[col] && !v) {            // title / po_number / status are NOT NULL
      $(id).value = sheet[col] || "";
      toast(`${REQUIRED[col]} can't be blank`);
      return;
    }
    const wasStatus = sheet.status;
    const patch = { [col]: REQUIRED[col] ? v : (v || null), updated_at: new Date().toISOString() };
    if (col === "status") {
      patch.submitted_at = v === "submitted" ? new Date().toISOString() : sheet.submitted_at;
      patch.closed_at    = v === "closed"    ? new Date().toISOString() : sheet.closed_at;
    }
    const { error } = await sb.from("recv_sheets").update(patch).eq("id", sheet.id);
    if (error) return fail("Saving", error);
    const becameReceived = col === "status" &&
      (v === "closed" || v === "partial") && wasStatus !== v;
    Object.assign(sheet, patch);
    toast("Saved");
    if (becameReceived) offerReceivedEmail();
  });
});

function renderTotals() {
  const withPo = lines.filter((l) => l.po_qty != null);
  const off = withPo.filter((l) => (l.counted_qty || 0) !== l.po_qty);
  const counted = lines.reduce((n, l) => n + (l.counted_qty || 0), 0);
  const po = withPo.reduce((n, l) => n + l.po_qty, 0);
  // only sizes somebody actually entered a count against - a style-color adds
  // its whole size run, and most of those never get touched on a given truck
  const sizesCounted = lines.filter((l) => boxes.some((b) => b.line_id === l.id)).length;
  const box = $("sheetTotals"); box.textContent = "";
  const tile = (k, v, cls) => { const t = el("div", "tile" + (cls ? " " + cls : "")); t.append(el("p", "k", k), el("p", "v", String(v))); return t; };
  box.append(
    tile("Sizes counted", sizesCounted),
    tile("Counted", counted),
    tile("PO qty", withPo.length ? po : "—"),
    tile("Off", off.length, off.length ? "off" : "ok"),
  );
}

function renderGroups() {
  const wrap = $("groups"); wrap.textContent = "";
  if (!groups.length) {
    wrap.append(el("div", "empty-state", "No styles on this sheet yet. Add one below."));
    return;
  }
  groups.forEach((g) => {
    const gl = lines.filter((l) => l.group_id === g.id);
    const off = gl.filter((l) => l.po_qty != null && (l.counted_qty || 0) !== l.po_qty).length;
    const sizesCounted = gl.filter((l) => boxes.some((b) => b.line_id === l.id)).length;
    const counted = gl.reduce((n, l) => n + (l.counted_qty || 0), 0);

    const card = el("div", "group" + (g.saved ? " saved" : ""));
    const head = el("div", "group-head");
    const left = el("div");
    left.append(el("h3", null, g.style_color));
    const recv = gl.filter((l) => lineState(l).key === "received").length;
    const shortOf = gl.filter((l) => ["short", "none"].includes(lineState(l).key)).length;
    left.append(el("p", "st", g.saved
      ? `${recv} of ${gl.length} sizes received · ${counted} units`
      : `${gl.length} size${gl.length === 1 ? "" : "s"}` +
        (sizesCounted ? ` · ${recv} received` : "") +
        (shortOf ? ` · ${shortOf} short` : "")));

    const actions = el("div", "group-head-actions");
    if (g.saved) {
      actions.append(el("span", "saved-badge", "\u2713 Received"));
      const edit = el("button", "btn ghost sm", "Edit");
      edit.addEventListener("click", () => setGroupSaved(g, false));
      actions.append(edit);
    } else {
      const save = el("button", "btn sm primary", "Save");
      save.title = "Freeze these counts and fold this style away";
      save.addEventListener("click", () => setGroupSaved(g, true));
      actions.append(save);
    }
    const del = el("button", "btn ghost sm", "Remove");
    del.addEventListener("click", async () => {
      if (!confirm(`Remove ${g.style_color} and its counts from this sheet?`)) return;
      const { error } = await sb.from("recv_sheet_groups").delete().eq("id", g.id);
      if (error) return fail("Removing style", error);
      openSheet(sheet.id);
    });
    actions.append(del);

    head.append(left, actions);
    card.append(head);
    if (g.saved) {
      // folded, but still openable to check the counts without unlocking them
      const fold = el("details", "group-fold");
      const sum = el("summary", null, "Review counts");
      fold.append(sum);
      const body = el("div", "group-fold-body");
      gl.forEach((l) => body.append(renderLine(l, true)));
      fold.append(body);
      card.append(fold);
    } else {
      gl.forEach((l) => card.append(renderLine(l)));
    }
    wrap.append(card);
  });
}

async function setGroupSaved(g, saved) {
  const { error } = await sb.from("recv_sheet_groups").update({ saved }).eq("id", g.id);
  if (error) return fail(saved ? "Saving style" : "Reopening style", error);
  g.saved = saved;
  const idx = groups.findIndex((x) => x.id === g.id);
  if (idx >= 0) groups[idx].saved = saved;
  renderGroups(); renderTotals();
  toast(saved ? `${g.style_color} saved` : `${g.style_color} reopened for editing`);
}

function renderLine(l, frozen = false) {
  const row = el("div", "line" + (frozen ? " frozen" : ""));
  const top = el("div", "line-top");
  top.append(el("p", "size-tag", sizeLabel(l.size)));

  const nums = el("div", "line-nums");
  nums.append(el("span", "sm", "PO"));
  const po = el("input", "po"); po.type = "number"; po.inputMode = "numeric";
  po.value = l.po_qty ?? ""; po.placeholder = "—";
  if (frozen) po.readOnly = true;
  po.addEventListener("change", async () => {
    if (frozen) return;
    const v = po.value === "" ? null : parseInt(po.value, 10);
    const { error } = await sb.from("recv_sheet_lines").update({ po_qty: v }).eq("id", l.id);
    if (error) return fail("Saving PO qty", error);
    l.po_qty = v; refreshLine(l, row); renderTotals(); loadAudit();
  });
  nums.append(po);
  nums.append(el("span", "sm", "counted"));
  nums.append(el("span", "counted", String(l.counted_qty || 0)));
  nums.append(el("span", "var", ""));
  top.append(nums);
  row.append(top);

  // box counts — each carton entered separately, they sum to the counted total
  const bx = el("div", "boxes");
  row.append(bx);

  // On a Partially Received sheet each size is marked by hand, so there is no
  // doubt about which ones actually came in.
  if (sheet?.status === "partial" && !frozen) {
    const mark = el("div", "recv-mark");
    mark.append(el("span", "recv-mark-label", "Did this size arrive?"));
    const mk = (val, text) => {
      const b = el("button", "btn sm recv-btn" + (l.received === val ? " on " + (val ? "yes" : "no") : ""));
      b.textContent = text;
      b.addEventListener("click", async () => {
        const next = l.received === val ? null : val;   // tap again to clear
        const { error } = await sb.from("recv_sheet_lines").update({ received: next }).eq("id", l.id);
        if (error) return fail("Marking size", error);
        l.received = next;
        const i = lines.findIndex((x) => x.id === l.id);
        if (i >= 0) lines[i].received = next;
        renderGroups(); renderTotals(); loadAudit();
      });
      return b;
    };
    mark.append(mk(true, "Received"), mk(false, "Not received"));
    row.append(mark);
  }

  drawBoxes(l, bx, row, frozen);
  refreshLine(l, row);
  return row;
}

function drawBoxes(l, bx, row, frozen = false) {
  bx.textContent = "";
  const mine = boxes.filter((b) => b.line_id === l.id).sort((a, b) => a.box_no - b.box_no);

  // Every size shows a blank ready to type in. The row is only written to the
  // database once a number is actually entered, so untouched sizes stay clean.
  if (!mine.length && !frozen) {
    const w = el("div", "box-wrap");
    w.append(el("span", "bn", "Box 1"));
    const i = el("input", "box-in");
    i.type = "number"; i.inputMode = "numeric"; i.placeholder = "\u2013";
    i.addEventListener("change", async () => {
      if (i.value === "") return;
      const { data, error } = await sb.from("recv_line_boxes")
        .insert({ line_id: l.id, box_no: 1, qty: parseInt(i.value, 10) || 0, created_by: me.id })
        .select().single();
      if (error) return fail("Saving count", error);
      boxes.push(data);
      await recount(l, row, bx);
    });
    w.append(i);
    bx.append(w);
  }

  mine.forEach((b) => {
    const w = el("div", "box-wrap");
    w.append(el("span", "bn", "Box " + b.box_no));
    const i = el("input", "box-in"); i.type = "number"; i.inputMode = "numeric"; i.value = b.qty;
    if (frozen) i.readOnly = true;
    i.addEventListener("change", async () => {
      if (frozen) return;
      const v = i.value === "" ? 0 : parseInt(i.value, 10);
      const { error } = await sb.from("recv_line_boxes").update({ qty: v }).eq("id", b.id);
      if (error) return fail("Saving box", error);
      b.qty = v; await recount(l, row, bx);
    });
    // only offer removal once there is more than one box on the size
    if (mine.length > 1 && !frozen) {
      const rm = el("button", "linkish sm box-rm", "\u00d7");
      rm.title = "Remove box " + b.box_no;
      rm.addEventListener("click", async () => {
        const { error } = await sb.from("recv_line_boxes").delete().eq("id", b.id);
        if (error) return fail("Removing box", error);
        boxes = boxes.filter((x) => x.id !== b.id);
        await recount(l, row, bx);
      });
      w.append(i, rm);
    } else {
      w.append(i);
    }
    bx.append(w);
  });

  if (frozen) {
    if (!mine.length) bx.append(el("p", "muted sm", "Not counted"));
    return;
  }
  const add = el("button", "btn box-add", "+");
  add.title = "Another box of this same size";
  add.addEventListener("click", async () => {
    const { data, error } = await sb.rpc("recv_add_box", { p_line: l.id });
    if (error) return fail("Adding box", error);
    if (data) boxes.push(data);
    await recount(l, row, bx);
  });
  bx.append(add);
}

async function recount(l, row, bx) {
  // the DB trigger recomputes counted_qty from the boxes; read it back
  const [{ data }, { data: fresh }] = await Promise.all([
    sb.from("recv_sheet_lines").select("counted_qty").eq("id", l.id).single(),
    sb.from("recv_line_boxes").select("*").eq("line_id", l.id).order("box_no"),
  ]);
  l.counted_qty = data?.counted_qty ?? 0;
  boxes = boxes.filter((b) => b.line_id !== l.id).concat(fresh || []);
  const idx = lines.findIndex((x) => x.id === l.id);
  if (idx >= 0) lines[idx].counted_qty = l.counted_qty;
  drawBoxes(l, bx, row); refreshLine(l, row); renderTotals();
}

/* Receipt state for one size, worked out from the counts rather than a
   separate tick box - so the badge can never disagree with the numbers, and
   the crew has nothing extra to tap while counting a truck. */
function lineState(l) {
  // an explicit mark, where someone has made the call, always wins
  if (l.received === true)  return { key: "received", label: "Received" };
  if (l.received === false) return { key: "notreceived", label: "Not received" };
  const hasCount = boxes.some((b) => b.line_id === l.id);
  if (!hasCount) return { key: "uncounted", label: "Not counted" };
  const c = l.counted_qty || 0;
  if (l.po_qty == null) return { key: "counted", label: `${c} counted` };
  const d = c - l.po_qty;
  if (d === 0) return { key: "received", label: "Received" };
  if (c === 0)  return { key: "none", label: "None arrived" };
  if (d < 0)    return { key: "short", label: `Short ${d}` };
  return { key: "over", label: `Over +${d}` };
}

function refreshLine(l, row) {
  row.querySelector(".counted").textContent = String(l.counted_qty || 0);
  const v = row.querySelector(".var");
  const st = lineState(l);
  v.textContent = st.label;
  v.className = "var " + st.key;
}

/* ---------------- SKU autocomplete ---------------- */
let acTimer = null;
$("skuInput").addEventListener("input", () => {
  clearTimeout(acTimer);
  acTimer = setTimeout(runAutocomplete, 160);
});
$("skuInput").addEventListener("keydown", (e) => {
  if ($("acList").hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    acSel = Math.max(0, Math.min(acMatches.length - 1, acSel + (e.key === "ArrowDown" ? 1 : -1)));
    paintAc();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (acSel >= 0) pickStyleColor(acMatches[acSel].style_color);
  } else if (e.key === "Escape") { $("acList").hidden = true; }
});

async function runAutocomplete() {
  const q = $("skuInput").value.trim();
  const list = $("acList");
  if (q.length < 2) { list.hidden = true; return; }
  const { data, error } = await sb
    .from("recv_catalog_styles")
    .select("style_color, style, color, size_count")
    .ilike("style_color", `%${q}%`)
    .order("style_color")
    .limit(40);
  if (error) { fail("Searching catalog", error); return; }
  acMatches = (data || []).map((r) => ({ ...r, n: r.size_count }));
  acSel = acMatches.length ? 0 : -1;
  paintAc();
}

function paintAc() {
  const list = $("acList"); list.textContent = ""; list.hidden = false;
  if (!acMatches.length) {
    list.append(el("div", "ac-empty", "No match in the catalog. You can still add it by typing the full style-color and pressing Add."));
    return;
  }
  acMatches.forEach((m, i) => {
    const b = el("button", "ac-item" + (i === acSel ? " sel" : "")); b.type = "button";
    b.append(el("b", null, m.style_color));
    b.append(el("span", "n", `  ${m.n} size${m.n === 1 ? "" : "s"}`));
    b.addEventListener("click", () => pickStyleColor(m.style_color));
    list.append(b);
  });
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ac-wrap")) $("acList").hidden = true;
});

async function pickStyleColor(sc) {
  $("skuInput").value = sc;
  $("acList").hidden = true;
  await addGroup(sc);
}
$("addGroupBtn").addEventListener("click", () => {
  const v = $("skuInput").value.trim();
  if (v) addGroup(v);
});

async function addGroup(styleColor) {
  if (!sheet) return;
  if (groups.some((g) => g.style_color.toLowerCase() === styleColor.toLowerCase())) {
    toast("That style-color is already on this sheet"); return;
  }
  const typed = styleColor.replace(/\s*-\s*/g, "-").trim();
  const { data: cat } = await sb.from("recv_catalog")
    .select("sku, style, color, size, style_color").ilike("style_color", typed);
  if (cat?.length) styleColor = cat[0].style_color;      // use the catalog's exact casing
  if (groups.some((g) => g.style_color.toLowerCase() === styleColor.toLowerCase())) {
    toast("That style-color is already on this sheet"); return;
  }

  const style = cat?.[0]?.style || styleColor.split("-")[0];
  const color = cat?.[0]?.color || styleColor.split("-").slice(1).join("-") || null;

  const { data: g, error } = await sb.from("recv_sheet_groups")
    .insert({ sheet_id: sheet.id, style, color, style_color: styleColor, sort_order: groups.length })
    .select().single();
  if (error) return fail("Adding style", error);

  let sizes = (cat || []).map((c) => ({ size: c.size, sku: c.sku }));
  if (!sizes.length) {
    const typedSizes = prompt(`No catalog sizes for ${styleColor}. Type the sizes separated by commas:`, "XS, S, M, L, XL");
    if (typedSizes === null) { await sb.from("recv_sheet_groups").delete().eq("id", g.id); return; }
    sizes = typedSizes.split(",").map((s) => s.trim()).filter(Boolean).map((s) => ({ size: s, sku: null }));  // off-catalog: no invented SKU
  }
  sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size));

  const rows = sizes.map((s, i) => ({
    sheet_id: sheet.id, group_id: g.id, sku: s.sku, size: s.size, sort_order: i,
  }));
  const { error: e2 } = await sb.from("recv_sheet_lines").insert(rows);
  if (e2) return fail("Adding sizes", e2);
  $("skuInput").value = "";
  openSheet(sheet.id);
}

/* Rough size ordering so a sheet reads youth -> adult like the paper one. */
const SIZE_ORDER = ["YXS","YXXS","YS","YM","YL","YXL","Y4","Y6","Y8","Y10","Y12","Y14","Y16",
  "XXS","XS","AXS","S","AS","S/M","M","AM","L","AL","L/XL","XL","AXL","XXL","A2XL","2XL",
  "XXXL","A3XL","3XL","A4XL","4XL","4XLT","5XL","A5XL","OS","OSFA","OSFM","1SZ","Adjustable"];
function sizeRank(s) {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i >= 0) return i;
  const j = SIZE_ORDER.indexOf(String(s));
  if (j >= 0) return j;
  const num = parseFloat(s);
  return Number.isFinite(num) ? 500 + num : 900;
}

/* ---------------- email draft ---------------- */
/* Pure formatter so the wording can be unit-tested against Karley's two
   reference emails. blocks = [{styleColor, rows:[{size,counted,po,d}]}] */
export function composeEmail({ po, adj, greeting = "Hi Tristan,", blocks }) {
  const offRows = blocks.flatMap((b) => b.rows.filter((r) => r.d !== 0));
  const text = [], html = [];
  let subject;

  if (adj && offRows.length) {
    // ---- Example 2: an inventory adjustment was made ----
    subject = `PO ${po}`;
    if (offRows.length === 1) {
      const o = offRows[0];
      const dir = o.d < 0 ? "subtracting" : "adding";
      const line = `On PO ${po} I received all items in full but was off by ${Math.abs(o.d)} in size ${o.size}. ` +
        `I counted ${o.counted}, the PO listed ${o.po} purchased, count was off ${o.d}. ` +
        `I did an inventory adjustment ${dir} ${Math.abs(o.d)} for the difference. ` +
        `Inventory Adjustment number is #${adj} if needed.`;
      text.push(line); html.push(esc(line));
    } else {
      const head = `On PO ${po} I received all items in full but was off in ${offRows.length} sizes:`;
      text.push(head); html.push(esc(head));
      offRows.forEach((r) => {
        const l = `${r.size} counted ${r.counted}, the PO listed ${r.po} purchased, count was off ${r.d}`;
        text.push(l); html.push("<strong>" + esc(l) + "</strong>");
      });
      const tail = `I did an inventory adjustment for the difference. Inventory Adjustment number is #${adj} if needed.`;
      text.push("", tail); html.push("", esc(tail));
    }
    return { subject, text: text.join("\n"), html: html.join("<br>") };
  }

  // ---- Example 1: discrepancies, asking Tristan how to proceed ----
  subject = offRows.length ? `PO# ${po} Discrepancies` : `PO# ${po} counts matched`;
  const single = blocks.length === 1 ? blocks[0].styleColor : null;
  text.push(greeting, ""); html.push(esc(greeting), "");

  const intro = offRows.length
    ? (single
        ? `I am working on PO# ${po} item is ${single} and have these discrepancies.  ` +
          `Would you like me to do an inventory adjustment or is there more stock I am missing?`
        : `I am working on PO# ${po} and have these discrepancies.  ` +
          `Would you like me to do an inventory adjustment or is there more stock I am missing?`)
    : `I finished PO# ${po}` + (single ? ` (${single})` : "") + ` and every size matched the PO.`;
  text.push(intro, "", "Here are my counts:");
  html.push(esc(intro), "", esc("Here are my counts:"));

  blocks.forEach((b) => {
    if (!single) {
      text.push("", b.styleColor);
      html.push("", "<strong>" + esc(b.styleColor) + "</strong>");
    }
    b.rows.forEach((r) => {
      if (r.d === 0) {
        const l = `${r.size} was good`;
        text.push(l); html.push(esc(l));
      } else {
        const l = `${r.size} counted ${r.counted} PO has ${r.po} off by ${r.d}`;
        text.push(l); html.push("<strong>" + esc(l) + "</strong>");
      }
    });
  });
  return { subject, text: text.join("\n"), html: html.join("<br>") };
}

$("genEmailBtn").addEventListener("click", buildEmail);

let emailEdited = false;
["emailSubject", "emailBody"].forEach((id) => {
  $(id)?.addEventListener("input", () => { emailEdited = true; });
});

function buildEmail() {
  if (!sheet) return;
  if (emailEdited &&
      !confirm("Rebuilding replaces the draft and loses your edits. Rebuild anyway?")) return;
  const po  = ($("sheetPo").value  || sheet.po_number || "").trim();
  const adj = ($("sheetAdj").value || "").trim();

  const blocks = groups.map((g) => ({
    styleColor: g.style_color,
    rows: lines
      .filter((l) => l.group_id === g.id && l.po_qty != null)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({
        size: sizeLabel(l.size), counted: l.counted_qty || 0,
        po: l.po_qty, d: (l.counted_qty || 0) - l.po_qty,
      })),
  })).filter((b) => b.rows.length);

  if (!blocks.length) { toast("Enter PO quantities first — there's nothing to compare."); return; }

  const out = composeEmail({ po, adj, greeting: settings.email_greeting || "Hi Tristan,", blocks });
  buildEmail._text = out.text; buildEmail._html = out.html; buildEmail._subject = out.subject;

  $("emailSubject").textContent = out.subject;
  $("emailBody").innerHTML = out.html;
  emailEdited = false;
  $("emailOut").hidden = false;
  $("copyEmailBtn").hidden = false;
  if (!settings.email_to) toast("Draft built. Set the recipient in Admin before sending.");
}

$("copyEmailBtn").addEventListener("click", async () => {
  const to = settings.email_to || "", cc = settings.email_cc || "";
  // read what is on screen, not what was generated - the boxes are editable
  const subject = ($("emailSubject").innerText || "").trim();
  const text = $("emailBody").innerText || "";
  const html = $("emailBody").innerHTML || "";
  const header = (to ? `To: ${to}\n` : "") + (cc ? `Cc: ${cc}\n` : "") +
    `Subject: ${subject}\n\n`;
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([header + text], { type: "text/plain" }),
        "text/html":  new Blob([html], { type: "text/html" }),
      })]);
    } else {
      await navigator.clipboard.writeText(header + text);
    }
    toast("Draft copied — bold survives a paste into Gmail");
  } catch (e) { fail("Copying", e); }
});


/* ---------------- comments ---------------- */
async function loadComments() {
  const { data, error } = await sb.from("recv_comments")
    .select("*, recv_people(name)").eq("sheet_id", sheet.id).order("created_at");
  if (error) return fail("Loading comments", error);
  const box = $("commentList"); box.textContent = "";
  if (!(data || []).length) { box.append(el("p", "muted sm", "No comments yet.")); return; }
  data.forEach((c) => {
    const d = el("div", "comment");
    const h = el("p", "who", c.recv_people?.name || "someone");
    h.append(el("span", "when", "  " + when(c.created_at)));
    d.append(h, el("p", "body", c.body));
    if (c.author_id === me.id || isAdmin) {
      const rm = el("button", "linkish sm", "delete");
      rm.addEventListener("click", async () => {
        const { error } = await sb.from("recv_comments").delete().eq("id", c.id);
        if (error) return fail("Deleting comment", error);
        loadComments();
      });
      d.append(rm);
    }
    box.append(d);
  });
}
$("commentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("commentBody").value.trim(); if (!body) return;
  const { error } = await sb.from("recv_comments")
    .insert({ sheet_id: sheet.id, body, author_id: me.id });
  if (error) return fail("Posting comment", error);
  $("commentBody").value = ""; loadComments();
});

/* ---------------- change log ---------------- */
async function loadAudit() {
  const { data, error } = await sb.from("recv_audit")
    .select("*, recv_people(name)").eq("sheet_id", sheet.id)
    .order("created_at", { ascending: false }).limit(80);
  if (error) return;
  const box = $("auditList"); box.textContent = "";
  const n = (data || []).length;
  const meta = $("auditCount");
  if (meta) meta.textContent = n ? `${n} change${n === 1 ? "" : "s"}` : "no changes yet";
  if (!n) { box.append(el("p", "muted sm", "No changes recorded yet.")); return; }
  data.forEach((a) => {
    const r = el("div", "audit-row");
    r.append(el("b", null, a.recv_people?.name || "someone"));
    r.append(el("span", null, `${a.field}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`));
    r.append(el("span", null, when(a.created_at)));
    box.append(r);
  });
}

/* ---------------- procedure document ---------------- */
const DEFAULT_DOC = [
  { title: "Unload the truck into receiving", body: "Bring every carton off the trailer and into the receiving area before you count anything." },
  { title: "Sort by style number, then color, then size", body: "Break the cartons down and group like with like, in that order: all of one style number together, split by color inside the style, split by size inside the color. note: cartons can be mixed." },
  { title: "Count every size stack and write it down", body: "Count each style + color + size stack and record the number on the count sheet as you go.", flag: "Don't look up the PO quantities until your counts are written down. If you know the number you're supposed to get, you'll find that number. Write your count first, then go to step 4.", critical: true },
  { title: "Find the PO in NetSuite", body: "Look this up through putting the PO# on the box into the search bar on NetSuite and selecting the entry that says purchase order or if the PO# is unknown go to items view in NetSuite type in the style#-color you are looking for, once it loads click any size you are looking to receive by the view button → then go to related records and under PO search look for the most recent PO#." },
  {
    title: "Match your counts to the PO#",
    kind: "decision",
    stepA: {
      heading: "Something's off — report it, then wait",
      body: "Email Karley and Tristan with the discrepancy. Don't adjust anything and don't guess at the fix — wait for one of them to tell you which way to go.",
      sendLabel: "Put this in the email — one line per size that's off",
      fields: ["PO #", "Style #", "Color", "Size", "My count", "PO qty", "Over / short by"],
    },
    lanes: [
      { tone: "adjust", tag: "If Tristan says adjust", heading: "Make the inventory adjustment",
        body: ["Enter the adjustment in NetSuite so the system matches what is physically on the floor. Reference the PO number and the reason on the adjustment so it can be traced later.", "Then continue to step 6."],
        howLabel: "How to do it in NetSuite",
        how: [
          "Click the \u2605 at the top left of your screen and choose Inventory Adjustments.",
          "Click New Transaction.",
          "Adjustment Account: 500000 COGS.",
          "Memo: make this descriptive. Always include the PO# and say what is off that you are adjusting.",
          "Under Classification, set Adjustment Location to JFK Warehouse.",
          "Under Item, type the style-color-size exactly, then click the size that populates.",
          "On that line go to Location and select JFK Warehouse. Qty. On Hand fills in with what we currently have.",
          "In Adjust Qty. By, enter the amount you are adjusting. Negative numbers always include a minus sign (-12). Positive numbers are just the whole number (12) \u2014 no plus sign.",
          "Check the New Quantity that populates. If it is correct, hit Save.",
        ] },
      { tone: "hold", tag: "If Tristan says hold", heading: "Leave the shortage open",
        body: ["More stock is on its way. Do not adjust — leave the outstanding quantity open on the PO so the rest of the shipment can be received against it.", "Shelve what did arrive, and keep this sheet with the PO until the balance lands."] },
    ],
    stepB: "If everything matches, receive it and move to the next step.",
  },
  { title: "Box it, label it, shelve it — same day", body: "Everything you receive gets boxed, labeled and put on its shelf with bin location as soon as it's received. Box labels are four lines: SKU · item name · color · size → ask Karley to print these.", flag: "* if the item is existing refill boxes" },
  { title: "Release backorders to the queue → let Karley know of any shipments received.", body: "Once the stock is received in NetSuite, the orders that were backordered against it go to the queue. Do this the same day the stock is received." },
  { title: "Overstock goes to overstock — and gets recorded", body: "Anything that won't fit in the pick bin goes to an overstock location. Write the overstock location on the sheet, then record it in NetSuite.", flag: "Set the pick bin and overstock bin on the individual size — the child item — not on the parent style number." },
];

let docSteps = [];
// The procedure comes from DEFAULT_DOC above and nowhere else. It is not read
// from the database, so no row inserted there can override the steps, and
// nothing in the app can edit, reorder or delete them. Karley maintains the
// wording in this file.
async function loadDoc() {
  docSteps = DEFAULT_DOC;
  $("docTitle").textContent = "Truck Receiving Procedure";
  $("docMeta").textContent = "Tick each step off as you work through the truck.";
  renderDoc();
}
const PROGRESS_KEY = "recv-procedure-progress";
function readProgress() {
  try { return new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) || "[]")); }
  catch { return new Set(); }
}
function writeProgress(set) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

function renderDoc() {
  const box = $("docView"); box.textContent = "";
  const done = readProgress();

  // progress header
  const prog = el("div", "doc-progress");
  const count = el("p", "count");
  const bar = el("div", "bar"); const fill = el("i"); bar.append(fill);
  const reset = el("button", "btn ghost sm", "Start over");
  reset.addEventListener("click", () => { writeProgress(new Set()); renderDoc(); });
  prog.append(count, bar, reset);
  box.append(prog);

  const paintProgress = () => {
    const d = readProgress().size, t = docSteps.length;
    count.textContent = `${d} of ${t} done`;
    fill.style.width = t ? `${Math.round((d / t) * 100)}%` : "0%";
  };

  docSteps.forEach((stp, i) => {
    const d = el("div", "doc-step" + (done.has(i) ? " done" : ""));

    const num = el("button", "n", done.has(i) ? "\u2713" : String(i + 1));
    num.type = "button";
    num.title = done.has(i) ? "Mark this step as not done" : "Mark this step done";
    num.setAttribute("aria-pressed", done.has(i) ? "true" : "false");
    num.addEventListener("click", () => {
      const cur = readProgress();
      if (cur.has(i)) cur.delete(i); else cur.add(i);
      writeProgress(cur);
      d.classList.toggle("done", cur.has(i));
      num.textContent = cur.has(i) ? "\u2713" : String(i + 1);
      num.setAttribute("aria-pressed", cur.has(i) ? "true" : "false");
      paintProgress();
    });
    d.append(num);

    const c = el("div");
    c.append(el("h3", null, stp.title || ""));
    if (stp.body) {
      const p = el("p");
      p.innerHTML = esc(stp.body).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      c.append(p);
    }
    if (stp.kind === "decision") c.append(renderDecision(stp));
    if (stp.flag) c.append(el("span", "flag" + (stp.critical ? " critical" : ""), stp.flag));
    d.append(c);
    box.append(d);
  });

  paintProgress();
}

function renderDecision(stp) {
  const wrap = el("div", "decision");

  if (stp.stepA) {
    const a = el("div", "substep");
    a.append(el("p", "substep-tag", "Step A"));
    a.append(el("h5", null, stp.stepA.heading || ""));
    if (stp.stepA.body) a.append(el("p", null, stp.stepA.body));
    if (stp.stepA.fields?.length) {
      const send = el("div", "send");
      send.append(el("b", null, stp.stepA.sendLabel || "Put this in the email"));
      const chips = el("div", "send-chips");
      stp.stepA.fields.forEach((f) => chips.append(el("span", null, f)));
      send.append(chips);
      a.append(send);
    }
    wrap.append(a);
  }

  if (stp.lanes?.length) {
    const lanes = el("div", "lanes");
    stp.lanes.forEach((ln) => {
      const l = el("div", "lane " + (ln.tone || ""));
      l.append(el("p", "lane-tag", ln.tag || ""));
      l.append(el("h5", null, ln.heading || ""));
      (Array.isArray(ln.body) ? ln.body : [ln.body]).filter(Boolean)
        .forEach((t) => l.append(el("p", null, t)));
      if (ln.how?.length) {
        const det = el("details", "how");
        det.append(el("summary", null, ln.howLabel || "Step by step"));
        const ol = el("ol");
        ln.how.forEach((step) => ol.append(el("li", null, step)));
        det.append(ol);
        l.append(det);
      }
      lanes.append(l);
    });
    wrap.append(lanes);
  }

  if (stp.stepB) {
    const b = el("div", "substep-b");
    b.append(el("p", "substep-tag", "Step B"));
    b.append(el("p", null, stp.stepB));
    wrap.append(b);
  }
  return wrap;
}
// The procedure is deliberately read-only in the app. It is maintained in
// DEFAULT_DOC in this file so the steps cannot be changed, reordered or
// deleted by anyone using the site.

/* ---------------- admin ---------------- */
async function loadAdmin() {
  const [{ data: inv }, { data: cat }, { data: sz }] = await Promise.all([
    sb.from("recv_invited_emails").select("*").order("email"),
    sb.from("recv_catalog").select("sku", { count: "exact", head: true }),
    sb.from("recv_size_labels").select("*").order("ns_size"),
  ]);
  const box = $("inviteList"); box.textContent = "";
  (inv || []).forEach((r) => {
    const d = el("div", "invite-row");
    d.append(el("span", null, `${r.email}${r.name ? " · " + r.name : ""}${r.is_admin ? " · admin" : ""}`));
    const rm = el("button", "linkish sm", "remove");
    rm.addEventListener("click", async () => {
      if (!confirm(`Remove the invite for ${r.email}?`)) return;
      const { error } = await sb.from("recv_invited_emails").delete().eq("email", r.email);
      if (error) return fail("Removing invite", error);
      loadAdmin();
    });
    d.append(rm); box.append(d);
  });

  paintCatalogStat();

  $("setTo").value = settings.email_to || "";
  $("setCc").value = settings.email_cc || "";
  refreshNotifStatus();

  const sbox = $("sizeList"); sbox.textContent = "";
  (sz || []).forEach((r) => {
    const d = el("div", "invite-row");
    d.append(el("span", null, `${r.ns_size} → ${r.display_label}`));
    const rm = el("button", "linkish sm", "remove");
    rm.addEventListener("click", async () => {
      const { error } = await sb.from("recv_size_labels").delete().eq("ns_size", r.ns_size);
      if (error) return fail("Removing alias", error);
      await loadSizeAliases(); loadAdmin();
    });
    d.append(rm); sbox.append(d);
  });
}

$("inviteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("inviteEmail").value.trim().toLowerCase();
  const { error } = await sb.from("recv_invited_emails").insert({
    email, name: $("inviteName").value.trim() || null, is_admin: $("inviteAdmin").checked,
  });
  if (error) return fail("Inviting", error);
  $("inviteEmail").value = ""; $("inviteName").value = ""; $("inviteAdmin").checked = false;
  toast("Invited — they sign in with their Hub password");
  loadAdmin();
});

$("sizeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.from("recv_size_labels").upsert({
    ns_size: $("sizeNs").value.trim(), display_label: $("sizeLabel").value.trim(),
  }, { onConflict: "ns_size" });
  if (error) return fail("Saving alias", error);
  $("sizeNs").value = ""; $("sizeLabel").value = "";
  await loadSizeAliases(); loadAdmin();
});

/* ---------------- push notifications ---------------- */
/* Same VAPID sender as the Warehouse Hub, so one key pair covers both apps. */
const VAPID_PUBLIC_KEY = "BDi981JGUQQj-XjQ61ONOw7Mq2T2m3KIJKJN2G_tgtwBYyAyF57sPxTvC_OwWZrWOzmszV5tJPXATI5zGDNFHd0";

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/* Show the banner only when this device could subscribe but hasn't. */
async function maybeShowNotifBanner() {
  const banner = $("notifBanner");
  if (!banner) return;
  const dismissedAt = Number(localStorage.getItem("recv-notif-dismissed") || 0);
  const recentlyDismissed = dismissedAt && (Date.now() - dismissedAt) < 14 * 86400_000;
  const denied = ("Notification" in window) && Notification.permission === "denied";
  if (denied || recentlyDismissed) { banner.hidden = true; return; }

  const hint = $("iosHint");
  if (isIOS && !isInstalled()) {          // Safari tab on iPhone: can't subscribe until installed
    if (hint) { hint.textContent = IOS_HINT; hint.hidden = false; }
    $("notifOn").hidden = true;
    banner.hidden = false; return;
  }
  if (hint) hint.hidden = true;
  $("notifOn").hidden = false;
  if (!pushSupported()) { banner.hidden = true; return; }
  const sub = await currentSubscription();
  const registered = sub && (await isRegistered(sub.endpoint));
  banner.hidden = !!registered;
}

async function isRegistered(endpoint) {
  const { data } = await sb.rpc("recv_has_push", { p_endpoint: endpoint });
  return data === true;
}

/* iOS only allows web push once the site is installed to the Home Screen. */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isInstalled = () => window.navigator.standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const IOS_HINT = "On iPhone or iPad: tap Share, then \"Add to Home Screen\", open Receiving from your home screen, then tap Turn on.";

async function enableNotifications() {
  if (isIOS && !isInstalled()) { toast(IOS_HINT); return false; }
  if (!pushSupported()) { toast("This browser can't do notifications"); return false; }
  try {
    const perm = Notification.permission === "granted"
      ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications stayed off"); return false; }

    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const { error } = await sb.rpc("recv_claim_push", {
      p_endpoint: sub.endpoint, p_subscription: sub.toJSON(),
    });
    if (error) throw error;
    localStorage.removeItem("recv-notif-dismissed");
    $("notifBanner").hidden = true;
    toast("Notifications on for this device");
    refreshNotifStatus();
    return true;
  } catch (e) { fail("Turning on notifications", e); return false; }
}

async function disableNotifications() {
  const sub = await currentSubscription();
  if (sub) {
    await sb.rpc("recv_release_push", { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  toast("Notifications off for this device");
  refreshNotifStatus();
  maybeShowNotifBanner();
}

async function paintNotifTop(state) {
  const b = $("notifTop"), icon = $("notifTopIcon"), label = $("notifTopLabel");
  if (!b) return;
  b.classList.remove("on", "off", "blocked");
  if (state === "unsupported") { b.hidden = true; return; }
  b.hidden = false;
  if (state === "blocked") {
    b.classList.add("blocked"); icon.innerHTML = "&#128263;"; label.textContent = "Blocked";
    b.title = "Notifications are blocked in this browser's settings for this site";
  } else if (state === "on") {
    b.classList.add("on"); icon.innerHTML = "&#128276;"; label.textContent = "Notifications On";
    b.title = "Notifications are ON for this device - click to turn off";
  } else {
    b.classList.add("off"); icon.innerHTML = "&#128277;"; label.textContent = "Notifications";
    b.title = "Turn on notifications for this device";
  }
}

async function refreshNotifStatus() {
  // top-bar button first: it exists for everyone, the Admin panel text does not
  if (!pushSupported()) { paintNotifTop("unsupported"); }
  else if (Notification.permission === "denied") { paintNotifTop("blocked"); }
  else {
    const s0 = await currentSubscription();
    paintNotifTop(s0 && (await isRegistered(s0.endpoint)) ? "on" : "off");
  }

  const n = $("notifStatus"); if (!n) return;
  if (isIOS && !isInstalled()) { n.textContent = IOS_HINT; return; }
  if (!pushSupported()) { n.textContent = "This browser doesn't support notifications."; return; }
  if (Notification.permission === "denied") {
    n.textContent = "Notifications are blocked in this browser's site settings.";
    return;
  }
  const sub = await currentSubscription();
  const on = sub && (await isRegistered(sub.endpoint));
  n.textContent = on ? "Notifications are ON for this device." : "Notifications are off for this device.";
  const b = $("notifManage");
  if (b) b.textContent = on ? "Turn off on this device" : "Turn on for this device";
}

$("notifOn")?.addEventListener("click", enableNotifications);
$("notifNo")?.addEventListener("click", () => {
  localStorage.setItem("recv-notif-dismissed", String(Date.now()));
  $("notifBanner").hidden = true;
});
$("notifTop")?.addEventListener("click", async () => {
  if (Notification.permission === "denied") {
    toast("Notifications are blocked for this site in your browser settings");
    return;
  }
  const sub = await currentSubscription();
  const on = sub && (await isRegistered(sub.endpoint));
  if (on) await disableNotifications(); else await enableNotifications();
  refreshNotifStatus();
});

$("notifManage")?.addEventListener("click", async () => {
  const sub = await currentSubscription();
  const on = sub && (await isRegistered(sub.endpoint));
  if (on) disableNotifications(); else enableNotifications();
});

/* ---------------- admin: catalog sync ---------------- */
/* Full date and time, e.g. "Thu, Sep 11, 2026 at 8:59 AM" */
function stamp(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })
       + " at " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function paintCatalogStat() {
  await loadSettings();
  const { count } = await sb.from("recv_catalog").select("*", { count: "exact", head: true });
  const raw = String(settings.catalog_sync_status || "");
  const node = $("catalogStat");

  // A sync in progress reports its running total; show that instead.
  const running = raw.match(/running[^0-9]*([\d,]+)/i);
  if (running) {
    node.textContent = `Syncing from NetSuite now - ${Number(running[1].replace(/,/g, "")).toLocaleString()} SKUs so far...`;
    node.style.color = "var(--amber)";
    return;
  }

  // A failed run should say so plainly rather than be buried.
  if (/^(error|failed)/i.test(raw)) {
    node.textContent = "Last sync failed. Press Sync from NetSuite now to try again.";
    node.style.color = "var(--pink)";
    return;
  }

  if (!count) {
    node.textContent = "No items yet - press Sync from NetSuite now to load the catalog.";
    node.style.color = "var(--pink)";
    return;
  }

  // style-colour count is parsed out of the status line rather than echoed,
  // so the function's own wording never leaks into the UI
  const sc = raw.match(/([\d,]+)\s*style-colors/i);
  const scText = sc ? ` across ${Number(sc[1].replace(/,/g, "")).toLocaleString()} style-colors` : "";
  const when_ = settings.catalog_synced_at ? `Last synced ${stamp(settings.catalog_synced_at)}.` : "";

  node.textContent = `${count.toLocaleString()} SKUs${scText}. ${when_}`.trim();

  const stale = settings.catalog_synced_at &&
    (Date.now() - new Date(settings.catalog_synced_at).getTime()) > 8 * 86400_000;
  node.style.color = stale ? "var(--pink)" : "";
  if (stale) node.textContent += " That is more than a week ago - the nightly sync may have stopped.";
}

$("syncNowBtn")?.addEventListener("click", async () => {
  const b = $("syncNowBtn"); b.disabled = true;
  const { data, error } = await sb.functions.invoke("recv-sync-catalog", { body: { months: 18 } });
  if (error) { b.disabled = false; return fail("Starting sync", error); }
  toast(data?.started ? "Sync started — runs in the background" : (data?.status || "Sync already running"));
  // poll the status the function writes into recv_settings
  let ticks = 0;
  const timer = setInterval(async () => {
    await paintCatalogStat();
    const st = settings.catalog_sync_status || "";
    if (++ticks > 48 || !st.startsWith("running")) {   // ~4 min max
      clearInterval(timer); b.disabled = false;
      if (st.startsWith("ok")) toast("Catalog synced");
      else if (st.startsWith("failed")) toast(st.slice(0, 120));
    }
  }, 5000);
});

/* ---------------- admin: email recipients ---------------- */
$("emailForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const rows = [
    { key: "email_to", value: $("setTo").value.trim() },
    { key: "email_cc", value: $("setCc").value.trim() },
  ];
  const { error } = await sb.from("recv_settings").upsert(rows, { onConflict: "key" });
  if (error) return fail("Saving email settings", error);
  await loadSettings();
  toast(settings.email_to ? "Email settings saved" : "Saved — but 'send to' is still empty");
});

/* ---------------- password reset ---------------- */
const APP_ORIGIN = location.origin + location.pathname.replace(/index\.html$/, "");

$("forgotToggle")?.addEventListener("click", async () => {
  const email = ($("authEmail").value || "").trim().toLowerCase();
  if (!email) {
    $("authErr").textContent = "Type your email address above first, then click Forgot your password.";
    $("authErr").hidden = false;
    $("authEmail").focus();
    return;
  }
  $("authErr").hidden = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: APP_ORIGIN });
  if (error) { $("authErr").textContent = error.message; $("authErr").hidden = false; return; }
  $("authErr").textContent = "Check " + email + " for a reset link. It may take a minute, and check junk mail.";
  $("authErr").hidden = false;
});

// Supabase sends the user back here with a recovery token in the URL.
sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    $("authGate").hidden = false;
    $("app").hidden = true;
    $("authForm").hidden = true;
    $("resetForm").hidden = false;
  }
});

$("resetForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("newPass").value, b = $("newPass2").value;
  $("resetErr").hidden = true;
  if (a !== b) { $("resetErr").textContent = "Those two passwords don't match."; $("resetErr").hidden = false; return; }
  if (a.length < 8) { $("resetErr").textContent = "Use at least 8 characters."; $("resetErr").hidden = false; return; }
  $("resetBtn").disabled = true;
  const { error } = await sb.auth.updateUser({ password: a });
  $("resetBtn").disabled = false;
  if (error) { $("resetErr").textContent = error.message; $("resetErr").hidden = false; return; }
  $("resetForm").hidden = true;
  $("authForm").hidden = false;
  $("authErr").textContent = "Password updated. Sign in with your new password.";
  $("authErr").hidden = false;
  history.replaceState(null, "", APP_ORIGIN);
});

// Local-only preview hook: renders the default procedure without a login so
// the layout can be checked while developing. Inert on the live site.
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  window.__previewDoc = () => { docSteps = DEFAULT_DOC; renderDoc(); };
  window.__previewList = (list) => { sheets = list; renderSheets(); };
  window.__previewSheet = (d) => {
    sheet = d.sheet; groups = d.groups; lines = d.lines; boxes = d.boxes;
    renderGroups(); renderTotals();
  };
}

/* ---------------- "items received" email to Karley ---------------- */
function buildReceivedEmail() {
  const po = ($("sheetPo").value || sheet.po_number || "").trim();
  // On a Partially Received sheet only the saved style-colors have actually
  // come in, so those are the ones Karley is told about. On a fully received
  // sheet every style on it is included.
  const partial = sheet.status === "partial";
  let items;
  if (partial) {
    // group the sizes somebody marked Received under their style-color
    items = groups.map((g) => {
      const got = lines.filter((l) => l.group_id === g.id && l.received === true)
                       .sort((a, b) => a.sort_order - b.sort_order)
                       .map((l) => sizeLabel(l.size));
      return got.length ? `${g.style_color} (${got.join(", ")})` : null;
    }).filter(Boolean);
    if (!items.length) items = groups.filter((g) => g.saved).map((g) => g.style_color);
  } else {
    items = groups.map((g) => g.style_color);
  }
  const to = settings.email_cc || "";
  let subject, body;
  if (items.length === 1) {
    subject = `${items[0]} received - PO# ${po}`;
    body = `Hi Karley,\n\n${items[0]} has been received. PO# ${po}.`;
  } else if (items.length > 1) {
    subject = `PO# ${po} received`;
    body = `Hi Karley,\n\nThese have been received on PO# ${po}:\n` +
           items.map((i) => `  ${i}`).join("\n");
  } else {
    subject = `PO# ${po} received`;
    body = `Hi Karley,\n\nPO# ${po} has been received.`;
  }
  return { subject, body, to, items };
}

function offerReceivedEmail() {
  if (!sheet) return;
  const { subject, body, items } = buildReceivedEmail();
  const stateName = statusLabel(sheet.status);
  const unsaved = groups.filter((g) => !g.saved).length;
  $("receivedWhat").textContent = items.length
    ? `This sheet is now marked ${stateName}. Send Karley a note that ` +
      `${items.length === 1 ? items[0] + " has" : items.length + " styles have"} come in?` +
      (sheet.status === "partial" && unsaved
        ? ` ${unsaved} style${unsaved === 1 ? " is" : "s are"} still open and not included.`
        : "")
    : `This sheet is now marked ${stateName}. Send Karley a note?`;
  $("receivedSubject").textContent = subject;
  $("receivedBody").textContent = body;
  $("receivedModal").hidden = false;
  $("receivedCopy").focus();
}

function closeReceivedModal() { $("receivedModal").hidden = true; }
$("receivedSkip")?.addEventListener("click", closeReceivedModal);
$("receivedModal")?.addEventListener("click", (e) => {
  if (e.target === $("receivedModal")) closeReceivedModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("receivedModal")?.hidden) closeReceivedModal();
});
$("receivedCopy")?.addEventListener("click", async () => {
  const { subject, body, to } = buildReceivedEmail();
  const header = (to ? `To: ${to}\n` : "") + `Subject: ${subject}\n\n`;
  try {
    await navigator.clipboard.writeText(header + body);
    toast(to ? "Email copied - paste it to " + to : "Email copied");
  } catch (e) { fail("Copying", e); }
  closeReceivedModal();
});


/* ---------------- delete a sheet (admins only) ---------------- */
/* The database enforces this too: the recv_sheets delete policy requires
   recv_is_admin(), so hiding the button is convenience, not the control. */
$("deleteSheetBtn")?.addEventListener("click", () => {
  if (!sheet || !isAdmin) return;
  const sizes = lines.length;
  const counted = lines.reduce((n, l) => n + (l.counted_qty || 0), 0);
  $("deleteWhat").textContent =
    `"${sheet.title || "(untitled)"}" - PO# ${sheet.po_number || "-"}, ` +
    `${groups.length} style-color${groups.length === 1 ? "" : "s"}, ` +
    `${sizes} size row${sizes === 1 ? "" : "s"}, ${counted} counted.`;
  $("deleteModal").hidden = false;
  $("deleteCancel").focus();
});

function closeDeleteModal() { $("deleteModal").hidden = true; }
$("deleteCancel")?.addEventListener("click", closeDeleteModal);
$("deleteModal")?.addEventListener("click", (e) => {
  if (e.target === $("deleteModal")) closeDeleteModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("deleteModal")?.hidden) closeDeleteModal();
});

$("deleteConfirm")?.addEventListener("click", async () => {
  if (!sheet) return;
  $("deleteConfirm").disabled = true;
  const { error } = await sb.from("recv_sheets").delete().eq("id", sheet.id);
  $("deleteConfirm").disabled = false;
  if (error) { closeDeleteModal(); return fail("Deleting sheet", error); }
  closeDeleteModal();
  toast("Sheet deleted");
  sheet = null; groups = []; lines = []; boxes = [];
  show("sheets");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === "sheets"));
  loadSheets();
});


boot();