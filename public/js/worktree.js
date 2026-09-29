"use strict";
// A session's worktree, getting the work back: Merge into its base (fast-forward only), Open a pull request, Keep,
// Remove. Each opens a dialog that shows the diff against the base first and says exactly what will happen; you
// confirm there. In the session's ⋯ menu and ⌘K, and on Report back's done card. Also the weekly "worktrees that
// look finished" in the digest, with Clean up. Server: src/wt-ops.ts, src/wt-pr.ts, src/wt-stale.ts.
const wtBaseOf = (r) => r.wtBase || "its base";
/** A session on another machine: its closed-session ids need that machine's prefix to be reopened from here. */
const wtPre = (r) => (r.key.includes("|") ? r.key.slice(0, r.key.indexOf("|") + 1) : "");
const wtPlural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const wtHas = (r) => !!r?.worktree && !r.hist;

const WT_TITLES = { merge: (r) => `Merge ${r.branch ?? "this branch"} into ${wtBaseOf(r)}`, pr: () => "Open a pull request", keep: () => "Keep this worktree", remove: () => "Remove this worktree" };

async function wtOpen(r, op) {
  if (!wtHas(r)) return;
  const d = document.createElement("dialog");
  d.className = "ask wtdlg";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(WT_TITLES[op](r))}</h3><p class="hint wt-where">${ICON.tree}<span class="mono">${esc(r.branch ?? r.worktree)}</span> in ${esc(home(r.projectRoot ?? r.cwd))}</p>
    <div class="wt-notes"><p class="hint">Reading the worktree…</p></div><div class="wt-diff"></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" data-wtok disabled>…</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", () => motion.drop(d));
  d.querySelector(".wt-diff").addEventListener("click", (e) => wtDiffClick(e, r));
  d.showModal();
  const notes = d.querySelector(".wt-notes"), ok = d.querySelector("[data-wtok]");
  let data, pr;
  try {
    [data, pr] = await Promise.all([api("/api/worktree", { op: "diff", key: r.key }), op === "pr" ? api("/api/worktree", { op: "pr-plan", key: r.key }) : null]);
  } catch (x) { notes.innerHTML = `<p class="wt-err">${esc(x.message)}</p>`; ok.textContent = "OK"; return; }
  const s = data.status;
  // Titles said "its base" until the server told us which branch that is.
  d.querySelector("h3").textContent = op === "merge" ? `Merge ${s.branch} into ${s.base}` : WT_TITLES[op](r);
  d.querySelector(".wt-diff").innerHTML = wtDiffHTML(data);
  const plan = WT_PLANS[op](r, s, data, pr);
  notes.innerHTML = plan.notes.filter(Boolean).join("");
  notes.onclick = (e) => { if (e.target.closest("[data-wtcommit]")) { d.close(); wtSend(r, "Commit your work on this branch with a clear message. Don't push."); } };
  ok.textContent = plan.ok;
  ok.classList.toggle("danger", !!plan.danger); ok.classList.toggle("primary", !plan.danger);
  ok.disabled = !plan.run;
  ok.onclick = async () => {
    ok.disabled = true;
    try { await plan.run(d); d.close(); }
    catch (x) { ok.disabled = false; notes.insertAdjacentHTML("afterbegin", `<p class="wt-err" role="alert">${esc(x.message)}</p>`); }
  };
  if (plan.run) ok.focus();
}

const wtNote = (cls, html) => `<p class="${cls}">${cls === "wt-warn" ? ICON.warn : ""}${html}</p>`;
const wtDirtyNote = (s) => s.dirty.length ? wtNote("wt-warn", `${wtPlural(s.dirty.length, "uncommitted file")} in the worktree ${s.dirty.length === 1 ? "isn’t" : "aren’t"} part of this. <button type="button" class="btn sm" data-wtcommit>Ask it to commit first</button>`) : "";

