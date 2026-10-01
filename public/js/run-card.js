"use strict";
// Commands you run ("!" in Claude Code): each shows in the chat as a card in your column, from the moment you
// press Run until its result is in the transcript. While it runs, the card reads the session's screen once a second
// (only while you can see the card) and shows the last lines it printed; once Claude records it, the card shows how
// it went and the whole output. The run itself lives in page memory: `runs` by id, linked to its message once echoed.
const runs = new Map();
const runByMsg = new Map(); // "<session key>:<message index>" → run id
const ranBySrc = new Map(); // "<session key>\n<code block text>" → the newest run started from that block
const rcOpen = new Set(); // cards whose full output is showing
let rcSeq = 0;

/* @pure:run-begin: no globals in here; test/run-card.test.ts evaluates this block on its own. */
/** The command in a "! command" message, or null. */
const bangCmd = (t) => { const m = /^\s*!\s*(\S[\s\S]*)$/.exec(String(t ?? "")); return m ? m[1].trim() : null; };
const stripAnsi = (s) => String(s ?? "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]/g, "").replace(/\r\n/g, "\n").split("\n").map((l) => l.split("\r").pop()).join("\n");
/** 75 s → "1:15"; an hour or more → "1:02:03". */
const clockText = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
/** What a command printed so far, read off the session's screen: the lines under its newest "! command" line, up to
 *  the message box Claude Code draws below (its border), without the "⎿" gutter. `alive`: Claude still says it's
 *  running. */
function screenRunLines(screen, cmd, max = 12) {
  const lines = stripAnsi(screen).split("\n").map((l) => l.replace(/\s+$/, ""));
  const want = String(cmd ?? "").replace(/\s+/g, " ").trim(), head = want.slice(0, 40);
  if (!head) return { found: false, lines: [], alive: false };
  const said = (l) => l.replace(/^[\s>❯›⏺●•]*/, "").replace(/^!\s*/, "").replace(/\s+/g, " ").trim();
  let k = -1;
  for (let j = lines.length - 1; j >= 0; j--) if (/^[\s>❯›⏺●•]*!/.test(lines[j]) && said(lines[j]).startsWith(head)) { k = j; break; }
  if (k < 0) return { found: false, lines: [], alive: false };
  let j = k + 1, got = said(lines[k]).length;
  while (got < want.length && j < lines.length && lines[j].trim() && want.includes(lines[j].trim())) { got += lines[j].trim().length + 1; j++; } // a long command wraps
  const out = [];
  let alive = false, gut = -1;
  for (; j < lines.length; j++) {
    let l = lines[j];
    if (/^\s*([─━═]{3,}|[╭╰┌└][─━]|│)/.test(l)) break; // the message box starts
    const g = /^\s*⎿\s*/.exec(l);
    if (g) { gut = g[0].length; l = l.slice(gut); } // the output's gutter: every line after it is indented as far
    else if (gut > 0) l = l.slice(Math.min(gut, l.match(/^ */)[0].length));
    if (/^\s*Running(…|\.\.\.)/.test(l)) { alive = true; continue; }
    if (/^ {40}/.test(l)) continue; // Claude Code's notices, drawn flush right ("✔ Update installed")
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return { found: true, lines: out.slice(-max), alive };
}
/** Where a run is: sending, queued (Claude was busy: "!" waits for the current step), running, done, failed (the
 *  command failed), sendfail (it never reached the session), lost (stopped watching before the result came), or ran
 *  (a command from before this page, with no result recorded). */
function runPhase({ run, shell, pending }) {
  if (shell) return shell.state === "error" ? "failed" : "done";
  if (!run) return pending ? "sending" : "ran";
  if (run.state === "sending") return "sending";
  if (run.state === "sendfail") return "sendfail";
  if (run.stopped) return "lost";
  if (run.queued && !run.live.length) return "queued";
  return "running";
}
/** Why to stop watching a run's screen, or null to go on: its result is in, 10 minutes passed, or the session has
 *  been quiet (not working, nothing new on screen) for 5 s. */
function runStop(run, { now, status, shell }) {
  if (shell) return "done";
  if (now - run.at > 600_000) return "timeout";
  if (status === "working" || status === "blocked") { run.busyAt = now; return null; }
  return now - Math.max(run.busyAt ?? 0, run.sentAt ?? run.at, run.liveAt ?? 0) > 5000 ? "idle" : null;
}
/* @pure:run-end */

const rcShell = (run) => (run?.i != null ? chatOf(chatId(run.key)).msgs.get(run.i)?.shell : undefined);
const rcTime = (t) => (t ? TF.format(new Date(t)) : "");
/** A "! command" you sent from the message box is a run too (the composer handles a failed send). */
function rcAdopt(p, key) {
  const r = rowOf(key);
  if (p.run || !r || r.agent !== "claude" || r.app) return runs.get(p.run);
  const run = { id: "r" + ++rcSeq, key, machine: r.machine, cmd: bangCmd(p.text), at: p.at, sentAt: p.at, state: "sent", queued: r.status === "working", live: [] };
  runs.set(run.id, run); p.run = run.id;
  return run;
}
function runCardHTML(b, key) {
  const m = b.ms[0], pending = b.kind === "pending";
  const run = pending ? rcAdopt(m, key) : runs.get(runByMsg.get(key + ":" + m.i));
  return `<div class="msg user runcard"${run ? ` data-run="${run.id}"` : ""}>${MSG_TOOLS}${runCardInner(run, pending ? null : m, key)}</div>`;
}
const RC_ICON = {
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  failed: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  queued: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/></svg>',
  lost: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 11h0"/></svg>',
};
function runCardInner(run, m, key) {
  const shell = m?.shell ?? rcShell(run);
  const ph = runPhase({ run, shell, pending: !m });
  const cmd = run?.cmd ?? bangCmd(m?.text) ?? "";
  const r = rowOf(key);
  const where = esc(machineLabel(run?.machine ?? r?.machine) || "this machine");
  const at = run?.at ?? m?.at;
  const n = shell?.lines ?? 0;
  const st = {
    sending: `<span class="spin"></span><span>Sending to ${esc(r?.title || "the session")}…</span>`,
    queued: `${RC_ICON.queued}<span>Queued, runs after the current step · on ${where} · sent ${rcTime(at)}</span>`,
    running: `<span class="spin"></span><span>Running on ${where} · started ${rcTime(at)} · <b class="rc-el" data-since="${at}">${clockText(Date.now() - at)}</b></span>`,
    done: `${RC_ICON.done}<span><b>Done</b> · ${rcTime(at)}${n ? ` · ${n} line${n === 1 ? "" : "s"}` : " · no output"}</span>`,
    failed: `${RC_ICON.failed}<span><b>Failed</b> · ${rcTime(at)}${n ? ` · ${n} line${n === 1 ? "" : "s"}` : " · no output"}</span>`,
    sendfail: `${RC_ICON.failed}<span><b>Not sent</b> · ${esc(run?.err ?? "the session didn’t take it")}</span>`,
    lost: `${RC_ICON.lost}<span>${run?.stopped === "timeout" ? "No result after 10 minutes. Check the terminal." : "Stopped watching the screen. The result shows here once Claude records it."}</span>`,
    ran: `<span>Ran ${esc(when(at))}</span>`,
  }[ph];
  let out = "";
  if (shell && n) {
    const open = rcOpen.has(run?.id ?? `${key}:${m?.i}`), more = n > 6 || shell.clipped;
    out = `<pre class="rc-out${more && !open ? " clamp" : ""}">${esc(shell.out)}</pre><div class="rc-ft">${more ? `<button type="button" class="rc-lnk" data-rcall>${open ? "Show less" : shell.clipped ? `Show the last ${shell.out.split("\n").length} of ${n} lines` : `Show all ${n} lines`}</button>` : ""}<button type="button" class="rc-lnk" data-rccopy>Copy output</button></div>`;
  } else if (run?.live.length && !shell) out = `<pre class="rc-out live">${esc(run.live.join("\n"))}</pre>`;
  const acts = ph === "sendfail" ? `<div class="rc-ft"><button type="button" class="btn sm primary" data-rcretry>Retry</button><button type="button" class="btn sm ghost" data-rcdrop>Remove</button></div>` : "";
  return `<div class="rc-box ${ph}"><div class="rc-cmd"><span class="rc-p" aria-hidden="true">!</span><code>${esc(cmd)}</code></div><div class="rc-st ${ph}" role="status">${st}</div>${out}${acts}</div>`;
}
/** Redraw one card in place (its element stays, so the chat's own bookkeeping is untouched). */
function rcPaint(run) {
  const el = run && $("dbody").querySelector(`.runcard[data-run="${run.id}"]`);
  if (el) {
    const m = run.i != null ? chatOf(chatId(run.key)).msgs.get(run.i) : null;
    rcSwap(el, MSG_TOOLS + runCardInner(run, m, run.key));
  }
  decorateRunButtons();
}

/** Only the parts that changed are replaced, so the spinner keeps turning (the clock is ticked on its own). */
function rcSwap(el, html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  rcMerge(el, [...t.content.children]);
}
function rcMerge(el, next) {
  const same = (a, b) => a.outerHTML.replace(/data-since="\d+">[^<]*/, "") === b.outerHTML.replace(/data-since="\d+">[^<]*/, "");
  if (next.length !== el.children.length) return el.replaceChildren(...next);
  next.forEach((n, i) => {
    const o = el.children[i];
    if (same(o, n)) return;
    if (o.classList.contains("rc-box") && n.classList.contains("rc-box")) { o.className = n.className; rcMerge(o, [...n.children]); }
    else o.replaceWith(n);
  });
}
/** Run a command in a session: the card first, then the send. `src` is the code block it came from. */
function runCommand(r, cmd, src) {
  const text = cmd.trim().startsWith("!") ? cmd.trim() : `! ${cmd.trim()}`;
  const run = { id: "r" + ++rcSeq, key: r.key, machine: r.machine, cmd: bangCmd(text), at: Date.now(), state: "sending", queued: r.status === "working", live: [] };
  runs.set(run.id, run);
  if (src) ranBySrc.set(r.key + "\n" + sendWords(src), run.id);
  const p = addPending(r.key, text);
  p.run = run.id;
  if (S.sel === r.key && !S.sub) { renderChat(); toBottom(true); }
  return sendRun(run);
}
async function sendRun(run) {
  try {
    await api("/api/send", { key: run.key, text: "! " + run.cmd });
    Object.assign(run, { state: "sent", sentAt: Date.now(), err: undefined, stopped: undefined });
    if (S.sel === run.key) setTimeout(() => chatTick(true), 250);
  } catch (err) {
    Object.assign(run, { state: "sendfail", err: err.message });
    toast("Couldn’t run it: " + err.message, true, { label: "Retry", run: () => retryRun(run) });
  }
  rcPaint(run);
  rcTick();
}
function retryRun(run) {
  if (run.state !== "sendfail") return;
  Object.assign(run, { state: "sending", at: Date.now(), live: [], queued: rowOf(run.key)?.status === "working" });
  const p = chatOf(chatId(run.key)).pending.find((x) => x.run === run.id);
  if (p) p.at = run.at;
  rcPaint(run);
  return sendRun(run);
}
/** The transcript has the command: the card is now that message's. */
function runEchoed(id, key, i) {
  const run = runs.get(id);
  if (!run) return;
  run.i = i;
  runByMsg.set(key + ":" + i, id);
}

// ── watching: the elapsed time, and the screen of the run you can see ──
const rcSeen = new Set();
const rcObs = new IntersectionObserver((es) => { for (const e of es) { const id = e.target.dataset.run; if (e.isIntersecting) rcSeen.add(id); else rcSeen.delete(id); } if (es.some((e) => e.isIntersecting)) rcTick(); }, { root: $("dbody") });
let rcTimer = null, rcBusy = false;
const rcWatching = (run) => (run.state === "sending" || run.state === "sent") && !run.stopped && !rcShell(run);
async function rcTick() {
  clearTimeout(rcTimer);
  const now = Date.now();
  const live = [...runs.values()].filter(rcWatching);
  if (!live.length) return;
  for (const el of $("dbody").querySelectorAll(".runcard [data-since]")) el.textContent = clockText(now - Number(el.dataset.since));
  for (const run of live) {
    if (run.state !== "sent") continue;
    const why = runStop(run, { now, status: rowOf(run.key)?.status, shell: rcShell(run) });
    if (why) { run.stopped = why === "done" ? undefined : why; rcPaint(run); }
  }
  const seen = live.find((run) => run.state === "sent" && !run.stopped && run.key === S.sel && !S.sub && rcSeen.has(run.id));
  if (seen && !rcBusy && !document.hidden && chatOn()) {
    rcBusy = true;
    try {
      const res = await api("/api/read", { key: seen.key, lines: 120 });
      const got = screenRunLines(res.text ?? "", seen.cmd);
      if (got.alive) seen.liveAt = Date.now();
      const started = seen.queued && (got.alive || got.lines.length); // Claude has taken it: its "Running…" or output
      if (started || got.lines.join("\n") !== seen.live.join("\n")) {
        Object.assign(seen, { live: got.lines, liveAt: Date.now() });
        if (started) seen.queued = false;
        if (rcWatching(seen)) rcPaint(seen);
      }
    } catch {}
    rcBusy = false;
  }
  if ([...runs.values()].some(rcWatching)) rcTimer = setTimeout(rcTick, 1000);
}

// ── the code block a run came from: "Ran 10:43 ✓ · Run again" ──
function decorateRunButtons() {
  for (const btn of $("dbody").querySelectorAll(".cb [data-cbrun]")) {
    const cb = btn.closest(".cb");
    const run = runs.get(ranBySrc.get(S.sel + "\n" + sendWords(cb.querySelector("code")?.textContent ?? "")));
    let lab = cb.querySelector("[data-cbran]");
    cb.classList.toggle("ran", !!run);
    if (!run) { lab?.remove(); if (btn.textContent !== "Run") btn.textContent = "Run"; continue; }
    const ph = runPhase({ run, shell: rcShell(run) });
    if (!lab) { lab = document.createElement("button"); lab.type = "button"; lab.dataset.cbran = ""; lab.title = "Show this run in the chat"; btn.before(lab); }
    lab.dataset.cbran = run.id;
    lab.className = "cbran " + ph;
    lab.textContent = `Ran ${rcTime(run.at)} ${ph === "done" ? "✓" : ph === "failed" || ph === "sendfail" ? "✕" : "…"}`;
    btn.textContent = "Run again";
  }
}
const renderChatBeforeRuns = renderChat;
renderChat = function (...a) {
  const out = renderChatBeforeRuns.apply(this, a);
  if (chatDom.el) for (const el of chatDom.el.querySelectorAll(".runcard[data-run]")) rcObs.observe(el);
  decorateRunButtons();
  if ([...runs.values()].some(rcWatching)) { clearTimeout(rcTimer); rcTimer = setTimeout(rcTick, 300); }
  return out;
};
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-cbran], [data-rcall], [data-rccopy], [data-rcretry], [data-rcdrop]");
  if (!t || !$("dbody").contains(t)) return;
  e.preventDefault(); e.stopPropagation();
  if (t.matches("[data-cbran]")) {
    const el = $("dbody").querySelector(`.runcard[data-run="${t.dataset.cbran}"]`);
    if (!el) return toast("That run isn’t in this chat any more");
    el.scrollIntoView({ block: "center", behavior: motion.reduced?.() ? "auto" : "smooth" });
    el.classList.remove("hl"); void el.offsetWidth; el.classList.add("hl");
    return;
  }
  const card = t.closest(".runcard"), blk = chatDom.data?.find((b) => b.key === t.closest("[data-b]")?.dataset.b);
  const run = runs.get(card?.dataset.run), m = blk?.ms[0];
  if (t.matches("[data-rcretry]")) return run && retryRun(run);
  if (t.matches("[data-rcdrop]")) { const p = chatOf(chatId(run.key)).pending.find((x) => x.run === run.id); runs.delete(run.id); if (p) dropPending(run.key, p); return decorateRunButtons(); }
  const shell = m?.shell ?? rcShell(run);
  if (t.matches("[data-rccopy]")) return shell && copy(shell.out, "output");
  const id = run?.id ?? `${S.sel}:${m?.i}`;
  if (rcOpen.has(id)) rcOpen.delete(id); else rcOpen.add(id);
  rcSwap(card, MSG_TOOLS + runCardInner(run, blk?.kind === "pending" ? null : m, S.sel));
}, true);
