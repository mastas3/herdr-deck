"use strict";
// A readable task first; its machinery and team unfold in place without opening the chat.
const exSessionOpen = load("explorerSessionDetails", {}), exTeamOpen = load("explorerTeams", {}), exTeamHistory = new Set();
const exAgentName = r => r.app ? "Codex app" : ({ claude: "Claude", codex: "Codex", opencode: "OpenCode", shell: "Terminal" }[r.agent] || r.agent || "Session");
function exStatus(r) {
  if (r.startup) return { text: r.startup.state === "failed" ? "Launch failed" : r.startup.state === "unknown" ? "Check launch" : "Starting", kind: "blocked" };
  if (r.status === "working") return { text: `Working${r.turnStartedAt ? " · " + exElapsed(r.turnStartedAt) : ""}`, kind: "working" };
  if (r.status === "blocked") return { text: "Needs you", kind: "blocked" };
  if (r.status === "done") return { text: r.seen ? "Finished" : "Ready to review", kind: "done" };
  return { text: r.lastActiveAt ? `Quiet · ${exElapsed(r.lastActiveAt)} ago` : r.status === "unknown" ? "Status unknown" : "Ready", kind: "idle" };
}
function exSessionFacts(r) {
  const ctx = ctxInfo(r), model = mchipModelName(r), effort = mchipEffort(r);
  const fact = (label, value, tip = "") => `<div${tip ? ` title="${esc(tip)}"` : ""}><dt>${label}</dt><dd>${esc(value || "Not reported")}</dd></div>`;
  return `<dl class="ex-facts">${fact("Agent", exAgentName(r))}${fact("Model", model)}${fact("Effort", effort)}${fact("Context", ctx ? `${ctx.guessed ? "≈ " : ""}${ctx.tokens.toLocaleString()}${ctx.window ? " / " + ctx.window.toLocaleString() : ""} tokens` : "", ctx?.guessed ? "The context window is estimated; token usage is reported by the agent." : "Tokens currently in context")}${fact("Session age", exElapsed(r.createdAt), "Time since this conversation was created; not continuous running time.")}${fact("Transcript", exByteLabel(r.transcriptBytes), "This session’s transcript on disk, excluding attachments and subagents.")}${fact("Process RAM", r.app || !r.procs ? "Not reported" : exByteLabel(r.rssKB * 1024), "Memory of the session’s process tree; separate from transcript size.")}${r.startedAt && !r.app ? fact("Process uptime", exElapsed(r.startedAt)) : ""}${r.cost != null ? fact("Session cost", usd(r.cost)) : ""}</dl>`;
}
function exLimits(r) {
  const a = accountFor(r, S.usage, S.self), now = Date.now(), state = usageState(a, now);
  if (!a || state === "unknown" || state === "error") return '<div class="ex-limit-note">Account limits · not reported</div>';
  const windows = (a.windows || []).map(w => windowNow(w, now));
  const bars = windows.map(w => {
    const pct = w.pct == null ? null : Math.max(0, Math.min(100, Math.round(w.pct)));
    return `<div class="ex-limit"><span>${esc(w.label)}</span><span class="ex-limit-track" aria-hidden="true"><i style="transform:scaleX(${pct == null ? 0 : pct / 100})"></i></span><b>${pct == null ? w.why === "reset" ? "Awaiting refresh" : "Unknown" : pct + "% used"}</b>${w.resets ? `<small>Resets ${esc(inText(w.resets))}</small>` : ""}</div>`;
  }).join("");
  return `<section class="ex-limits${state === "stale" ? " stale" : ""}" aria-label="Shared account limits"><header>Account limits <span>Shared${state === "stale" ? " · stale reading" : ""}</span></header>${bars || `<p>${a.balance?.left != null ? esc(usd(a.balance.left)) + " credit left" : "Not reported"}</p>`}<button class="link" data-ex-session-action="usage">View account usage</button></section>`;
}
function exSessionDetails(r, detail, story) {
  const note = (label, text) => text ? `<div class="ex-story"><h5>${label}</h5><p>${esc(exPlain(text, 420))}</p></div>` : "";
  const purpose = detail?.brief?.about || r.overview?.purpose || r.firstPrompt;
  const request = r.overview?.request;
  return `<div class="ex-session-details" id="ex-details-${encodeURIComponent(r.key)}" data-ex-panel="details:${esc(r.key)}">${note("What this is about", purpose)}${request && exPlain(request) !== exPlain(purpose) ? note("Latest request", request) : ""}${note(r.status === "working" ? "In progress" : "Last update", story.activity)}${r.overview?.at ? `<div class="ex-source">From the conversation · ${esc(agoText(r.overview.at))}</div>` : ""}${exSessionFacts(r)}${exLimits(r)}${r.branch || r.worktree ? `<div class="ex-checkout">${esc([r.branch, r.worktree ? "Worktree: " + r.worktree : ""].filter(Boolean).join(" · "))}</div>` : ""}<div class="ex-session-path" title="${esc(r.cwd)}">${esc(r.cwd)}</div></div>`;
}
function exNativeHTML(parent, sub, depth) {
  const id = `sub:${parent.key}:${sub.id}`;
  return `<button class="ex-native" role="treeitem" aria-level="${depth + 1}" aria-label="${esc(sub.description || sub.type || "Subagent")}" aria-selected="${S.sel === parent.key && S.sub === sub.id}" tabindex="-1" data-ex-focus="${esc(id)}" data-ex-native="${esc(sub.id)}" data-ex-parent="${esc(parent.key)}"><span class="ex-agent-node${sub.running ? " running" : ""}" aria-hidden="true">${ICON.bot}</span><span class="ex-native-copy"><b>${esc(exPlain(sub.description || sub.type || "Subagent", 150))}</b><small>${esc([exAgentName(parent) + " subagent", sub.model, sub.tools ? sub.tools + " tools" : ""].filter(Boolean).join(" · "))}</small>${sub.running && sub.now ? `<span>${esc(exPlain(sub.now, 120))}</span>` : ""}</span><span class="ex-native-status">${sub.running ? "Working" : "Inactive"}</span></button>`;
}
function exSessionHTML(r, depth, trail = new Set()) {
  if (trail.has(r.key)) return "";
  const nextTrail = new Set([...trail, r.key]);
  const detail = S.details.get(r.key)?.data, story = exSessionStory(r, detail), status = exStatus(r);
  const tree = explorer.sessionTree?.get(r.key), team = exAgentList(r, tree);
  const details = !!exSessionOpen[r.key], teamOpen = !!exTeamOpen[r.key] || !!S.q;
  const nativeLimit = Math.max(4, team.native.filter(s => s.running).length);
  const words = S.q.toLowerCase().split(/\s+/).filter(w => w && !w.startsWith("-") && !w.includes(":"));
  const matching = words.length ? team.native.filter(s => words.every(w => [s.description, s.type, s.model, s.now].join(" ").toLowerCase().includes(w))) : [];
  const nativeShown = matching.length ? matching : exTeamHistory.has(r.key) ? team.native : team.native.slice(0, nativeLimit);
  const ctx = ctxInfo(r), model = mchipModelName(r), effort = mchipEffort(r);
  const spec = [model || exAgentName(r), effort].filter(Boolean).join(" · ");
  const parent = r.parent?.key && rowOf(r.parent.key);
  const origin = r.parent ? `${r.parent.brief ? "#" + r.parent.brief + " · " : ""}Fleet worker${parent && parent.project !== r.project ? " · " + r.project : ""}${!parent ? " · dispatcher unavailable" : ""}` : "";
  const teamSummary = `${team.count} agent${team.count === 1 ? "" : "s"}${team.running ? " · " + team.running + " working" : ""}`;
  const selected = S.sel === r.key && !S.board && !S.mode;
  return `<div class="ex-session-branch" data-ex-session="${esc(r.key)}" style="--depth:${depth}"><div class="row ex-session ex-work${selected ? " sel" : ""}${S.picked.has(r.key) ? " picked" : ""}" role="treeitem" aria-level="${depth + 1}" aria-selected="${selected}"${team.count ? ` aria-expanded="${teamOpen}"${teamOpen ? ` aria-owns="ex-team-${encodeURIComponent(r.key)}"` : ""}` : ""} tabindex="-1" data-key="${esc(r.key)}" data-status="${esc(r.status)}" data-ex-focus="s:${esc(r.key)}"><span class="ex-session-mark" style="--c:${statusVar(r.status)}"><span class="dot"></span></span><div class="ex-session-copy"><div class="ex-session-top"><span class="ex-state" data-status="${status.kind}">${esc(status.text)}</span>${origin ? `<span class="ex-origin" title="${esc(r.parent?.srcName)}">${esc(origin)}</span>` : ""}</div><b>${esc(story.title)}</b>${story.about ? `<p class="ex-purpose">${esc(story.about)}</p>` : ""}<div class="ex-specs"><span title="${esc(exAgentName(r) + " · " + spec)}">${esc(spec)}</span>${ctx?.pct != null ? `<span class="ex-context${ctx.pct >= 85 ? " hot" : ""}" title="${esc(ctx.tokens.toLocaleString() + " tokens in context" + (ctx.guessed ? "; estimated window" : ""))}"><i aria-hidden="true" style="--fill:${ctx.pct / 100}"></i>${ctx.guessed ? "≈" : ""}${Math.round(ctx.pct)}% ctx</span>` : ""}</div><div class="ex-session-controls"><button class="ex-disclose" data-ex-session-action="details" data-ex-key="${esc(r.key)}" aria-expanded="${details}" aria-controls="ex-details-${encodeURIComponent(r.key)}" aria-label="${details ? "Hide" : "Show"} details for ${esc(story.title)}">${ICON.chev}Details${r.createdAt ? `<span>· ${esc(exElapsed(r.createdAt))} old</span>` : ""}</button>${team.count ? `<button class="ex-team-toggle${team.running ? " active" : ""}" data-ex-session-action="team" data-ex-key="${esc(r.key)}" aria-expanded="${teamOpen}" aria-controls="ex-team-${encodeURIComponent(r.key)}">${ICON.bot}${teamSummary}${ICON.chev}</button>` : ""}</div></div></div>${details ? exSessionDetails(r, detail, story) : ""}${team.count && teamOpen ? `<div class="ex-agents" id="ex-team-${encodeURIComponent(r.key)}" role="group" aria-label="Agents for ${esc(story.title)}">${team.workers.map(n => exSessionHTML(n.r, depth + 1, nextTrail)).join("")}${nativeShown.map(s => exNativeHTML(r, s, depth + 1)).join("")}${!S.q && team.native.length > nativeLimit ? `<button class="ex-agent-history" data-ex-session-action="history" data-ex-key="${esc(r.key)}" aria-expanded="${exTeamHistory.has(r.key)}">${exTeamHistory.has(r.key) ? "Show recent agents" : `Show ${team.native.length - nativeLimit} earlier agents`}</button>` : ""}</div>` : ""}</div>`;
}

function exSessionEvent(e) {
  const native = e.target.closest("[data-ex-native]");
  if (native) { e.preventDefault(); e.stopPropagation(); select(native.dataset.exParent, { open: true }); openSub(native.dataset.exNative); return true; }
  const action = e.target.closest("[data-ex-session-action]");
  if (!action) return false;
  e.preventDefault(); e.stopPropagation();
  const key = action.dataset.exKey;
  if (action.dataset.exSessionAction === "usage") { setMode("usage"); return true; }
  if (action.dataset.exSessionAction === "history") { if (exTeamHistory.has(key)) exTeamHistory.delete(key); else exTeamHistory.add(key); renderExplorer(); return true; }
  const map = action.dataset.exSessionAction === "team" ? exTeamOpen : exSessionOpen;
  map[key] = !map[key];
  for (const k of Object.keys(map)) if (!S.rows.has(k)) delete map[k];
  store(action.dataset.exSessionAction === "team" ? "explorerTeams" : "explorerSessionDetails", map);
  renderExplorer();
  return true;
}

function exRefreshReadings() {
  if (S.group === "folders" && S.view !== "closed" && $("rows").querySelector(".ex-session-details")) renderExplorer();
}