const WT_PLANS = {
  merge(r, s, data) {
    if (s.merged) return { notes: [wtNote("wt-ok", `Everything on ${esc(s.branch)} is already in ${esc(s.base)}. Nothing to merge.`)], ok: "Merge" };
    if (s.baseDirty.length) return { notes: [wtNote("wt-err", `${esc(s.base)} has ${wtPlural(s.baseDirty.length, "uncommitted file")} in ${esc(home(s.baseCheckout))}, and the deck never merges into a checkout with uncommitted changes. Commit or stash them there, then try again.`)], ok: "Merge" };
    if (!s.ff) return {
      notes: [wtNote("wt-warn", `${esc(s.base)} has ${wtPlural(s.behind, "commit")} this branch doesn’t, so it can’t just fast-forward${s.conflicts?.length ? `, and merging would conflict in ${s.conflicts.slice(0, 6).map((f) => `<span class="mono">${esc(f)}</span>`).join(", ")}` : ""}. The deck only fast-forwards; the agent can rebase and resolve. It gets exactly this message:`), `<blockquote class="wt-msg">${esc(data.handoff)}</blockquote>`, `<p class="hint">When it says it’s ready, choose Merge again.</p>`],
      ok: "Send to the agent", run: () => wtSend(r, data.handoff),
    };
    return {
      notes: [wtNote("wt-plan", `Fast-forwards ${esc(s.base)}${s.baseCheckout ? ` (checked out in ${esc(home(s.baseCheckout))})` : ""} by ${wtPlural(s.ahead, "commit")}: <span class="mono">git merge --ff-only ${esc(s.branch)}</span>. No merge commit, nothing pushed.`), wtDirtyNote(s)],
      ok: `Merge into ${s.base}`,
      run: async () => {
        const res = await api("/api/worktree", { op: "merge", key: r.key });
        if (res.handoff) throw new Error(`${s.base} moved on while this was open. Open Merge again to see what to send the agent.`);
        toast(`Merged ${wtPlural(res.commits, "commit")} into ${res.base}`, false, { label: "Undo", run: () => api("/api/worktree", { op: "unmerge", key: r.key, undo: res }).then(() => toast(`${res.base} is back where it was`), (x) => toast(x.message, true)) });
      },
    };
  },
  pr(r, s, data, pr) {
    const cmds = `<pre class="wt-cmds">${pr.commands.map((c) => "$ " + esc(c)).join("\n")}</pre>`;
    if (!pr.ok) return { notes: [wtNote("wt-err", esc(pr.why)), cmds], ok: "Push and open PR" };
    if (s.merged) return { notes: [wtNote("wt-ok", `Everything on ${esc(s.branch)} is already in ${esc(s.base)}. There’s nothing for a pull request.`)], ok: "Push and open PR" };
    return {
      notes: [wtNote("wt-plan", `Pushes ${esc(s.branch)} to ${esc(pr.host)} and opens a pull request into ${esc(s.base)}, titled from its commits. In the worktree, it runs:`), cmds, wtDirtyNote(s)],
      ok: "Push and open PR",
      run: async () => {
        const res = await api("/api/worktree", { op: "pr", key: r.key });
        toast("Opened a pull request", false, res.url ? { label: "Open", run: () => window.open(res.url, "_blank", "noopener") } : undefined);
      },
    };
  },
  keep(r, s) {
    return {
      notes: [wtNote("wt-plan", `Nothing changes: the folder and ${esc(s.branch)} stay as they are. The weekly digest won’t list it as finished for two weeks.`)],
      ok: "Keep it", run: async () => { await api("/api/worktree", { op: "keep", key: r.key }); toast("Kept the worktree"); },
    };
  },
  remove(r, s) {
    const unmerged = !s.merged && s.unpushed > 0;
    const busy = r.status === "working" || r.status === "blocked";
    const notes = [
      s.dirty.length ? wtNote("wt-warn", `These ${wtPlural(s.dirty.length, "uncommitted change")} would go with the folder. The deck saves them in git stash first (“herdr deck: ${esc(s.branch)}…”), so Undo brings them back:`) + `<pre class="wt-cmds">${s.dirty.slice(0, 14).map(esc).join("\n")}${s.dirty.length > 14 ? `\n… and ${s.dirty.length - 14} more` : ""}</pre>` : "",
      unmerged ? wtNote("wt-warn", `${wtPlural(s.ahead, "commit")} on ${esc(s.branch)} ${s.ahead === 1 ? "isn’t" : "aren’t"} in ${esc(s.base)}${s.upstream ? ` or pushed to ${esc(s.upstream)}` : " and the branch was never pushed"}. ${s.ahead === 1 ? "It stays" : "They stay"} on the branch, which is kept.`) : "",
      wtNote("wt-plan", `Removes the folder (<span class="mono">git worktree remove</span>) and keeps the branch ${esc(s.branch)}${s.links.length ? `; the .env links go with it (the files stay in the main checkout)` : ""}.${!s.dirty.length && !unmerged ? ` Nothing is lost: ${s.merged ? `everything is in ${esc(s.base)}` : `it’s all pushed to ${esc(s.upstream)}`}.` : ""}`),
      busy ? wtNote("wt-warn", "The session is working right now; removing its folder under it will break what it’s doing.") : "",
      r.app ? "" : `<label class="wtn-chk"><input type="checkbox" data-wtclose checked><span>Close this session too <span class="hint">its folder will be gone; Undo reopens it</span></span></label>`,
    ];
    return {
      notes, ok: "Remove worktree", danger: true,
      run: async (d) => {
        const close = !!d.querySelector("[data-wtclose]")?.checked;
        const res = await api("/api/worktree", { op: "remove", key: r.key, force: true, close });
        toast(`Removed the worktree; ${res.undo.branch} is kept`, false, { label: "Undo", run: () => wtRestore(r.machine, [res.undo], (res.graves ?? []).map((g) => wtPre(r) + g)) });
      },
    };
  },
};

