"use strict";
// "Own worktree" in the New session dialog. When the folder is in a git repo (the machine it's on checks), the deck
// can make a worktree for the session and start the agent in it, so sessions in one repo don't share a checkout.
// On by default only when another live session already works in that repo; the branch comes from the first message.
// Every step it will run is listed before you start (server: src/wt-create.ts, src/http/worktrees.ts).
const wtNew = { plan: null, on: false, touched: false, branchEdited: false, baseEdited: false, repo: "", seq: 0, timer: 0, env: true, install: true };

/** Ask the folder's machine about it again (debounced): the repo, the suggested branch, what's in the way. */
function wtNewPlan(delay = 250) {
  clearTimeout(wtNew.timer);
  wtNew.timer = setTimeout(wtNewFetch, delay);
}
async function wtNewFetch() {
  const box = $("nWorktree"), cwd = $("nCwd").value.trim(), seq = ++wtNew.seq;
  if (!box || !cwd || newCodexApp()) { wtNew.plan = null; return wtNewRender(); }
  const typed = (k) => (wtNew[k + "Edited"] ? box.querySelector(`[data-wt=${k}]`)?.value : undefined);
  try {
    const p = await api("/api/worktrees", { op: "plan", machine: newMachine, cwd, prompt: $("nPrompt").value, branch: typed("branch"), base: typed("base") });
    if (seq !== wtNew.seq) return;
    // Another repo starts over: its own default, its own suggestion (and what you typed for the last one is dropped).
    if ((p.main ?? "") !== wtNew.repo) {
      const retry = wtNew.branchEdited || wtNew.baseEdited;
      Object.assign(wtNew, { repo: p.main ?? "", touched: false, branchEdited: false, baseEdited: false, env: true, install: true });
      if (retry) return wtNewFetch();
    }
    if (!wtNew.touched) wtNew.on = !!p.defaultOn;
    wtNew.plan = p;
  } catch { if (seq === wtNew.seq) wtNew.plan = null; }
  wtNewRender();
}
/** A fresh dialog: nothing known yet, nothing you chose. */
function wtNewReset() {
  clearTimeout(wtNew.timer); wtNew.seq++;
  Object.assign(wtNew, { plan: null, on: false, touched: false, branchEdited: false, baseEdited: false, repo: "", env: true, install: true });
  wtNewRender();
}

