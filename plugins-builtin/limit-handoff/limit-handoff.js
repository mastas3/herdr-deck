"use strict";
// Limit handoff in the page: a small bar when an account passes the threshold (default 90% of a 5-hour or weekly
// window, from the deck's usage readings) or an agent printed its limit line, and the handoff dialog: pick who
// continues, get a note (asked from the agent after a confirm, or built from its transcript), then the New session
// dialog opens prefilled. Server: plugins-builtin/limit-handoff/server.ts. Top-level names start with lh.
const lhS = { threshold: 90, hits: {}, dismissed: load("lhDismiss", {}), timer: 0 };
const LH_NAME = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };
const lhOther = (agent) => (agent === "codex" ? "claude" : "codex");

// ── what needs a handoff (pure but for S) ──
/** Accounts past the threshold and sessions that printed a limit line, each with the sessions it affects. */
function lhAlerts(now = Date.now()) {
  const out = [];
  const rows = [...S.rows.values()].filter((r) => (r.agent === "claude" || r.agent === "codex") && !r.empty);
  for (const r of rows) if (lhS.hits[r.key]) out.push({ id: `hit:${r.key}`, keys: [r.key], hard: true, why: lhS.hits[r.key] });
  const byAcct = new Map();
  for (const r of rows) {
    if (lhS.hits[r.key] || typeof accountFor !== "function") continue;
    const a = accountFor(r, S.usage, S.self);
    if (!a?.windows?.length) continue;
    for (const w0 of a.windows) {
      const w = windowNow(w0, now);
      if (w.pct == null || w.pct < lhS.threshold) continue;
      const id = `acct:${a.id ?? a.name}:${w.id ?? w.label}:${w.resets ?? ""}`;
      if (!byAcct.has(id)) byAcct.set(id, { id, keys: [], hard: false, why: `${a.label || a.name} ${w.label} limit at ${Math.round(w.pct)}%`, until: w.resets });
      if (!byAcct.get(id).keys.includes(r.key)) byAcct.get(id).keys.push(r.key);
    }
  }
  return [...out, ...byAcct.values()].filter((x) => !(lhS.dismissed[x.id] > now));
}

function lhRenderBar() {
  let bar = document.getElementById("lhBar");
  const list = lhAlerts();
  if (!list.length) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "lhBar"; bar.setAttribute("role", "status"); document.body.append(bar); motion.enter(bar, "rise"); }
  const one = (x) => {
    const r = rowOf(x.keys[0]);
    const who = x.keys.length === 1 ? esc(r?.title || r?.project || "a session") : `${x.keys.length} sessions`;
    return `<div class="lhitem ${x.hard ? "hard" : ""}"><span class="lhwhy"><b>${who}</b> ${esc(x.why)}</span>
      <button class="btn primary" data-lhgo="${esc(x.id)}">Continue in ${LH_NAME[lhOther(r?.agent)]}…</button><button class="btn ghost" data-lhnot="${esc(x.id)}">Not now</button></div>`;
  };
  setHTML(bar, list.slice(0, 3).map(one).join(""));
}
function lhDismiss(id) {
  const x = lhAlerts().find((a) => a.id === id);
  lhS.dismissed[id] = x?.until && x.until > Date.now() ? x.until : Date.now() + 2 * 3600_000;
  for (const [k, t] of Object.entries(lhS.dismissed)) if (t < Date.now()) delete lhS.dismissed[k];
  store("lhDismiss", lhS.dismissed);
  lhRenderBar();
}

/** The transcript as the page can read it (any machine); nothing when the session is gone. */
async function lhMessages(key, limit = 120) { try { return (await api("/api/chat", { key, limit })).messages ?? []; } catch { return []; } }