async function wtSend(r, text) {
  try { await api("/api/send", { key: r.key, text }); toast("Sent to the agent"); }
  catch (x) { toast(x.message, true, { label: "Retry", run: () => wtSend(r, text) }); }
}
/** Undo for a removal: the worktrees again from their kept branches, then the sessions closed with them. */
async function wtRestore(machine, undos, graves = []) {
  try {
    const notes = [];
    for (const undo of undos) { const res = await api("/api/worktrees", { op: "restore", machine, undo }); if (res.note) notes.push(res.note); }
    for (const id of graves) await api("/api/reopen", { id }).catch(() => {});
    wtCleaned(undos.map((u) => u.path), false);
    toast(notes.length ? notes.join(" ") : undos.length === 1 ? `The worktree is back on ${undos[0].branch}` : `${undos.length} worktrees are back`, notes.length > 0);
  } catch (x) { toast(x.message, true); }
}

/** The session's ⋯ menu and ⌘K: the same four, for a session in a worktree. */
function wtMenuItems(r) {
  if (!wtHas(r)) return [];
  return [
    { html: `Merge into ${esc(wtBaseOf(r))}…<small>Fast-forward only, after the diff</small>`, run: () => wtOpen(r, "merge") },
    { html: "Open a pull request…", run: () => wtOpen(r, "pr") },
    { html: "Keep this worktree…", run: () => wtOpen(r, "keep") },
    { html: "Remove the worktree…<small>The branch is kept</small>", danger: true, run: () => wtOpen(r, "remove") },
  ];
}
function wtPaletteItems(r) {
  if (!wtHas(r)) return [];
  return [
    { t: `Worktree: merge into ${wtBaseOf(r)}…`, ctx: true, run: () => wtOpen(r, "merge") },
    { t: "Worktree: open a pull request…", ctx: true, run: () => wtOpen(r, "pr") },
    { t: "Worktree: keep it…", ctx: true, run: () => wtOpen(r, "keep") },
    { t: "Worktree: remove it…", ctx: true, run: () => wtOpen(r, "remove") },
  ];
}

// ── the digest's stale worktrees ─────────────────────────────────────────
/** Paths cleaned up from this page, so the digest card stops listing them (the digest itself is a snapshot). */
function wtCleaned(paths, add = true) {
  const s = new Set(load("wtCleaned", []));
  for (const p of paths) add ? s.add(p) : s.delete(p);
  store("wtCleaned", [...s].slice(-200));
}
function wtStaleNow(dg) { const gone = new Set(load("wtCleaned", [])); return (dg?.stale ?? []).filter((w) => !gone.has(w.path)); }
const wtWhy = (w) => (w.why === "merged" ? `merged into ${w.base}` : `untouched ${w.days} days`);
function wtStaleHTML(dg) {
  const list = wtStaleNow(dg);
  if (!list.length) return "";
  const clean = list.filter((w) => !w.dirty);
  return `<div class="dgs"><h5>Worktrees that look finished <span class="n">${list.length}</span>${clean.length ? `<button class="btn sm" data-auto="cleanWt">Clean up…</button>` : ""}</h5><div class="dgl wtst">${list.slice(0, isPhone() ? 4 : 8).map((w) => `<span class="wtsi" title="${esc(w.path)}">${ICON.tree}<b>${esc(w.repo)}</b> <span class="mono">${esc(w.branch)}</span> <span class="hint">${esc(wtWhy(w))}${w.dirty ? " · has uncommitted changes, left alone" : ""}${multiMachine() && w.machine ? " · " + esc(machineLabel(w.machine)) : ""}</span></span>`).join("")}</div></div>`;
}
async function wtCleanStale() {
  const list = wtStaleNow(S.auto?.digest).filter((w) => !w.dirty);
  if (!list.length) return;
  const ok = await askDialog({ title: `Clean up ${wtPlural(list.length, "worktree")}?`, text: `Removes each folder and keeps its branch, so Undo can add it back:\n\n${list.map((w) => `${w.repo}  ${w.branch}  (${wtWhy(w)})\n  ${home(w.path)}`).join("\n")}`, ok: "Clean up", danger: true, selectInput: false });
  if (!ok) return;
  const byMachine = new Map();
  for (const w of list) byMachine.set(w.machine ?? S.self, [...(byMachine.get(w.machine ?? S.self) ?? []), w.path]);
  const undo = [], failed = [];
  for (const [machine, paths] of byMachine) {
    try {
      const { results } = await api("/api/worktrees", { op: "clean", machine, paths });
      for (const x of results) x.ok ? undo.push([machine, x.undo]) : failed.push(`${x.path.split("/").pop()}: ${x.error}`);
    } catch (x) { failed.push(x.message); }
  }
  wtCleaned(undo.map(([, u]) => u.path));
  render();
  const again = () => { for (const m of new Set(undo.map(([mm]) => mm))) wtRestore(m, undo.filter(([mm]) => mm === m).map(([, u]) => u)); };
  toast(`${undo.length ? `Removed ${wtPlural(undo.length, "worktree")}, branches kept` : "Nothing removed"}${failed.length ? `. Not removed: ${failed.join("; ")}` : ""}`, failed.length > 0, undo.length ? { label: "Undo", run: again } : undefined);
}