const wtQ = (s) => (/^[\w./@:+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
/** The steps the server will take, in its order, as you'd type them. */
function wtNewSteps(p) {
  const rel = p.path.slice(p.main.length + 1);
  const steps = [`git worktree add -b ${wtQ(p.branch)} ${wtQ(rel)} ${wtQ(p.base)}`];
  if (p.exclude === "exclude") steps.push(`add /.claude/worktrees/ to .git/info/exclude <span class="hint">(not a tracked file)</span>`);
  if (wtNew.env && p.env.length) steps.push(`symlink ${p.env.map(esc).join(", ")} to the main checkout’s <span class="hint">(links, not copies)</span>`);
  if (wtNew.install && p.install) steps.push(`${esc(p.install.cmd)} <span class="hint">in the new tab, before the agent</span>`);
  const kind = (KINDS.find(([k]) => k === newKind) ?? [newKind, newKind])[1];
  const at = esc(rel + (p.sub ? "/" + p.sub : ""));
  steps.push(newKind === "shell" ? `open a shell in ${at}` : `start ${esc(kind)} in ${at}`);
  return steps.map((s, i) => `<li>${i ? s : esc(s)}</li>`).join("");
}

function wtNewRender() {
  const box = $("nWorktree");
  if (!box) return;
  const p = wtNew.plan;
  box.hidden = !p?.repo || newCodexApp();
  if (box.hidden) { box.innerHTML = ""; return; }
  const focused = document.activeElement?.dataset?.wt;
  const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const others = p.others?.length ? `Another session works in this repo: ${p.others.slice(0, 2).map((o) => `“${esc(shortTitle(o.title))}”`).join(", ")}${p.others.length > 2 ? ` and ${p.others.length - 2} more` : ""}.` : "No other session works in this repo right now.";
  const prob = wtNew.on ? p.problems.branch || p.problems.path || p.problems.base : "";
  box.innerHTML = `<div class="wtn-top"><label class="sw"><input type="checkbox" data-wt="on" ${wtNew.on ? "checked" : ""} aria-label="Own worktree"><span></span></label>
      <div><b>Own worktree</b><p class="hint">${wtNew.on ? "A separate checkout on its own branch, so this session’s edits and commits don’t mix with others in the repo." : others}</p></div></div>
    ${wtNew.on ? `<div class="wtn-body">
      <div class="fields2"><label class="field"><span>Branch</span><input data-wt="branch" class="mono" spellcheck="false" autocomplete="off" value="${esc(p.branch)}"></label>
        <label class="field"><span>From</span><input data-wt="base" class="mono" list="wtBases" spellcheck="false" autocomplete="off" value="${esc(p.base)}"><datalist id="wtBases">${p.branches.map((b) => `<option value="${esc(b)}">`).join("")}</datalist></label></div>
      ${prob ? `<p class="wtn-err" role="alert">${esc(prob)}</p>` : ""}
      ${p.env.length ? `<label class="wtn-chk"><input type="checkbox" data-wt="env" ${wtNew.env ? "checked" : ""}><span>Link the .env files <span class="hint">${p.env.map(esc).join(", ")}: git doesn’t track them, so a new worktree wouldn’t have them</span></span></label>` : ""}
      ${p.install ? `<label class="wtn-chk"><input type="checkbox" data-wt="install" ${wtNew.install ? "checked" : ""}><span>Run <code>${esc(p.install.cmd)}</code> first <span class="hint">node_modules isn’t in a new worktree. It runs in the session’s terminal, where you can watch it, and the agent starts once it’s done</span></span></label>` : ""}
      ${p.baseDirty ? `<p class="wtn-warn">${ICON.warn}${esc(p.base)} has ${p.baseDirty.files} uncommitted file${p.baseDirty.files === 1 ? "" : "s"} in ${esc(home(p.baseDirty.checkout))}. They stay there: the worktree starts from ${esc(p.base)}’s last commit.</p>` : ""}
      ${p.ports?.length ? `<p class="wtn-warn">${ICON.warn}The main checkout is serving ${p.ports.map((x) => `:${x.port} (${esc(x.cmd)})`).join(", ")}. A dev server the agent starts in the worktree needs a different port.</p>` : ""}
      <div class="wtn-steps"><span class="hint">Before the agent starts, the deck will:</span><ol>${wtNewSteps(p)}</ol></div></div>` : ""}`;
  // Start stays blocked (the browser says why) while the name or the base is refused.
  box.querySelector("[data-wt=branch]")?.setCustomValidity(p.problems.branch || p.problems.path || "");
  box.querySelector("[data-wt=base]")?.setCustomValidity(p.problems.base || "");
  if (focused) { const el = box.querySelector(`[data-wt=${focused}]`); el?.focus(); if (caret && el?.setSelectionRange) el.setSelectionRange(...caret); }
}

/** What /api/new gets: the branch, its base and the extras you kept ticked. */
function wtNewApply(body) {
  const p = wtNew.plan;
  if (!wtNew.on || !p?.repo || newCodexApp()) return;
  // What's in the fields now (the plan may be a keystroke behind); the server checks it again.
  const val = (k) => $("nWorktree").querySelector(`[data-wt=${k}]`)?.value.trim();
  body.worktree = { branch: val("branch") || p.branch, base: val("base") || p.base, env: wtNew.env ? p.env : [], install: wtNew.install && !!p.install };
}

$("nWorktree")?.addEventListener("input", (e) => {
  const k = e.target.dataset.wt;
  if (k === "branch") { wtNew.branchEdited = true; wtNewPlan(); }
  else if (k === "base") { wtNew.baseEdited = true; wtNewPlan(); }
});
$("nWorktree")?.addEventListener("change", (e) => {
  const k = e.target.dataset.wt;
  if (k === "on") { wtNew.on = e.target.checked; wtNew.touched = true; wtNewRender(); }
  else if (k === "env" || k === "install") { wtNew[k] = e.target.checked; wtNewRender(); }
});
$("nCwd")?.addEventListener("input", () => wtNewPlan(400));
$("nCwd")?.addEventListener("change", () => wtNewPlan(0));
$("nCwdSugg")?.addEventListener("click", (e) => { if (e.target.closest("[data-cwd]")) wtNewPlan(0); });
$("nPrompt")?.addEventListener("input", () => { if (!wtNew.branchEdited && wtNew.on) wtNewPlan(500); else if (!wtNew.branchEdited) wtNewPlan(900); });
