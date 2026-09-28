"use strict";
// The New session dialog.
// ── new session ──────────────────────────────────────────────────────────
const KINDS = [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["shell", "Shell"]];
let newOpts = null, newKind = load("newKind", "claude"), newMachine = null, pendingSelect = null, newMkdir = null;
let nSel = { model: "", effort: "", mode: "" };
let newCodexTarget = load("newCodexTarget", "app"), newOptionsSeq = 0;
let newCodexReceipt = null;
const newCodexApp = () => newKind === "codex" && newCodexTarget === "app" && !!newOpts?.codexApp?.create;
async function loadNewOptions() {
  const seq = ++newOptionsSeq;
  newOpts = null; renderKinds();
  try { const opts = await api("/api/new-options", { machine: newMachine }); if (seq !== newOptionsSeq) return; newOpts = opts; }
  catch (e) { if (seq !== newOptionsSeq) return; newOpts = { recent: [], projects: [], argHints: {}, choices: {} }; toast(e.message, true); }
  const cur = rowOf(S.sel);
  const saved = load("newCwd:" + newMachine, "");
  $("nCwd").value = saved || (cur && cur.machine === newMachine ? home(cur.projectRoot ?? cur.cwd) : "") || home(newOpts.recent[0] ?? "");
  $("nCwdList").innerHTML = [...new Set([...newOpts.recent, ...newOpts.projects])].map((p) => `<option value="${esc(home(p))}">`).join("");
  const projRoots = [...new Set([...S.rows.values()].filter((r) => r.machine === newMachine && r.projectRoot).sort((a, b) => act(b) - act(a)).map((r) => r.projectRoot))];
  const recent = [...new Set([...projRoots, ...newOpts.recent])].slice(0, 7);
  $("nCwdSugg").innerHTML = recent.length ? `<span class="hint">Recent:</span>` + recent.map((p) => `<button type="button" data-cwd="${esc(home(p))}" title="${esc(p)}">${esc(p.split("/").pop())}</button>`).join("") : "";
  renderKinds();
}
/** Where a project lives: the folder and machine of its most recent session (a worktree's session: its repo's main
 *  checkout). `key` is that session, which routes requests about the folder to its machine. */
function projectHome(p) {
  const r = [...S.rows.values()].filter((r) => r.project === p && r.projectRoot && inScope(r)).sort((a, b) => act(b) - act(a))[0];
  return r ? { machine: r.machine, cwd: (r.worktree && r.gitRoot) || r.projectRoot, project: p, key: r.key } : undefined;
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
  const shell = newKind === "shell", native = newCodexApp();
  $("nCodexTargetWrap").hidden = newKind !== "codex";
  $("nCodexArchives").hidden = !newOpts?.codexApp?.restore;
  for (const b of $("nCodexTarget").children) { b.disabled = b.dataset.codexTarget === "app" && !newOpts?.codexApp?.create; b.setAttribute("aria-pressed", (native ? "app" : "cli") === b.dataset.codexTarget); }
  $("nCodexTargetHelp").textContent = !newOpts ? "Checking Codex support on this machine…" : native ? "A native Codex task with direct replies and app tools. Model and permissions inherit from Codex; change them in the task’s menu." : newOpts?.codexApp?.create ? "Starts the Codex CLI in a herdr terminal." : newOpts?.codexApp?.error ?? "Native Codex tasks are unavailable on this machine. The CLI runs in a herdr terminal.";
  $("nPromptWrap").hidden = shell; $("nArgsWrap").hidden = shell || native; $("nAgentOpts").hidden = shell || native;
  $("nFocus").closest("label").hidden = native;
  $("nLabelText").textContent = native ? "Task name (optional)" : "Tab name (defaults to the folder name)";
  $("nMore").querySelector("summary").textContent = native ? "More: task name" : "More: extra flags, tab name";
  $("nOk").textContent = native ? "Create Codex task" : "Start session";
  $("nOk").disabled = !newOpts;
  nSel = { model: "", effort: "", mode: "", ...load("opts:" + newKind, {}) };
  $("nArgs").value = load("args:" + newKind, "");
  const hints = newOpts?.argHints?.[newKind] ?? [];
  $("nArgsSugg").innerHTML = hints.length ? `<span class="hint">Your other ${esc(newKind)} sessions use:</span>` + hints.map((h) => `<button type="button" data-args="${esc(h)}">${esc(h)}</button>`).join("") : "";
  renderAgentOpts();
}
function renderAgentOpts() {
  if (newCodexApp()) { $("nAgentOpts").hidden = true; renderCmd(); return; }
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
  if (newCodexApp()) { $("nCmd").textContent = `Codex app task in ${$("nCwd").value || "…"}`; return; }
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
$("nCodexTarget").addEventListener("click", (e) => { const b = e.target.closest("[data-codex-target]"); if (!b || b.disabled) return; newCodexTarget = b.dataset.codexTarget; store("newCodexTarget", newCodexTarget); renderKinds(); });
$("nCodexArchives").onclick = () => { $("newDlg").close("cancel"); openCodexArchives(newMachine); };
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
async function submitNewSession() {
  const body = { machine: newMachine, kind: newKind, cwd: $("nCwd").value.trim(), ...(newKind === "shell" ? {} : nSel), args: $("nArgs").value.trim(), prompt: newKind === "shell" ? "" : $("nPrompt").value, label: $("nLabel").value.trim(), focus: $("nFocus").checked };
  if (newMkdir && home(newMkdir) === body.cwd) body.mkdir = true; // quests: startRun
  store("newCwd:" + newMachine, body.cwd); store("args:" + newKind, body.args); store("newFocus", body.focus);
  try {
    const native = newCodexApp();
    const nativeBody = { machine: body.machine, cwd: body.cwd, title: body.label, prompt: body.prompt, mkdir: body.mkdir };
    const signature = JSON.stringify(nativeBody);
    if (native && newCodexReceipt?.signature !== signature) newCodexReceipt = { signature, id: crypto.randomUUID() };
    const result = native ? await api("/api/codex-create", { ...nativeBody, requestId: newCodexReceipt.id }) : await api("/api/new", body);
    if (native) newCodexReceipt = null;
    const { key } = result;
    if (native && key && result.promptSent === false && result.canRetryPrompt !== false && !result.deliveryUnknown && !result.promptPersisted && body.prompt) S.drafts.set(key, body.prompt);
    pendingSelect = key;
    if (S.rows.has(key)) { pendingSelect = null; select(key, { scroll: true, open: true }); }
    toast(native && result.deliveryUnknown ? "Task created. First-message delivery is uncertain; check its conversation before sending again." : native && result.canRetryPrompt === false ? `Task created; its conversation has changed. ${result.error ?? "Open it in Codex to continue."}` : native && result.promptSent === false && body.prompt ? `Task created; first message ${result.promptPersisted ? "saved in Codex" : "kept as a draft"}. ${result.error ?? "Reconnect to continue."}` : native ? "Created a Codex app task" : newKind === "shell" ? "Opened a shell" : `Starting ${newKind}…`, !!(native && (result.error || result.deliveryUnknown)));
  } catch (e) { if (e.code && e.code !== "CODEX_DELIVERY_UNKNOWN") newCodexReceipt = null; toast("Couldn’t start: " + e.message, true); }
}
$("newDlg").addEventListener("close", () => { if ($("newDlg").returnValue === "ok") void submitNewSession(); });
