"use strict";
// The New session dialog.
// ── new session ──────────────────────────────────────────────────────────
const KINDS = [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["shell", "Shell"]];
let newOpts = null, newKind = load("newKind", "claude"), newMachine = null, pendingSelect = null, newMkdir = null;
let nSel = { model: "", effort: "", mode: "" };
async function loadNewOptions() {
  try { newOpts = await api("/api/new-options", { machine: newMachine }); } catch (e) { newOpts = { recent: [], projects: [], argHints: {}, choices: {} }; toast(e.message, true); }
  const cur = rowOf(S.sel);
  const saved = load("newCwd:" + newMachine, "");
  $("nCwd").value = saved || (cur && cur.machine === newMachine ? home(cur.projectRoot ?? cur.cwd) : "") || home(newOpts.recent[0] ?? "");
  $("nCwdList").innerHTML = [...new Set([...newOpts.recent, ...newOpts.projects])].map((p) => `<option value="${esc(home(p))}">`).join("");
  const projRoots = [...new Set([...S.rows.values()].filter((r) => r.machine === newMachine && r.projectRoot).sort((a, b) => act(b) - act(a)).map((r) => r.projectRoot))];
  const recent = [...new Set([...projRoots, ...newOpts.recent])].slice(0, 7);
  $("nCwdSugg").innerHTML = recent.length ? `<span class="hint">Recent:</span>` + recent.map((p) => `<button type="button" data-cwd="${esc(home(p))}" title="${esc(p)}">${esc(p.split("/").pop())}</button>`).join("") : "";
  renderKinds();
}
/** Where a project lives: the folder and machine of its most recent session. */
function projectHome(p) {
  const r = [...S.rows.values()].filter((r) => r.project === p && r.projectRoot && inScope(r)).sort((a, b) => act(b) - act(a))[0];
  return r ? { machine: r.machine, cwd: r.projectRoot, project: p } : undefined;
}
/** `pre` ({ machine, cwd, project }) opens it already pointed at a project folder. */
/** Discover actions start in a folder of their own under Projects, named after the idea; it's made only when you confirm the dialog. */
function ownFolder(r, name) {
  if (r.folder) return { cwd: r.folder, mkdir: true };
  if (!/(^|\/)Projects\/?$/.test(String(r.cwd ?? ""))) return { cwd: r.cwd };
  const slug = String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "") || `idea-${Date.now().toString(36)}`;
  return { cwd: `${String(r.cwd).replace(/\/+$/, "")}/${slug}`, mkdir: true };
}
async function openNew(pre) {
  pre = pre && pre.cwd ? pre : undefined;
  newMkdir = pre?.mkdir ? pre.cwd : null; // quests: a new run's folder is made only when you confirm
  const cur = rowOf(S.sel);
  newMachine = pre?.machine ?? (S.machine !== "all" ? S.machine : cur?.machine) ?? S.self;
  const ms = realMachines();
  if (!ms.some((m) => m.id === newMachine)) newMachine = S.self;
  $("nMachineWrap").hidden = ms.length <= 1;
  $("nMachine").innerHTML = ms.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="${m.id === newMachine}" ${m.online ? "" : "disabled"}>${esc(m.label)}</button>`).join("");
  $("nPrompt").value = pre?.prompt ?? ""; $("nLabel").value = pre?.label ?? "";
  newKind = pre?.kind ?? load("newKind", newKind); // Discover prefills Claude Code for that one session; your saved choice is untouched
  $("nFocus").checked = load("newFocus", false);
  $("newDlg").querySelector("h3").textContent = pre?.title ?? (pre ? `New session in ${pre.project}` : "New session");
  if (pre) $("nCwd").value = home(pre.cwd);
  $("newDlg").showModal();
  renderKinds();
  await loadNewOptions();
  if (pre) { $("nCwd").value = home(pre.cwd); renderCmd(); }
  if (!isPhone()) (newKind === "shell" ? $("nCwd") : $("nPrompt")).focus();
}
function renderKinds() {
  $("nKind").innerHTML = KINDS.map(([k, label]) => `<button type="button" data-kind="${k}" aria-pressed="${newKind === k}">${label}</button>`).join("");
  const shell = newKind === "shell";
  $("nPromptWrap").hidden = shell; $("nArgsWrap").hidden = shell; $("nAgentOpts").hidden = shell;
  nSel = { model: "", effort: "", mode: "", ...load("opts:" + newKind, {}) };
  $("nArgs").value = load("args:" + newKind, "");
  const hints = newOpts?.argHints?.[newKind] ?? [];
  $("nArgsSugg").innerHTML = hints.length ? `<span class="hint">Your other ${esc(newKind)} sessions use:</span>` + hints.map((h) => `<button type="button" data-args="${esc(h)}">${esc(h)}</button>`).join("") : "";
  renderAgentOpts();
}
function renderAgentOpts() {
  const ch = newOpts?.choices?.[newKind];
  if (!ch) { $("nAgentOpts").hidden = true; renderCmd(); return; }
  $("nAgentOpts").hidden = newKind === "shell";
  $("nModel").value = nSel.model;
  $("nModelList").innerHTML = ch.models.filter((m) => m.v).map((m) => `<option value="${esc(m.v)}">${esc(m.l ?? "")}</option>`).join("");
  const quick = ch.models.slice(0, newKind === "opencode" ? 1 : 7);
  $("nModelSugg").innerHTML = quick.map((m) => `<button type="button" data-model="${esc(m.v)}" style="${nSel.model === m.v ? "border-style:solid;color:var(--ink)" : ""}">${esc(m.l ?? m.v)}</button>`).join("") + (newKind === "opencode" && ch.models.length > 1 ? `<span class="hint">${ch.models.length - 1} models: type to search</span>` : "");
  const model = ch.models.find((m) => m.v === nSel.model);
  const efforts = model?.efforts?.length ? model.efforts : ch.efforts;
  $("nEffortWrap").hidden = !efforts.length;
  $("nEffort").innerHTML = [["", ch.defaultEffort ? `Default (${ch.defaultEffort})` : "Default"], ...efforts.map((e) => [e, e])].map(([v, l]) => `<button type="button" data-effort="${esc(v)}" aria-pressed="${nSel.effort === v}">${esc(l)}</button>`).join("");
  $("nModeLabel").textContent = newKind === "claude" ? "Permissions" : newKind === "codex" ? "Sandbox" : "Agent";
  $("nMode").innerHTML = ch.modes.map((m) => `<button type="button" data-mode="${esc(m.v)}" aria-pressed="${nSel.mode === m.v}">${esc(m.l ?? m.v)}</button>`).join("");
  renderCmd();
}
/** Mirrors the server's agentArgs so you see exactly what will run. */
function renderCmd() {
  if (newKind === "shell") { $("nCmd").textContent = `a shell in ${$("nCwd").value || "…"}`; return; }
  const a = [newKind];
  const { model, effort, mode } = nSel;
  if (newKind === "claude") { if (model) a.push("--model", model); if (effort) a.push("--effort", effort); if (mode === "bypassPermissions") a.push("--dangerously-skip-permissions"); else if (mode) a.push("--permission-mode", mode); }
  if (newKind === "codex") { if (model) a.push("-m", model); if (effort) a.push("-c", `model_reasoning_effort="${effort}"`); if (mode === "yolo") a.push("--dangerously-bypass-approvals-and-sandbox"); else if (mode) a.push("-s", mode); }
  if (newKind === "opencode") { if (model) a.push("-m", model); if (mode) a.push("--agent", mode); }
  const extra = $("nArgs").value.trim();
  $("nCmd").textContent = "$ " + a.join(" ") + (extra ? " " + extra : "");
}
function saveOpts() { store("opts:" + newKind, nSel); renderAgentOpts(); }
$("nMachine").addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b || b.disabled) return; newMachine = b.dataset.m; for (const x of $("nMachine").children) x.setAttribute("aria-pressed", x.dataset.m === newMachine); loadNewOptions(); });
$("nKind").addEventListener("click", (e) => { const b = e.target.closest("[data-kind]"); if (b) { newKind = b.dataset.kind; store("newKind", newKind); renderKinds(); } });
$("nModelSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-model]"); if (b) { nSel.model = b.dataset.model; saveOpts(); } });
$("nModel").addEventListener("change", (e) => { nSel.model = e.target.value.trim(); saveOpts(); });
$("nModel").addEventListener("input", (e) => { nSel.model = e.target.value.trim(); store("opts:" + newKind, nSel); renderCmd(); });
$("nEffort").addEventListener("click", (e) => { const b = e.target.closest("[data-effort]"); if (b) { nSel.effort = b.dataset.effort; saveOpts(); } });
$("nMode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) { nSel.mode = b.dataset.mode; saveOpts(); } });
$("nArgs").addEventListener("input", renderCmd);
$("nCwd").addEventListener("input", renderCmd);
$("nArgsSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-args]"); if (b) { $("nArgs").value = b.dataset.args; renderCmd(); } });
$("nCwdSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-cwd]"); if (b) { $("nCwd").value = b.dataset.cwd; renderCmd(); } });
$("nPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("nOk").click(); } });
$("newDlg").addEventListener("close", async () => {
  if ($("newDlg").returnValue !== "ok") return;
  const body = { machine: newMachine, kind: newKind, cwd: $("nCwd").value.trim(), ...(newKind === "shell" ? {} : nSel), args: $("nArgs").value.trim(), prompt: newKind === "shell" ? "" : $("nPrompt").value, label: $("nLabel").value.trim(), focus: $("nFocus").checked };
  if (newMkdir && home(newMkdir) === body.cwd) body.mkdir = true; // quests: startRun
  store("newCwd:" + newMachine, body.cwd); store("args:" + newKind, body.args); store("newFocus", body.focus);
  try {
    const { key } = await api("/api/new", body);
    pendingSelect = key;
    if (S.rows.has(key)) { pendingSelect = null; select(key, { scroll: true, open: true }); }
    toast(newKind === "shell" ? "Opened a shell" : `Starting ${newKind}…`);
  } catch (e) { toast("Couldn’t start: " + e.message, true); }
});
