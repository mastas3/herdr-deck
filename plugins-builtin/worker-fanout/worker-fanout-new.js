"use strict";
// Worker fan-out: a new run. One dialog for the brief and the workers (folder, agent, model each), then a confirm
// dialog listing every exact command and the full first message before anything starts.
const FO_KINDS = [["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"]];

function foRowHTML(w, i) {
  return `<div class="fonrow" data-fon="${i}"><span class="fonn">${i + 1}</span>
    <input name="cwd" list="foCwds" spellcheck="false" autocomplete="off" placeholder="Folder or worktree" value="${esc(w.cwd ?? "")}">
    <select name="kind">${FO_KINDS.map(([k, l]) => `<option value="${k}" ${w.kind === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <input name="model" spellcheck="false" autocomplete="off" placeholder="Model (default)" value="${esc(w.model ?? "")}">
    <button type="button" class="ib" data-fondel="${i}" title="Remove this worker" aria-label="Remove worker ${i + 1}">${ICON.x}</button></div>`;
}

function foOpenNew(pre = {}) {
  const cur = rowOf(S.sel);
  const root = cur?.projectRoot ?? cur?.cwd ?? "";
  const saved = load("foLast", {});
  let workers = pre.workers ?? [{ cwd: root ? home(root) : "", kind: saved.kind ?? "claude", model: saved.model ?? "" }];
  const folders = [...new Set([...S.rows.values()].map((r) => r.projectRoot ?? r.cwd).filter(Boolean))].slice(0, 30);
  const d = document.createElement("dialog");
  d.className = "ask wide fonew";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>New fan-out</h3>
    <p>Every worker gets the same brief, plus where to write its report and a done marker. You check every command before anything starts.</p>
    <label class="field"><span>Name <span class="hint">(optional)</span></span><input name="title" autocomplete="off" placeholder="e.g. Audit the API routes"></label>
    <label class="field"><span>Brief</span><textarea name="brief" rows="6" placeholder="What every worker should do, and what done looks like.">${esc(pre.brief ?? "")}</textarea></label>
    <div class="field"><span>Workers</span><div class="fonrows"></div>
      <p class="fonbtns"><button type="button" class="btn ghost" data-fonadd>${ICON.plus}Add worker</button><button type="button" class="btn ghost" data-fonwt>Use this repo’s worktrees</button></p></div>
    <datalist id="foCwds">${folders.map((f) => `<option value="${esc(home(f))}">`).join("")}</datalist></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Next: check the commands</button></div></form>`;
  document.body.append(d);
  const box = d.querySelector(".fonrows");
  const read = () => [...box.querySelectorAll(".fonrow")].map((el) => ({ cwd: el.querySelector("[name=cwd]").value.trim(), kind: el.querySelector("[name=kind]").value, model: el.querySelector("[name=model]").value.trim() }));
  const draw = () => { box.innerHTML = workers.map(foRowHTML).join(""); };
  draw();
  d.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-fonadd],[data-fondel],[data-fonwt]");
    if (!t) return;
    workers = read();
    if (t.dataset.fondel != null) workers.splice(Number(t.dataset.fondel), 1);
    else if (t.dataset.fonadd != null) workers.push({ ...(workers[workers.length - 1] ?? { kind: "claude" }) });
    else {
      const from = workers[0]?.cwd || root;
      try {
        const { worktrees } = await api("/api/worker-fanout", { op: "worktrees", cwd: from });
        if (!worktrees.length) { toast("No git worktrees there", true); return; }
        const base = workers[0] ?? { kind: "claude" };
        workers = worktrees.map((w) => ({ ...base, cwd: home(w) }));
      } catch (err) { toast(err.message, true); return; }
    }
    draw();
  });
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok";
    const body = { title: d.querySelector("[name=title]").value, brief: d.querySelector("[name=brief]").value, workers: read() };
    motion.drop(d);
    if (!ok) return;
    if (body.workers[0]) store("foLast", { kind: body.workers[0].kind, model: body.workers[0].model });
    await foConfirmStart(body);
  });
  d.showModal();
}

async function foConfirmStart(body) {
  let p;
  try { p = await api("/api/worker-fanout", { op: "plan", ...body }); }
  catch (e) { toast(e.message, true, { label: "Retry", run: () => foOpenNew({ brief: body.brief, workers: body.workers }) }); return; }
  const d = document.createElement("dialog");
  d.className = "ask wide foconfirm";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3 tabindex="-1">Start ${p.workers.length} worker${p.workers.length === 1 ? "" : "s"}?</h3>
    <p>“${esc(p.title)}”. Each starts in its own folder. Reports go to ${esc(home(p.workers[0].dir.replace(/\/w1$/, "")))}.</p>
    ${p.workers.map((w) => `<div class="foblock"><span class="hint">${w.n}. in ${esc(home(w.cwd))}</span><code class="focmd">${esc(w.cmd)}</code></div>`).join("")}
    <div class="foblock"><span class="hint">First message (worker 1; the others name their own folder)</span><pre class="forep">${esc(p.workers[0].prompt)}</pre></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Start ${p.workers.length}</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok";
    motion.drop(d);
    if (!ok) return;
    try {
      const run = await api("/api/worker-fanout", { op: "start", ...body, id: p.id, confirmed: true });
      const bad = run.workers.filter((w) => w.error);
      toast(bad.length ? `${bad.length} of ${run.workers.length} didn’t start: ${bad[0].error}` : `Started ${run.workers.length} worker${run.workers.length === 1 ? "" : "s"}`, !!bad.length);
      foS.sel = run.id; store("foSel", run.id); setMode("workers");
    } catch (e) { toast("Couldn’t start: " + e.message, true); }
  });
  d.showModal();
  d.querySelector("h3").focus(); // open at the top: the commands first, then the long message
}
