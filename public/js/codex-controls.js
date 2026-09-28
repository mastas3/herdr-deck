"use strict";
// Native app requests stay attached to their real request and turn ids, even with two pages open.
const codexViews = new Map();
let codexPoll = null, codexPollKey = null;
const codexView = (r) => codexViews.get(r?.key);
const codexCanReply = (r) => !r?.app || !!codexView(r)?.ready;
function syncCodexControl(r) {
  const key = r?.app && !S.board && !S.mode ? r.key : null;
  if (key === codexPollKey) return;
  clearTimeout(codexPoll); codexPollKey = key;
  if (!key) return;
  const tick = async () => {
    try {
      const value = await api("/api/codex-state", { key });
      codexViews.set(key, value);
      if (codexPollKey === key) { renderDetail(); renderQueue(rowOf(key)); }
    } catch (e) {
      codexViews.set(key, { ready: false, requests: [], error: e.message });
      if (codexPollKey === key) renderDetail();
    }
    if (codexPollKey === key) codexPoll = setTimeout(tick, 1800);
  };
  codexPoll = setTimeout(tick, 0);
}
async function reconnectCodex(r) {
  toast("Connecting to the Codex app…");
  try { codexViews.set(r.key, await api("/api/codex-state", { key: r.key, reconnect: true })); renderDetail(); }
  catch (e) { toast(e.message, true); }
}
async function stopCodex(r) {
  try {
    const turnId = codexView(r)?.activeTurnId;
    if (!turnId) throw new Error("Waiting for the active Codex turn. Try again when its state refreshes.");
    await api("/api/codex-stop", { key: r.key, turnId }); toast("Stopped the Codex turn");
  } catch (e) { toast(e.message, true); }
}
async function compactCodex(r) {
  try { await api("/api/codex-compact", { key: r.key }); toast("Compacting the Codex conversation"); }
  catch (e) { toast(e.message, true); }
}
function renderCodexRequests(r) {
  const el = $("askbox"), requests = codexView(r)?.ready ? codexView(r).requests ?? [] : [];
  clearTimeout(askTimer); askTimer = null;
  el.hidden = !requests.length || !!S.sub || S.board;
  if (el.hidden) { el._codexSig = null; return; }
  const sig = JSON.stringify([r.key, requests]);
  if (el._codexSig === sig) return;
  el._codexSig = sig;
  el.innerHTML = requests.map((request, i) => {
    const p = request.params, method = request.method;
    let content = "", buttons = "";
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
      const title = method.includes("commandExecution") ? "Allow this command?" : method.includes("fileChange") ? "Allow these file changes?" : "Grant these permissions for this turn?";
      const preview = p.command ?? p.changes ?? p.permissions ?? p.grantRoot ?? p.networkApprovalContext ?? "Review the pending action in Codex.";
      content = `<b>${title}</b>${p.reason ? `<p>${esc(p.reason)}</p>` : ""}<pre>${esc(typeof preview === "string" ? preview : JSON.stringify(preview, null, 2))}</pre>${p.cwd ? `<p class="hint">${esc(home(p.cwd))}</p>` : ""}`;
      const choices = p.availableDecisions ?? ["accept", "decline"];
      buttons = [["accept", "Approve"], ["acceptForSession", "Allow for session"], ["decline", "Deny"], ["cancel", "Cancel"]]
        .filter(([k]) => choices.includes(k)).map(([k, label]) => `<button class="btn${k === "accept" ? " primary" : ""}" data-native-decision="${k}">${label}</button>`).join(" ");
    } else if (method === "item/tool/requestUserInput" || method === "deck/asyncQuestion") {
      content = (p.questions ?? []).map((q, j) => `<label class="native-question"><b>${esc(q.question)}</b>${q.options?.length ? `<select data-native-answer="${j}"><option value="">Choose an answer</option>${q.options.map((v) => `<option value="${esc(v.label)}">${esc(v.label)}${v.description ? ` — ${esc(v.description)}` : ""}</option>`).join("")}</select>` : ""}<input data-native-text="${j}" type="${q.isSecret ? "password" : "text"}" autocomplete="off" placeholder="${q.options?.length ? "Or type an answer" : "Your answer"}"></label>`).join("");
      buttons = '<button class="btn primary" data-native-decision="answer">Submit answers</button>';
    } else if (method === "mcpServer/elicitation/request") {
      content = `<b>${esc(p.serverName ?? "Connected app")}</b><p>${esc(p.message ?? "Input requested")}</p>${p.requestedSchema ? `<pre>${esc(JSON.stringify(p.requestedSchema, null, 2))}</pre><textarea data-native-json placeholder="Response as JSON"></textarea>` : '<p class="hint">Complete this request in Codex.</p>'}`;
      buttons = `${p.requestedSchema ? '<button class="btn primary" data-native-decision="form">Submit response</button>' : ""}<button class="btn" data-native-decision="decline-form">Decline</button>`;
    } else content = '<p>Codex needs input. Open the task in the app to answer this request.</p>';
    return `<div class="native-request" data-native-request="${i}">${content}<div class="ks">${buttons}<button class="btn ghost" data-native-open>Open in Codex</button></div></div>`;
  }).join("");
}
$("askbox").addEventListener("click", async (e) => {
  const box = e.target.closest("[data-native-request]"), r = rowOf(S.sel);
  if (!box || !r?.app) return;
  if (e.target.closest("[data-native-open]")) return codexAct("codex-open", r);
  const button = e.target.closest("[data-native-decision]");
  if (!button) return;
  const request = codexView(r)?.requests?.[Number(box.dataset.nativeRequest)];
  if (!request) return;
  const decision = button.dataset.nativeDecision;
  try {
    let answer = { decision };
    if (decision === "answer") {
      const answers = Object.create(null);
      for (const [i, q] of request.params.questions.entries()) {
        const value = box.querySelector(`[data-native-text="${i}"]`).value.trim() || box.querySelector(`[data-native-answer="${i}"]`)?.value;
        if (!value) throw new Error("Answer each question first.");
        answers[q.id] = { answers: [value] };
      }
      answer = { answers };
    } else if (decision === "form") answer = { action: "accept", content: JSON.parse(box.querySelector("[data-native-json]").value) };
    else if (decision === "decline-form") answer = { action: "decline" };
    button.disabled = true;
    await api("/api/codex-respond", { key: r.key, requestId: request.id, answer });
    codexViews.set(r.key, await api("/api/codex-state", { key: r.key })); renderDetail();
  } catch (err) { toast(err.message, true); }
  finally { button.disabled = false; }
});