function lhOpen(keys, why = "", hard = false) {
  keys = keys.filter((k) => rowOf(k));
  if (!keys.length) { toast("That session is gone", true); return; }
  let target = lhOther(rowOf(keys[0]).agent), poll = 0;
  const d = document.createElement("dialog");
  d.className = "ask wide lhdlg";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Continue this work elsewhere</h3>
    ${why ? `<p class="lhwhyd">${esc(why)}</p>` : ""}
    <label class="field" ${keys.length > 1 ? "" : "hidden"}><span>Session</span><select name="key">${keys.map((k) => { const r = rowOf(k); return `<option value="${esc(k)}">${esc(r.project)}: ${esc(r.title || r.agent)}</option>`; }).join("")}</select></label>
    <div class="field"><span>Continue in</span><div class="seg" data-lhtarget>${Object.entries(LH_NAME).map(([k, l]) => `<button type="button" data-t="${k}" aria-pressed="${k === target}">${l}</button>`).join("")}</div>
      <span class="hint">You can pick another machine in the next dialog.</span></div>
    <div class="field"><span>Handoff note</span><div class="lhbtns">
      <button type="button" class="btn" data-lhask ${hard ? `disabled title="It has hit its limit and can’t answer"` : ""}>Ask the agent to write it</button>
      <button type="button" class="btn" data-lhbuild>Build it from the transcript</button></div>
      <p class="hint lhwait" hidden></p>
      <textarea name="note" rows="10" hidden placeholder="The note the next agent starts with"></textarea></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok" disabled>Open New session…</button></div></form>`;
  document.body.append(d);
  const f = d.querySelector("form"), note = f.note, okBtn = d.querySelector("button[value=ok]"), wait = d.querySelector(".lhwait");
  const key = () => f.key.value;
  const setNote = (t) => { clearInterval(poll); wait.hidden = true; note.hidden = false; note.value = t; okBtn.disabled = !t.trim(); note.focus(); };
  note.addEventListener("input", () => { okBtn.disabled = !note.value.trim(); });
  d.querySelector("[data-lhtarget]").addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    target = b.dataset.t;
    for (const x of b.parentElement.children) x.setAttribute("aria-pressed", x === b);
  });
  d.querySelector("[data-lhbuild]").addEventListener("click", async () => {
    wait.hidden = false; wait.textContent = "Reading the transcript…";
    try { setNote((await api("/api/limit-handoff", { op: "note", key: key(), target, why, messages: await lhMessages(key()) })).note); }
    catch (e) { wait.textContent = e.message; }
  });
  d.querySelector("[data-lhask]").addEventListener("click", async () => {
    const r = rowOf(key());
    try {
      const { text } = await api("/api/limit-handoff", { op: "ask", key: key(), target });
      if (!await askDialog({ title: `Send this to “${r.title || r.project}”?`, text, ok: "Send" })) return;
      const { askedAt } = await api("/api/limit-handoff", { op: "ask", key: key(), target, send: true, confirmed: true });
      wait.hidden = false;
      const t0 = Date.now();
      clearInterval(poll);
      poll = setInterval(async () => {
        const secs = Math.round((Date.now() - t0) / 1000);
        if (secs > 240) { clearInterval(poll); wait.textContent = "No note after 4 minutes. Build it from the transcript instead."; return; }
        wait.textContent = `Waiting for its note… ${secs}s. You can build it from the transcript instead.`;
        const { note: n } = await api("/api/limit-handoff", { op: "find", askedAt, messages: await lhMessages(key(), 20) }).catch(() => ({}));
        if (n && d.open) setNote(n);
      }, 4000);
    } catch (e) { toast(e.message, true); }
  });
  d.addEventListener("close", () => {
    clearInterval(poll);
    const ok = d.returnValue === "ok", r = rowOf(key()), text = note.value.trim();
    motion.drop(d);
    if (!ok || !r || !text) return;
    openNew({ kind: target, machine: r.machine, cwd: r.projectRoot ?? r.cwd, project: r.project, prompt: text, label: `${(r.title || r.project || "").slice(0, 28)} (cont.)`, title: `Continue in ${LH_NAME[target]}` });
  });
  d.showModal();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("#lhBar [data-lhgo], #lhBar [data-lhnot]");
  if (!t) return;
  if (t.dataset.lhnot) return lhDismiss(t.dataset.lhnot);
  const x = lhAlerts().find((a) => a.id === t.dataset.lhgo);
  if (x) lhOpen(x.keys.sort((a, b) => (b === S.sel) - (a === S.sel) || act(rowOf(b)) - act(rowOf(a))), x.why, x.hard);
});
lhS.timer = setInterval(lhRenderBar, 15_000);

deckPlugins.register("limit-handoff", {
  palette: (q, cur) => (cur && !cur.hist && ["claude", "codex", "opencode"].includes(cur.agent) ? [{ t: `Hand off this session: continue in ${LH_NAME[lhOther(cur.agent)]} or another agent…`, order: 30, run: () => lhOpen([cur.key], lhS.hits[cur.key] ?? "", !!lhS.hits[cur.key]) }] : []),
  state: (fs) => { if (fs.limitHandoff) { lhS.threshold = fs.limitHandoff.threshold; lhS.hits = fs.limitHandoff.hits ?? {}; } setTimeout(lhRenderBar, 0); },
  events: { "limit-handoff": (d) => { lhS.hits = d.hits ?? {}; lhRenderBar(); } },
});
