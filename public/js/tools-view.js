"use strict";
// The Tools view: what each tool sends, and your own tools.
// Tools view ────────────────────────────────────────────────────────────────
function renderTools() {
  const cur = rowOf(S.sel);
  const target = cur && !cur.hist && !cur.app && isAgent(cur) ? cur : null;
  const groups = Object.entries(S.toolGroups ?? {});
  const card = (t) => `<div class="tcard" data-tool="${esc(t.id)}"><div class="tt">${toolGlyph(t)}<b>${esc(t.label)}</b>${t.kind === "action" ? '<span class="tk">runs in the deck</span>' : t.kind === "sequence" ? '<span class="tk">2 steps</span>' : ""}</div><p>${esc(t.hint ?? "")}</p>
      ${t.prompt ? `<details><summary>What it sends</summary><pre>${esc(t.prompt)}${t.then ? `\n\n— then, when it’s done —\n\n${esc(t.then)}` : ""}</pre></details>` : ""}
      <div class="tacts">${target || t.action === "upload" ? `<button class="btn primary" data-trun="${esc(t.id)}">Use on “${esc((target?.title ?? "this session").slice(0, 28))}”</button>` : `<span class="hint">Open a session to use it</span>`}${t.builtin ? "" : `<button class="btn ghost" data-tedit="${esc(t.id)}">Edit</button><button class="btn ghost" data-tdel="${esc(t.id)}">Delete</button>`}</div></div>`;
  modeHTML(`<header class="vh"><h2>${ICON.tools}Tools</h2><p>One click makes the agent do something useful, or the deck does it for you. Use them from a session’s <b>Tools</b> button, the ☆ in the message box, <kbd>.</kbd>, or ⌘K. Select several sessions to use one on all of them.</p></header>
    ${groups.map(([g, label]) => { const ts = S.tools.filter((t) => t.group === g); return ts.length || g === "custom" ? `<section class="tgroup"><h3>${esc(label)}</h3><div class="tgrid">${ts.map(card).join("")}${g === "custom" ? `<button class="tcard add" data-tnew>${ICON.star}<b>New tool</b><p>A prompt you send often, one click away. Use {project}, {branch}, {title} and {handoff}.</p></button>` : ""}</div></section>` : ""; }).join("")}`);
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "tools") return;
  const run = e.target.closest("[data-trun]")?.dataset.trun;
  if (run) { const t = S.tools.find((x) => x.id === run); if (t) runTool(t, S.sel ? [S.sel] : []); return; }
  const edit = e.target.closest("[data-tedit]")?.dataset.tedit;
  const del = e.target.closest("[data-tdel]")?.dataset.tdel;
  const custom = S.tools.filter((t) => !t.builtin);
  if (del) { if (await askDialog({ title: "Delete this tool?", ok: "Delete", danger: true })) saveTools(custom.filter((t) => t.id !== del)); return; }
  if (edit || e.target.closest("[data-tnew]")) {
    const t = custom.find((x) => x.id === edit) ?? {};
    const label = await askDialog({ title: edit ? "Edit tool" : "New tool", text: "Its name", input: t.label ?? "", ok: "Next" });
    if (!label) return;
    const prompt = await askDialog({ title: label, text: "What it sends to the agent. {project}, {branch}, {title} and {handoff} are filled in.", input: t.prompt ?? "", ok: "Save", multiline: true });
    if (!prompt) return;
    saveTools(edit ? custom.map((x) => (x.id === edit ? { ...x, label, prompt } : x)) : [...custom, { label, prompt, hint: prompt.slice(0, 120) }]);
  }
});
async function saveTools(custom) {
  try { S.tools = (await api("/api/tools", { tools: custom })).tools; renderTools(); toast("Saved"); } catch (e) { toast(e.message, true); }
}
