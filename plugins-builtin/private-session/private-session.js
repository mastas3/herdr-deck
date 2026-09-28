"use strict";
// Private session in the page: "New private session" (a throwaway folder, then the usual New session dialog), the
// question when one closes ("delete what it left behind?", listing every file first), and a small Private view.
// Server: plugins-builtin/private-session/server.ts. Top-level names start with pv.
const pvS = { list: null, asked: new Set() };
ICON.lock = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="7" width="10" height="7" rx="1.6"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

async function pvNew() {
  try {
    const { cwd } = await api("/api/private-session", { op: "prepare" });
    await openNew({ cwd, project: "private", label: "private", title: "New private session" });
    // The dialog remembers the last folder per machine; a throwaway folder must not become the next default.
    const key = "newCwd:" + newMachine, was = load(key, "");
    $("newDlg").addEventListener("close", () => store(key, was), { once: true });
    toast("Private: this folder is kept out of History and search. When you close the session, you can delete its transcript.");
  } catch (e) { toast(e.message, true); }
}

const pvShort = (f) => home(f);
/** The exact files, then one confirm. Deletes nothing it didn't show. */
async function pvDelete(cwd) {
  let plan;
  try { plan = await api("/api/private-session", { op: "files", cwd }); } catch (e) { toast(e.message, true); return; }
  if (!plan.files.length && !plan.lines.length) { toast("Nothing left on disk for that session"); return; }
  const d = document.createElement("dialog");
  d.className = "ask wide pvdlg";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3 tabindex="-1">Delete what this private session left?</h3>
    <p>These ${plan.files.length} file${plan.files.length === 1 ? "" : "s"} and folders go for good. Nothing else is touched.</p>
    <ul class="pvfiles">${plan.files.map((f) => `<li class="mono">${esc(pvShort(f))}</li>`).join("")}</ul>
    ${plan.lines.length ? `<label class="pvline"><input type="checkbox" name="lines" checked><span>Also remove its ${plan.lines.map((l) => `${l.n} line${l.n === 1 ? "" : "s"} from <span class="mono">${esc(pvShort(l.file))}</span>`).join(" and ")} (your typed-prompt history)</span></label>` : ""}</div>
    <div class="dlg-f"><button class="btn" value="cancel">Keep them</button><button class="btn danger" value="ok">Delete ${plan.files.length}</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok", lines = !!d.querySelector("[name=lines]")?.checked;
    motion.drop(d);
    if (!ok) return;
    try {
      const r = await api("/api/private-session", { op: "delete", cwd, files: plan.files, lines, confirmed: true });
      toast(`Deleted ${r.deleted.length} file${r.deleted.length === 1 ? "" : "s"}${r.lines ? ` and ${r.lines} history line${r.lines === 1 ? "" : "s"}` : ""}${r.skipped.length ? ` · ${r.skipped.length} couldn’t be deleted` : ""}`, !!r.skipped.length);
    } catch (e) { toast(e.message, true, { label: "Retry", run: () => pvDelete(cwd) }); }
    pvLoad();
  });
  d.showModal();
  d.querySelector("h3").focus(); // Keep them is the safe default; nothing is picked for you
}

async function pvLoad() {
  try { pvS.list = (await api("/api/private-session", { op: "list" })).sessions; } catch (e) { toast(e.message, true); }
  if (S.mode === "private") pvRender();
}
function pvRender() {
  const head = `<header class="vh"><h2>${ICON.lock}Private sessions</h2><p>For paperwork, codes and anything personal. They run in a throwaway folder, stay out of History and search, and when one closes you can delete its transcript.</p>
    <p><button class="btn primary" data-pvnew>${ICON.plus}New private session</button></p></header>`;
  if (!pvS.list) { modeHTML(head + `<p class="hint">Loading…</p>`); return; }
  const item = (e) => {
    const state = e.deletedAt ? `Deleted ${agoText(e.deletedAt)}` : e.live ? "Running" : e.closedAt ? `Closed ${agoText(e.closedAt)}, files still on disk` : "Starting";
    const act = e.live ? (rowOf(e.key) ? `<button class="btn ghost" data-pvopen="${esc(e.key)}">Open</button>` : "") : e.deletedAt ? `<button class="btn ghost" data-pvforget="${esc(e.cwd)}">Forget</button>` : `<button class="btn danger" data-pvdel="${esc(e.cwd)}">Delete its files…</button>`;
    return `<li class="pvrow ${e.deletedAt ? "gone" : ""}"><div><b>${esc(e.deletedAt ? "Private session" : e.title || "Private session")}</b><span class="hint">${esc(e.agent ?? "")} · ${esc(state)}</span></div>${act}</li>`;
  };
  modeHTML(head + (pvS.list.length ? `<ul class="pvlist">${pvS.list.map(item).join("")}</ul>` : `<p class="hint">None yet.</p>`));
}
$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "private") return;
  const t = e.target.closest("[data-pvnew],[data-pvdel],[data-pvopen],[data-pvforget]");
  if (!t) return;
  if (t.dataset.pvnew != null) pvNew();
  else if (t.dataset.pvdel) pvDelete(t.dataset.pvdel);
  else if (t.dataset.pvopen) select(t.dataset.pvopen, { scroll: true, open: true });
  else if (t.dataset.pvforget) api("/api/private-session", { op: "forget", cwd: t.dataset.pvforget }).then(pvLoad, (err) => toast(err.message, true));
});

deckPlugins.register("private-session", {
  views: { private: { load: pvLoad, render: pvRender } },
  palette: () => [
    { t: "New private session: throwaway folder, kept out of History, transcript deleted after", slot: "views", order: 26, run: pvNew },
    { t: "Private sessions: delete what closed ones left", slot: "views", order: 27, run: () => setMode("private") },
  ],
  // A private session closed while this page is open: ask once, right away.
  events: { "private-session": (d) => { if (d?.closed && !pvS.asked.has(d.closed)) { pvS.asked.add(d.closed); pvDelete(d.closed); } if (S.mode === "private") pvLoad(); } },
});
