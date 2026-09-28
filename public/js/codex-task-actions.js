"use strict";
// Native task settings are provided by the connected app, including its supported choices.
const codexHasCapability = (r, name) => !!r?.app && !!codexView(r)?.capabilities?.[name] && (!["settings", "edit"].includes(name) || !!codexView(r)?.ready);
function codexPermissionFacts(settings) {
  const p = settings.permissions;
  if (!p) return "";
  const facts = [["Files", p.filesystem], ["Network", { enabled: "Allowed", restricted: "Restricted", unknown: "Not reported" }[p.networkAccess]], ["Approvals", p.approvalPolicy], ["Reviewed by", p.reviewer]];
  const profile = (id) => ({ ":workspace": "Workspace", ":workspace-write": "Workspace write", ":read-only": "Read only", ":danger-full-access": "Full access" }[id] ?? id);
  if (p.profileId) facts.unshift(["Profile", profile(p.profileId)]);
  if (p.selectedProfileId && p.selectedProfileId !== p.profileId) facts.push(["Selected profile", profile(p.selectedProfileId)]);
  return `<section class="native-permission-facts"><h4>${p.source === "current" ? "Current permissions" : "Last reported permissions"}</h4><dl>${facts.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}${p.writableRoots?.length ? `<dt>Writable folders</dt><dd>${p.writableRoots.map((root) => `<span class="native-permission-root">${esc(home(root))}</span>`).join("")}</dd>` : ""}</dl>${!settings.permissionModes?.length ? '<p class="hint">Codex controls the full profile and its restrictions.</p>' : ""}</section>`;
}
async function openCodexSettings(r) {
  try {
    const settings = await api("/api/codex-settings", { key: r.key });
    showCodexSettings(r, settings);
  } catch (e) { toast(e.message, true); }
}
function showCodexSettings(r, settings) {
  const dlg = document.createElement("dialog");
  dlg.className = "native-settings";
  dlg.setAttribute("aria-label", "Codex task settings");
  const models = [...(settings.models ?? [])];
  if (settings.model && !models.some((m) => m.id === settings.model)) models.unshift({ id: settings.model, label: settings.model, efforts: [settings.effort].filter(Boolean) });
  const modes = settings.permissionModes ?? [];
  dlg.innerHTML = `<form><div class="dlg-b"><h3>Codex task settings</h3><p>${esc(r.title || "This task")}</p><p class="hint">Changes apply to the next turn.</p>
    <label class="field"><span>Model</span><select name="model">${models.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join("")}</select></label>
    <label class="field"><span>Reasoning effort</span><select name="effort"></select></label>
    ${modes.length ? `<label class="field"><span>Permissions</span><select name="permissionMode">${modes.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join("")}</select><span class="hint" data-permission-help></span></label>` : `<p class="hint">${esc(settings.permissionsNote ?? "This task inherits its managed permission settings from Codex.")}</p>`}
    ${codexPermissionFacts(settings)}${!modes.length ? '<p class="hint">Use the task permission menu to change this profile.</p><button type="button" class="btn" data-settings-open>Open in Codex</button>' : ""}
    <p class="native-form-error" role="alert" hidden></p></div><div class="dlg-f"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save settings</button></div></form>`;
  document.body.append(dlg);
  const form = dlg.querySelector("form"), model = form.elements.model, effort = form.elements.effort, permission = form.elements.permissionMode;
  const error = dlg.querySelector('[role="alert"]'), save = dlg.querySelector('[type="submit"]');
  model.value = settings.model ?? models[0]?.id ?? "";
  const syncEffort = (preferred) => {
    const choice = models.find((m) => m.id === model.value), choices = choice?.efforts ?? [];
    effort.innerHTML = choices.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join("");
    effort.disabled = !choices.length;
    effort.value = choices.includes(preferred) ? preferred : choice?.defaultEffort ?? choices[0] ?? "";
    if (!effort.value && choices.length) effort.value = choices[0];
  };
  syncEffort(settings.effort);
  model.onchange = () => syncEffort(effort.value);
  if (permission) {
    permission.value = settings.permissionMode ?? "";
    // A managed or custom mode must remain intact unless a user picks a replacement.
    if (!permission.value) { permission.insertAdjacentHTML("afterbegin", '<option value="" selected>Keep current permissions</option>'); permission.value = ""; }
    permission.disabled = !!settings.status && settings.status !== "idle";
    const syncPermission = () => { dlg.querySelector("[data-permission-help]").textContent = permission.disabled ? "Wait for this turn to finish before changing permissions." : modes.find((m) => m.id === permission.value)?.description ?? "Keep the permissions already configured in Codex."; };
    permission.onchange = syncPermission; syncPermission();
  }
  dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
  dlg.querySelector("[data-settings-open]")?.addEventListener("click", () => codexAct("codex-open", r));
  dlg.addEventListener("close", () => dlg.remove());
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    if (model.value !== settings.model) patch.model = model.value;
    if (!effort.disabled && effort.value !== settings.effort) patch.effort = effort.value;
    if (permission?.value && !permission.disabled && permission.value !== settings.permissionMode) patch.permissionMode = permission.value;
    if (!Object.keys(patch).length) return dlg.close();
    save.disabled = true; error.hidden = true;
    try {
      await api("/api/codex-settings", { key: r.key, expectedVersion: settings.version, ...patch });
      dlg.close(); toast("Codex settings saved for the next turn");
      codexViews.set(r.key, await api("/api/codex-state", { key: r.key })); renderDetail();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
    finally { save.disabled = false; }
  };
  dlg.showModal(); model.focus();
}
async function editCodexLastMessage(r) {
  try {
    const state = await api("/api/codex-state", { key: r.key });
    codexViews.set(r.key, state);
    const turn = state.editableTurn;
    if (!state.ready || !turn || state.activeTurnId) throw new Error("The last message can only be edited while this task is idle.");
    const text = await askDialog({ title: "Edit last Codex message", text: "Codex will replace the last user message and run that turn again. Its current response will be replaced.", input: turn.text, multiline: true, selectInput: false, ok: "Save and rerun" });
    if (text == null || text === turn.text) return;
    if (!text.trim()) throw new Error("Enter a message first.");
    await api("/api/codex-edit", { key: r.key, turnId: turn.turnId, text, requestId: crypto.randomUUID() });
    toast("Codex is rerunning the edited message");
    chats.delete(chatId(r.key)); chatDom.key = null; chatTick(true);
  } catch (e) { toast(e.message, true); }
}
const codexTaskMutations = new Set();
const codexForkReceipts = new Map();
async function codexTaskAction(r, action, extra = {}) {
  const mutation = `${r.key}:${action}`;
  if (codexTaskMutations.has(mutation)) return;
  codexTaskMutations.add(mutation);
  try {
    if (action === "rename") {
      const title = await askDialog({ title: "Rename Codex task", input: r.title || "", ok: "Rename" });
      if (title == null || title === r.title) return;
      if (!title.trim()) throw new Error("Enter a task name first.");
      await api("/api/codex-rename", { key: r.key, title: title.trim() });
      r.title = title.trim(); headSig = ""; render(); renderDetail(); toast("Codex task renamed");
    } else if (action === "fork") {
      toast("Forking the Codex task…");
      const receipt = codexForkReceipts.get(r.key) ?? crypto.randomUUID();
      codexForkReceipts.set(r.key, receipt);
      const result = await api("/api/codex-fork", { key: r.key, requestId: receipt });
      codexForkReceipts.delete(r.key);
      if (result.key) { pendingSelect = result.key; if (S.rows.has(result.key)) { pendingSelect = null; select(result.key, { scroll: true, open: true }); } }
      toast("Created a separate Codex task with this conversation");
    } else if (action === "archive") {
      const archived = extra.archived !== false;
      const result = await api("/api/codex-archive", { key: r.key, archived });
      if (archived) { if (S.sel === r.key) { S.board = true; renderDetail(); } toast("Archived in Codex.", false, { label: "Undo", run: () => codexTaskAction(r, "archive", { archived: false }).catch(() => {}) }); }
      else { pendingSelect = result.key ?? r.key; if (S.rows.has(pendingSelect)) { const key = pendingSelect; pendingSelect = null; select(key, { scroll: true, open: true }); } toast("Restored the Codex task"); }
    }
  } catch (e) {
    if (action === "fork" && e.code && e.code !== "CODEX_DELIVERY_UNKNOWN") codexForkReceipts.delete(r.key);
    const open = e.action?.kind === "open-codex" || e.code === "CODEX_DESKTOP_REQUIRED";
    toast(e.message, true, open ? { label: "Open in Codex", run: () => openCodexArchive(r) } : { label: "Retry", run: () => codexTaskAction(r, action, extra).catch(() => {}) });
    throw e;
  }
  finally { codexTaskMutations.delete(mutation); }
}
function codexTaskMenu(r) {
  const idle = !codexView(r)?.activeTurnId && r.status !== "working" && r.status !== "blocked";
  const desktopArchive = codexView(r)?.ready && codexView(r)?.capabilities?.archiveLoaded === false;
  return [
    codexHasCapability(r, "rename") && { html: "Rename Codex task…", run: () => codexTaskAction(r, "rename").catch(() => {}) },
    codexHasCapability(r, "fork") && idle && { html: "Fork in Codex", run: () => codexTaskAction(r, "fork").catch(() => {}) },
    codexHasCapability(r, "archive") && idle && { html: desktopArchive ? "Archive in Codex app…" : "Archive in Codex", run: () => desktopArchive ? openCodexArchive(r) : codexTaskAction(r, "archive").catch(() => {}) },
    codexHasCapability(r, "restore") && { html: "Archived Codex tasks…", run: () => openCodexArchives(r.machine) },
  ].filter(Boolean);
}
async function openCodexArchive(r) {
  try { await api("/api/codex-open", { key: r.key }); toast("Task opened in Codex. Use its task menu to archive it."); }
  catch (e) { toast(e.message, true, { label: "Retry", run: () => openCodexArchive(r) }); }
}
async function openCodexArchives(machine = S.self) {
  const dlg = document.createElement("dialog");
  dlg.className = "native-archives"; dlg.setAttribute("aria-label", "Archived Codex tasks");
  dlg.innerHTML = '<div class="dlg-b"><h3>Archived Codex tasks</h3><p class="hint">Restore a task to continue its conversation in Codex.</p><div data-native-archives>Loading…</div><p class="native-form-error" role="alert" hidden></p><button class="btn ghost" data-native-more hidden>Older tasks</button></div><div class="dlg-f"><button class="btn" data-native-close>Close</button></div>';
  document.body.append(dlg); dlg.showModal();
  dlg.querySelector("[data-native-close]").onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  const list = dlg.querySelector("[data-native-archives]"), more = dlg.querySelector("[data-native-more]"), error = dlg.querySelector('[role="alert"]');
  let tasks = [], cursor;
  const render = () => { list.innerHTML = tasks.length ? tasks.map((r, i) => `<div class="native-archive-row"><span><b>${esc(r.title || "Untitled task")}</b><small>${esc(home(r.cwd || ""))}</small></span><button class="btn" data-restore="${i}">Restore</button></div>`).join("") : '<p class="hint">No archived Codex tasks.</p>'; more.hidden = !cursor; };
  const loadMore = async () => {
    more.disabled = true; error.hidden = true;
    try { const result = await api("/api/codex-archived", { machine, cursor }); tasks.push(...(result.tasks ?? []).filter((r) => !tasks.some((t) => t.key === r.key))); cursor = result.nextCursor; render(); }
    catch (e) { error.textContent = e.message; error.hidden = false; if (!tasks.length) list.textContent = ""; }
    finally { more.disabled = false; }
  };
  more.onclick = loadMore;
  list.onclick = async (e) => {
    const button = e.target.closest("[data-restore]"); if (!button) return;
    const task = tasks[Number(button.dataset.restore)]; if (!task) return;
    button.disabled = true;
    try { await codexTaskAction(task, "archive", { archived: false }); tasks = tasks.filter((r) => r.key !== task.key); render(); }
    catch (e) { error.textContent = e.message; error.hidden = false; button.disabled = false; }
  };
  await loadMore();
}
