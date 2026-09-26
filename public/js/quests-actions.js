"use strict";
// Quest board: its actions (start, done, log a number, pick the main quest) and startRun.
// ── actions ──
async function qCall(path, body, ok) {
  try {
    const d = await api(path, body, 120_000);
    if (d?.level) { S.qb.data = d; qSummary(d); }
    if (ok) toast(ok);
    if (S.mode === "quests") renderQuests(true);
    return d;
  } catch (e) { toast(e.message, true); return null; }
}
/** A small form dialog; resolves with the field values, or null. */
function qForm({ title, text = "", fields, ok = "Save", extra = "", cancel = true }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ask wide qdlg";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(title)}</h3>${text ? `<p class="hint">${text}</p>` : ""}${extra}${fields.map((f) => `<label class="qf"><span>${esc(f.label)}</span>${f.multi ? `<textarea class="inp" rows="3" name="${f.name}" placeholder="${esc(f.ph ?? "")}">${esc(f.value ?? "")}</textarea>` : `<input class="inp" name="${f.name}" type="${f.type ?? "text"}" value="${esc(f.value ?? "")}" placeholder="${esc(f.ph ?? "")}" ${f.type === "number" ? 'inputmode="decimal" step="any"' : ""}>`}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}</label>`).join("")}</div><div class="dlg-f">${cancel ? '<button class="btn" value="cancel">Cancel</button>' : '<span class="spacer"></span>'}<button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => { const v = d.returnValue === "ok" ? Object.fromEntries(fields.map((f) => [f.name, d.querySelector(`[name="${f.name}"]`).value.trim()])) : null; d.remove(); resolve(v); });
    d.addEventListener("click", async (e) => { const b = e.target.closest("[data-qlead]"); if (!b) return; e.preventDefault(); b.disabled = true; const r = await qCall("/api/game/log", { kind: "lead", url: b.dataset.qlead, title: b.dataset.t }); if (r) { b.textContent = "Logged ✓"; b.classList.add("ok"); } else b.disabled = false; });
    d.showModal();
    if (!isPhone()) d.querySelector(".inp")?.focus();
  });
}
function qQuest(id) { return S.qb.data?.quests.items.find((q) => q.id === id); }
function qHome() {
  const m = S.qb.data?.main;
  if (!m) return null;
  return projectHome(m.project) ?? (m.root ? { machine: S.self, cwd: m.root, project: m.project } : null);
}
async function qStart(q) {
  if (q.mode === "agent") {
    const h = qHome();
    if (!h) return toast(`No folder found for ${S.qb.data.main.project} on this machine`, true);
    return openNew({ ...h, prompt: q.prompt, title: `Quest: ${q.title}`, label: q.title.slice(0, 40) });
  }
  // Do it yourself: the checklist, with the leads' links; each contacted lead is logged with its link.
  const leads = q.leads ?? [];
  await qForm({ title: q.title, text: esc(q.why), ok: "Close", cancel: false, fields: [],
    extra: `<ol class="qsteps">${q.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>${leads.length ? `<h4 class="qk">The leads</h4><ul class="qleads">${leads.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><small>${esc([l.where, l.author].filter(Boolean).join(" · "))}</small><button type="button" class="btn" data-qlead="${esc(l.url)}" data-t="${esc(l.title)}">I contacted them</button></li>`).join("")}</ul><p class="hint">You write and send every message yourself. “I contacted them” logs the link as your proof.</p>` : ""}<p class="hint">${QI.check} ${esc(q.verify)}</p>` });
}
async function qDone(q) {
  const m = S.qb.data.main?.project;
  if (q.proof === "lead") return qStart(q);
  if (q.proof === "check") return toast("This one completes by itself when the project's checks pass (proof of done).");
  if (q.proof === "milestone") { toast("Mark the milestone unlocked on the project page, with a note."); return openJourney(m); }
  if (q.proof === "sell" || q.proof === "metric") return qLogNumber(q.proof === "sell" ? "paying_customers" : "users");
  const ship = q.proof === "ship";
  const v = await qForm({ title: `Done: ${q.title}`, text: ship ? "A ship needs the live link: a page someone else can open." : "Say who you talked to and one thing they said, or link the thread.", ok: "Check it off",
    fields: ship ? [{ name: "url", label: "Live link", ph: "https://…", type: "url" }, { name: "note", label: "Note (optional)" }] : [{ name: "note", label: "Who, and what they said", multi: true, ph: "Dana, an HD coach: wants transit alerts by email" }, { name: "url", label: "Link (optional)", ph: "https://…", type: "url" }] });
  if (!v) return;
  await qCall("/api/game/quest", { op: "done", id: q.id, url: v.url, note: v.note });
}
async function qLogNumber(metric = "users") {
  const p = S.qb.data?.main?.project;
  if (!p) return toast("Pick a main quest first", true);
  const v = await qForm({ title: `Log a number for ${p}`, text: "Bosses take damage from real numbers. The note is the evidence: where the number came from.", ok: "Log it", fields: [
    { name: "metric", label: "What", value: metric, hint: "users, paying_customers, mrr, revenue…" }, { name: "value", label: "Value now", type: "number" }, { name: "note", label: "Note (where it came from)", ph: "Stripe dashboard: 2 paying" }] });
  if (!v) return;
  if (!v.note || v.note.length < 4) return toast("Add a note: it's the evidence", true);
  try { await api("/api/journey/metric", { project: p, metric: v.metric, value: Number(v.value), note: v.note }); toast("Logged on the project page"); } catch (e) { return toast(e.message, true); }
  await qCall("/api/game", { tz: QTZ, refresh: true });
  setTimeout(() => loadQuests({ force: true, refresh: true }), 1500);
}
async function qLogWin() {
  await qForm({ title: "Log proof", text: "Only what someone else could check counts: a link, or a note that says who and what.", ok: "Close", fields: [],
    cancel: false, extra: `<div class="qwins"><button type="button" class="qwin" data-w="lead">${QI.send}<b>I contacted a lead</b><small>with the link to their post</small></button><button type="button" class="qwin" data-w="talk">${QI.chats}<b>I talked to a user</b><small>who, and what they said</small></button><button type="button" class="qwin" data-w="num">${QI.scroll}<b>A number went up</b><small>users, customers, revenue</small></button></div>` });
}
document.addEventListener("click", async (e) => {
  const w = e.target.closest(".qdlg [data-w]");
  if (!w) return;
  e.preventDefault();
  w.closest("dialog").close();
  const kind = w.dataset.w;
  if (kind === "num") return qLogNumber();
  const v = await qForm(kind === "lead"
    ? { title: "I contacted a lead", ok: "Log it", fields: [{ name: "url", label: "Link to their post or profile", ph: "https://www.reddit.com/r/…", type: "url" }, { name: "note", label: "Note (optional)" }] }
    : { title: "I talked to a user", ok: "Log it", fields: [{ name: "note", label: "Who, and one thing they said", multi: true }, { name: "url", label: "Link (optional)", type: "url" }] });
  if (v) await qCall("/api/game/log", { kind, ...v }, kind === "lead" ? "Lead logged" : "Conversation logged");
});
async function qPickMain(p) {
  let r = await qCall("/api/game/main", { project: p });
  if (r && r.needsConfirm) {
    if (!(await askDialog({ title: `Switch the main quest to ${p}?`, text: r.message, ok: "Switch anyway" }))) return;
    r = await qCall("/api/game/main", { project: p, confirm: true });
  }
  if (r?.ok) { toast(`${p} is your main quest`); S.qb.data = r.board ?? S.qb.data; loadQuests({ force: true }); }
}
async function qSwitch() {
  const d = S.qb.data;
  const opts = [...(d.candidate && d.candidate.project !== d.main?.project ? [d.candidate] : []), ...d.side];
  await qForm({ title: "Switch the main quest", text: "The main quest's proofs count double; the one you switch away from becomes a side quest.", ok: "Close", fields: [],
    cancel: false, extra: `<div class="qpicks">${opts.map((s) => `<button type="button" class="qpickb" data-qmainpick="${esc(s.project)}" style="--pc:${pc(s.project)}"><span class="dot"></span><b>${esc(s.project)}</b><small>${esc(s.pitch || s.stage || "")}</small></button>`).join("")}</div>` });
}
document.addEventListener("click", (e) => { const b = e.target.closest(".qdlg [data-qmainpick]"); if (!b) return; e.preventDefault(); b.closest("dialog").close(); qPickMain(b.dataset.qmainpick); });

$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "quests") return;
  const t = e.target.closest("[data-qmain],[data-qswitch],[data-qopen],[data-qstart],[data-qdone],[data-qreroll],[data-qlogwin],[data-qundo],[data-qretire],[data-qunretire],[data-qgoal],[data-qjudge],[data-qdispute],[data-qach],[data-qlogall],[data-qdefok],[data-qretry]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.qretry != null) { S.qb.err = null; return loadQuests({ force: true }); }
  if (ds.qmain) return qPickMain(ds.qmain);
  if (ds.qswitch != null) return qSwitch();
  if (ds.qopen) { e.preventDefault(); return openJourney(ds.qopen); }
  if (ds.qstart) { const q = qQuest(ds.qstart); return q && qStart(q); }
  if (ds.qdone) { const q = qQuest(ds.qdone); return q && qDone(q); }
  if (ds.qreroll) { t.disabled = true; return qCall("/api/game/quests", { op: "reroll", id: ds.qreroll }, "Rerolled"); }
  if (ds.qlogwin != null) return qLogWin();
  if (ds.qundo) return qCall("/api/game/log", { op: "undo", id: ds.qundo }, "Undone");
  if (ds.qretire) {
    const note = await askDialog({ title: `Retire ${ds.qretire}?`, text: "It leaves the board and counts as pruning (your folder and wiki are untouched). Why is it retired?", input: "", ok: "Retire it" });
    if (note != null) return qCall("/api/game/retire", { project: ds.qretire, note }, `${ds.qretire} retired`);
    return;
  }
  if (ds.qunretire) return qCall("/api/game/retire", { project: ds.qunretire, undo: true }, `${ds.qunretire} is back`);
  if (ds.qgoal != null) {
    const g = await askDialog({ title: "This week's goal", text: "One sentence you could prove on Sunday, e.g. “First paying customer for astra-apple”.", input: S.qb.data.season.goal ?? "", ok: "Set the goal" });
    if (g != null) return qCall("/api/game/week", { goal: g }, g ? "Goal set" : "Goal cleared");
    return;
  }
  if (ds.qjudge != null) { t.disabled = true; t.innerHTML = '<span class="spin"></span> Jev is judging…'; return qCall("/api/game/season", { op: "judge" }); }
  if (ds.qdispute != null) {
    const n = await askDialog({ title: "Dispute Jev's read", text: "What did it miss? This is recorded as feedback on Jev's call.", input: "", ok: "Dispute" });
    if (n != null) return qCall("/api/game/season", { op: "dispute", note: n }, "Disputed");
    return;
  }
  if (ds.qach) {
    const a = S.qb.data.achievements.find((x) => x.id === ds.qach);
    if (!a) return;
    return qForm({ title: a.title, ok: "Close", cancel: false, fields: [], extra: `<div class="qachd${a.at ? " got" : ""}"><span class="qai">${QI[a.icon] ?? QI.check}</span><p>${esc(a.desc)}</p>${a.at ? `<p><b>Unlocked ${esc(jdate(a.at))}</b>${a.project ? ` · ${esc(a.project)}` : ""}</p><p class="hint">${esc(a.evidence ?? "")}</p>${qEvLink(a.link, "evidence")}` : `<p class="hint">Locked. Only evidence unlocks it.</p>`}</div>` });
  }
  if (ds.qlogall != null) { S.qb.logAll = !S.qb.logAll; return renderQuests(true); }
  if (ds.qdefok) { qmark("def", [ds.qdefok]); return renderQuests(true); }
});
$("dbody").addEventListener("change", (e) => {
  const ta = e.target.closest?.("[data-qlessons]");
  if (ta && S.mode === "quests") qCall("/api/game/week", { lessons: ta.value }, "Lessons saved");
});

/**
 * An idea (from the gallery's Play button, or anywhere) becomes a game run: a project entry with a milestone ladder
 * seeded from the idea, a candidate main quest (you decide), and the New session dialog prefilled with the first quest.
 * Nothing starts and no folder is made until you confirm that dialog.
 */
async function startRun(idea) {
  if (idea == null || (typeof idea === "object" && !idea.name && !idea.title && !idea.label) || (typeof idea === "string" && !idea.trim())) { toast("That idea has no name to start a run with", true); return null; }
  let r;
  try { r = await api("/api/game/run", { idea }, 30_000); } catch (e) { toast(e.message, true); return null; }
  if (!r.isMain) {
    const yes = await askDialog({ title: `Make “${r.run.name}” your main quest?`, text: `${r.main ? `Your main quest is ${r.main}. ` : ""}The main quest's proofs count double and today's quests are written for it.${r.main ? " You can keep it as a candidate and switch later." : ""}`, ok: "Make it the main quest" });
    if (yes) await qPickMain(r.project);
  }
  openNew({ machine: S.self, cwd: r.cwd, project: r.project, prompt: r.prompt, label: r.label, title: `Start the run: ${r.run.name}`, mkdir: !!r.mkdir });
  if (S.mode === "quests") loadQuests({ force: true });
  return r;
}
window.startRun = startRun;
// ──────────────────────────────────────────────────────────────────────────── </quests>
