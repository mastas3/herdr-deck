"use strict";
// Dual review: starting one. A dialog picks the change (a session's folder or any folder, and a git range) and shows
// what the diff touches; then a confirm dialog shows both exact commands and the prompt before anything starts.

/** A confirm dialog with labelled blocks (commands, a prompt, a message). Resolves true only on the OK button. */
function drConfirm({ title, note = "", blocks = [], ok = "Start", danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ask wide drconfirm";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3 tabindex="-1">${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ""}
      ${blocks.map((b) => `<div class="drblock"><span class="hint">${esc(b.label)}</span>${b.mono ? `<code class="drcmd">${esc(b.mono)}</code>` : ""}${b.text ? `<pre class="drpre">${esc(b.text)}</pre>` : ""}</div>`).join("")}</div>
      <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => { resolve(d.returnValue === "ok"); motion.drop(d); });
    d.showModal();
    (isPhone() ? d.querySelector("h3") : d.querySelector("button[value=ok]"))?.focus(); // on a phone the dialog opens at its top
  });
}

/** Sessions worth reviewing: live ones with a folder, newest first (the open one on top). */
function drSources(cur) {
  // Reviewers start on this machine, so only this machine's sessions (another machine's folders aren't here).
  const here = (r) => { const m = S.summary.machines?.find((x) => x.id === r.machine); return !m || m.local; };
  const rows = [...S.rows.values()].filter((r) => r.cwd && r.agent !== "shell" && here(r));
  rows.sort((a, b) => (b.key === cur?.key) - (a.key === cur?.key) || act(b) - act(a));
  return rows.slice(0, 40);
}

let drDiffT = 0;
function drOpenStart(cur) {
  const rows = drSources(cur);
  const d = document.createElement("dialog");
  d.className = "ask wide drstart";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>New dual review</h3>
    <p>Claude and Codex each review the same change in a session of their own and write their findings to a file. You see both lists side by side.</p>
    <label class="field"><span>The change</span><select name="src">${rows.map((r) => `<option value="${esc(r.key)}">${esc(r.project || r.title)}: ${esc(r.title || r.agent)}${r.branch ? ` (${esc(r.branch)})` : ""}</option>`).join("")}<option value="">Another folder…</option></select></label>
    <label class="field" data-drfolder ${rows.length ? "hidden" : ""}><span>Folder</span><input name="cwd" spellcheck="false" autocomplete="off" placeholder="~/Documents/Projects/…"></label>
    <label class="field"><span>Which changes <span class="hint">(blank: uncommitted · main: this branch since main · a..b)</span></span><input name="range" spellcheck="false" autocomplete="off" class="mono" placeholder="uncommitted changes"></label>
    <pre class="drpre drstat hint">…</pre>
    <label class="field"><span>Anything to look at closely <span class="hint">(optional)</span></span><textarea name="lookat" rows="2" placeholder="e.g. the payment retry logic"></textarea></label>
    <div class="fields2"><label class="field"><span>Claude model</span><input name="mclaude" spellcheck="false" placeholder="Default" value="${esc(load("drModel:claude", ""))}"></label>
      <label class="field"><span>Codex model</span><input name="mcodex" spellcheck="false" placeholder="Default" value="${esc(load("drModel:codex", ""))}"></label></div></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Next: check the commands</button></div></form>`;
  document.body.append(d);
  const f = d.querySelector("form");
  const cwdOf = () => { const r = rowOf(f.src.value); return r ? r.projectRoot ?? r.cwd : f.cwd.value.trim(); };
  const stat = async () => {
    const cwd = cwdOf(), el = d.querySelector(".drstat");
    if (!cwd) { el.textContent = "Pick a folder."; return; }
    el.textContent = "Reading the diff…";
    try {
      const s = await api("/api/dual-review", { op: "diffstat", cwd, range: f.range.value });
      el.textContent = s.error ? `git: ${s.error}` : s.files ? s.stat : "No changes in that range.";
      el.classList.toggle("bad", !!s.error || !s.files);
    } catch (e) { el.textContent = e.message; }
  };
  const later = () => { clearTimeout(drDiffT); drDiffT = setTimeout(stat, 350); };
  f.src.addEventListener("change", () => { d.querySelector("[data-drfolder]").hidden = !!f.src.value; later(); });
  f.cwd.addEventListener("input", later); f.range.addEventListener("input", later);
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok";
    const src = rowOf(f.src.value);
    const body = { cwd: cwdOf(), range: f.range.value.trim(), focus: f.lookat.value, models: { claude: f.mclaude.value.trim(), codex: f.mcodex.value.trim() }, origin: src ? { key: src.key, title: src.title || src.project } : undefined };
    motion.drop(d);
    if (!ok) return;
    store("drModel:claude", body.models.claude); store("drModel:codex", body.models.codex);
    await drConfirmStart(body);
  });
  d.showModal();
  stat();
}

async function drConfirmStart(body) {
  let p;
  try { p = await api("/api/dual-review", { op: "plan", ...body }); } catch (e) { toast(e.message, true); return; }
  const [a, b] = p.sessions;
  const ok = await drConfirm({
    title: "Start two review sessions?",
    note: `In ${home(p.cwd)}, on ${p.range || "the uncommitted changes"}. Each reviewer only reads the repo and writes its findings to ${home(p.dir)}. You can close them any time.`,
    blocks: [{ label: `${DR_SIDE[a.side]} runs`, mono: a.cmd }, { label: `${DR_SIDE[b.side]} runs`, mono: b.cmd }, { label: `The prompt (shown for ${DR_SIDE[a.side]}; ${DR_SIDE[b.side]}’s names its own file)`, text: a.prompt }],
    ok: "Start both",
  });
  if (!ok) return;
  try {
    const r = await api("/api/dual-review", { op: "start", ...body, id: p.id, confirmed: true });
    const bad = Object.entries(r.sides).filter(([, s]) => s.error);
    toast(bad.length ? `${bad.map(([k, s]) => `${DR_SIDE[k]}: ${s.error}`).join(" · ")}` : "Started both reviewers", !!bad.length);
    drS.sel = r.id; setMode("review");
  } catch (e) { toast("Couldn’t start: " + e.message, true); }
}
