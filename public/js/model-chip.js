"use strict";
// The chat's model + effort chip in the composer: what the session runs on, and changing it.
// Claude Code takes /model and /effort with an argument, typed into its pane (queued while it works). A Codex app task
// changes through the app's own settings. Codex CLI and OpenCode only have a picker in their terminal, so the chip
// opens that rather than pressing keys in a menu it can't see.
// <model-chip-pure>
const MCHIP_CLAUDE_MODELS = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const MCHIP_CLAUDE_EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max"];
/** Before the first reply there is nothing to read but how it was started: --model / -m and --effort (Codex: -c). */
function mchipLaunched(r) {
  const c = String(r?.command ?? "");
  return { model: c.match(/(?:^|\s)(?:--model|-m)(?:=|\s+)["']?([\w.:/@[\]-]+)/)?.[1],
    effort: c.match(/(?:^|\s)--effort(?:=|\s+)["']?(\w+)/)?.[1] ?? c.match(/model_reasoning_effort=["']?(\w+)/)?.[1] };
}
/** "claude-opus-5-5" → "Opus 5.5"; a model Claude Code just switched to (its own name for it) wins until the next reply. */
function mchipModelName(r) {
  if (r?.agent === "claude" && r.modelName) return r.modelName;
  const id = String(r?.model || mchipLaunched(r).model || "");
  const c = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (c) return `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}${c[3] ? `.${c[3]}` : ""}`;
  if (r?.agent === "claude" && /^[a-z]+$/.test(id)) return id[0].toUpperCase() + id.slice(1); // an alias: --model haiku
  return r?.agent === "opencode" ? id.split("/").pop() : id;
}
const mchipEffort = (r) => r?.effort || mchipLaunched(r).effort || "";
/** "Opus 5.5 · xhigh", or "Opus · xhigh" where space is short. */
function mchipLabel(r, short) {
  let name = mchipModelName(r) || "Default model";
  if (short && r?.agent === "claude") name = name.replace(/ [\d.]+( \(.*\))?$/, "");
  return [name, mchipEffort(r)].filter(Boolean).join(" · ");
}
/** How the model can change here: "claude" (typed commands), "codex-app" (the app's settings), "terminal" (the
 *  agent's own picker), or "" (no chip). */
function mchipMode(r) {
  if (!r || r.hist) return "";
  if (r.app) return r.agent === "codex" ? "codex-app" : "";
  return r.agent === "claude" ? "claude" : r.agent === "codex" || r.agent === "opencode" ? "terminal" : "";
}
/** The Claude alias the session is on (fable, opus…), to tick it. */
function mchipFamily(r) {
  const s = (r?.modelName || r?.model || mchipLaunched(r).model || "").toLowerCase();
  return MCHIP_CLAUDE_MODELS.map(([v]) => v).find((v) => s.includes(v)) ?? "";
}
/** Only known aliases and levels are ever typed into a pane. */
function mchipClaudeCommand(kind, value) {
  if (kind === "model" && MCHIP_CLAUDE_MODELS.some(([v]) => v === value)) return `/model ${value}`;
  if (kind === "effort" && MCHIP_CLAUDE_EFFORTS.includes(value)) return `/effort ${value}`;
  return null;
}
// </model-chip-pure>

// A Codex app task: the app's live state is newer than its rollout.
const mchipRow = (r) => (r?.app ? { ...r, model: codexView(r)?.model || r.model, effort: codexView(r)?.effort || r.effort } : r);
const mchipBusy = (r) => r.status === "working" || r.status === "blocked";

function renderModelChip(r) {
  const b = $("cModel"), mode = mchipMode(r), v = mode && mchipRow(r);
  b.hidden = !mode || (mode !== "claude" && !mchipModelName(v));
  if (b.hidden) return;
  const html = `<span class="mc-full">${esc(mchipLabel(v))}</span><span class="mc-short">${esc(mchipLabel(v, true))}</span>`;
  if (b._h !== html) { b._h = html; b.innerHTML = html + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>'; }
  b.title = mode === "terminal" ? "Model and effort (change them in the agent's own picker)" : "Model and effort";
}
$("cModel").onclick = (e) => modelMenu(e.currentTarget, rowOf(S.sel));

async function modelMenu(anchor, r) {
  const mode = mchipMode(r);
  if (mode === "claude") return openMenu(anchor, mchipClaudeItems(r), "Model", "up mchip-menu");
  if (mode === "codex-app") return mchipCodexMenu(anchor, r);
  if (mode === "terminal") return openMenu(anchor, mchipTerminalItems(r), "Model", "up mchip-menu");
}

function mchipClaudeItems(r) {
  const fam = mchipFamily(r);
  return [
    ...MCHIP_CLAUDE_MODELS.map(([v, l]) => ({ html: esc(l), on: fam === v, run: () => mchipSetClaude(r, "model", v) })),
    { label: "Effort" },
    ...MCHIP_CLAUDE_EFFORTS.map((v) => ({ html: v === "auto" ? "Auto<small>The model's own default</small>" : esc(v), on: mchipEffort(r) === v, run: () => mchipSetClaude(r, "effort", v) })),
    { note: "Like typing /model or /effort, Claude Code also keeps a new model (and effort up to xhigh) as your default for new sessions." },
  ];
}
async function mchipSetClaude(r, kind, value) {
  const text = mchipClaudeCommand(kind, value);
  if (!text) return;
  const before = kind === "model" ? mchipFamily(r) : mchipEffort(r);
  const undo = before && before !== value && mchipClaudeCommand(kind, before) ? { label: "Undo", run: () => mchipSetClaude(rowOf(r.key) ?? r, kind, before) } : undefined;
  try {
    const live = rowOf(r.key) ?? r;
    if (mchipBusy(live)) { await api("/api/queue", { op: "add", key: r.key, text }); toast(`Claude Code gets ${text} when it finishes this turn`, false, undo); }
    else { await api("/api/send", { key: r.key, text }); toast(`Sent ${text}`, false, undo); }
  } catch (x) { toast(`Couldn't send ${text}: ${x.message}`, true, { label: "Retry", run: () => mchipSetClaude(rowOf(r.key) ?? r, kind, value) }); }
}

async function mchipCodexMenu(anchor, r) {
  const v = mchipRow(r);
  if (!codexHasCapability(r, "settings")) return openMenu(anchor, [
    { html: `${esc(mchipModelName(v))}${mchipEffort(v) ? `<small>Reasoning effort ${esc(mchipEffort(v))}</small>` : ""}`, on: true, run: () => {} },
    { note: "Reconnect to the Codex app to change these." },
  ], "Model", "up mchip-menu");
  let s;
  try { s = await api("/api/codex-settings", { key: r.key }); } catch (x) { return toast(x.message, true, { label: "Retry", run: () => mchipCodexMenu(anchor, rowOf(r.key) ?? r) }); }
  const cur = s.models.find((m) => m.id === s.model);
  openMenu(anchor, [
    ...s.models.map((m) => ({ html: esc(m.label), on: m.id === s.model, run: () => mchipSetCodex(r, s, { model: m.id }) })),
    cur?.efforts?.length && { label: "Reasoning effort" },
    ...(cur?.efforts ?? []).map((e) => ({ html: esc(e), on: e === s.effort, run: () => mchipSetCodex(r, s, { effort: e }) })),
  ].filter(Boolean), "Model", "up mchip-menu");
}
async function mchipSetCodex(r, s, patch) {
  try {
    await api("/api/codex-settings", { key: r.key, expectedVersion: s.version, ...patch });
    toast("Codex settings saved for the next turn");
    codexViews.set(r.key, await api("/api/codex-state", { key: r.key })); renderDetail();
  } catch (x) { toast(x.message, true, { label: "Retry", run: () => mchipSetCodex(r, s, patch) }); }
}

function mchipTerminalItems(r) {
  const name = r.agent === "opencode" ? "OpenCode" : "Codex", cmd = r.agent === "opencode" ? "/models" : "/model";
  const busy = mchipBusy(r);
  return [
    { html: `${esc(mchipModelName(r))}${mchipEffort(r) ? `<small>${r.agent === "opencode" ? "Variant" : "Reasoning effort"} ${esc(mchipEffort(r))}</small>` : ""}`, on: true, run: () => {} },
    "-",
    { html: `Change in the terminal<small>${busy ? `Available when ${name} finishes this turn` : `Opens ${name}'s own ${cmd} picker`}</small>`, run: () => mchipOpenPicker(rowOf(r.key) ?? r, cmd, name) },
  ];
}
async function mchipOpenPicker(r, cmd, name) {
  // A picker left open while the deck sends a queued message would swallow it, so only while idle.
  if (mchipBusy(r)) return toast(`${name} is busy. Change its model when it finishes this turn.`, true);
  try { await api("/api/send", { key: r.key, text: cmd }); }
  catch (x) { return toast(`Couldn't send ${cmd}: ${x.message}`, true, { label: "Retry", run: () => mchipOpenPicker(rowOf(r.key) ?? r, cmd, name) }); }
  if (isPhone()) setMView("term"); else focusTerminal();
  toast(`Pick the model in ${name}'s picker`);
}
