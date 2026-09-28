"use strict";
// Inbox: decision cards, the triage keys and Jev's panel.
S.inboxFilter = load("inboxFilter", "all");
const KIND = { prompt: ["Needs permission", "blocked"], question: ["Asks you", "done"], review: ["Says it’s done", "working"] };
function checkChip(c, project) {
  const m = checkInfo(c, project);
  return m ? `<button class="chk ${m.cls}" data-dact="check" title="${esc(m.tip)}${c.at ? ` · ${esc(agoText(c.at))}` : ""}">${m.cls === "ask" ? ICON.check : ""}${esc(m.label)}</button>` : "";
}
function jevLine(d) {
  const j = d.jev;
  if (!j || j.state === "skipped") return "";
  if (j.state === "pending") return `<div class="jev pending"><span class="spin"></span> Jev is looking…</div>`;
  if (d.kind === "review" && j.done != null) {
    const p = Math.round(j.done * 100);
    const cls = p >= 70 ? "ok" : p >= 40 ? "mid" : "bad";
    return `<div class="jev ${cls}"><span class="jb">Jev</span> ${p}% really done${j.next ? ` · suggests <b>${j.next === "accept" ? "accept" : j.next === "send_back" ? "send it back" : "ask a question"}</b>` : ""}</div>`;
  }
  if (j.pick != null) return `<div class="jev"><span class="jb">Jev</span> would pick <b>${esc(String(j.pick).toUpperCase())}</b>${j.pickP != null ? ` (${Math.round(j.pickP * 100)}%)` : ""}${j.low != null ? ` · ${j.low >= 0.7 ? "low stakes" : j.low < 0.35 ? "<b>high stakes</b>" : "medium stakes"}` : ""}${riskChip(j)}</div>`;
  return "";
}
/** How reversible Jev thinks the terminal prompt is, as a small chip (deck-prompt only; nothing when the risk feature is off or Jev skipped). */
function riskChip(j) {
  if (j.risk == null) return "";
  if (j.riskP != null && j.riskP < 0.5) return ` <span class="risk unclear">risk unclear</span>`;
  const label = j.risk === "read_only" ? "read-only" : j.risk === "reversible" ? "reversible" : "irreversible";
  return ` <span class="risk${j.risk === "irreversible" ? " irr" : ""}">${esc(label)}</span>`;
}
// <inbox-keys> Pure: what a triage key means on a decision. No DOM, no globals (test/inbox-keys.test.ts runs this block).
const YES_RE = /^\W*(yes|y|allow|approve|accept|ok|okay|confirm|proceed|continue|go ahead|trust|sure)\b/i;
const NO_RE = /^\W*(no|n|deny|reject|decline|cancel|don['’]?t|do not|exit|abort|stop)\b/i;
/** The option `y` (want "yes") or `n` (want "no") answers with: the first yes-/no-worded option; for yes, else the recommended one. */
function yesNoOption(d, want) {
  const opts = d?.options ?? [];
  const re = want === "yes" ? YES_RE : NO_RE;
  return opts.find((o) => re.test(String(o.title ?? ""))) ?? (want === "yes" ? opts.find((o) => o.rec) : undefined);
}
/** { opt } answers with an option, { act } runs a card action, { miss } explains why the key does nothing here, null: not a card key. */
function inboxKey(d, k) {
  if (!d) return null;
  const n = d.options?.length ?? 0;
  if (/^[1-9]$/.test(k)) { const o = d.options?.[Number(k) - 1]; return o ? { opt: o } : { miss: n ? `This one has ${n} option${n === 1 ? "" : "s"}` : "No options here: y, n, v or r" }; }
  if (k === "y" || k === "n") {
    if (d.kind === "review") return { act: k === "y" ? "accept" : "sendback" };
    const o = yesNoOption(d, k === "y" ? "yes" : "no");
    return o ? { opt: o } : { miss: `No clear ${k === "y" ? "yes" : "no"} option here: pick with 1–${Math.min(n, 9)}` };
  }
  if (k === "v") return d.kind === "review" ? { act: "verify" } : { miss: "Verify is for finished work" };
  if (k === "r") return { act: "reply" };
  if (k === "o" || k === "Enter") return { act: "open" };
  if (k === "s" || k === "x") return { act: "skip" };
  return null;
}
// </inbox-keys>
const kh = (k) => `<kbd class="kh" aria-hidden="true">${k}</kbd>`;
function decisionCard(d) {
  const r = rowOf(d.key);
  if (!r) return "";
  const [kindLabel, kindVar] = d.kind === "review" && !d.claim ? ["Finished", "idle"] : KIND[d.kind];
  const pick = d.jev?.pick;
  const yes = yesNoOption(d, "yes"), no = yesNoOption(d, "no");
  // The badge is the key that picks it (1–9); an agent's own letter stays visible beside the title.
  const opts = d.options.map((o, i) => `<button class="dopt${o.rec ? " rec" : ""}${o === yes ? " isyes" : ""}${pick === o.id ? " jevpick" : ""}" data-dopt="${esc(o.id)}"><span class="ol">${i < 9 ? i + 1 : esc(String(o.id).toUpperCase())}</span><span class="ob"><span class="ot">${/^[a-h]$/i.test(o.id) ? `<span class="oid">${esc(o.id.toUpperCase())}</span>` : ""}${inline(o.title)}${o.rec ? '<span class="rp">Recommended</span>' : ""}${pick === o.id ? '<span class="rp jevp">Jev</span>' : ""}</span>${o.detail ? `<span class="od">${inline(o.detail)}</span>` : ""}</span>${o === yes ? kh("y") : o === no ? kh("n") : ""}</button>`).join("");
  const c = r.check;
  const check = d.kind === "review" ? (c?.state === "needs-approval"
    ? `<div class="dcheck ask">The deck can re-run this project’s checks to prove it: <code>${esc(c.cmd)}</code><span class="spacer"></span><button class="btn primary" data-dcheck="allow">Allow for ${esc(r.project)}</button><button class="btn" data-dcheck="edit">Edit…</button><button class="btn ghost" data-dcheck="never">Never</button></div>`
    : c && c.state !== "skipped" ? `<div class="dcheck ${c.state}">${c.state === "pass" ? "✓" : c.state === "fail" ? "✗" : '<span class="spin"></span>'} <code>${esc(c.cmd ?? "")}</code> ${c.state === "pass" ? `passed${c.ms ? ` in ${Math.round(c.ms / 1000)}s` : ""}` : c.state === "fail" ? `failed (exit ${c.exit})` : c.state}${c.at && (c.state === "pass" || c.state === "fail") ? ` · ${esc(agoText(c.at))}` : ""}${c.tail?.length && c.state === "fail" ? `<details><summary>Output</summary><pre>${esc(c.tail.slice(-25).join("\n"))}</pre></details>` : ""}</div>` : "") : "";
  const acts = d.kind === "review"
    ? `<button class="btn primary" data-dact2="accept">${ICON.check}Looks good${kh("y")}</button><button class="btn" data-dact2="sendback">Send back…${kh("n")}</button><button class="btn" data-dact2="verify">Verify now${kh("v")}</button><button class="btn ghost" data-dact2="reply">Reply…${kh("r")}</button>`
    : `<button class="btn ghost" data-dact2="reply">Something else…${kh("r")}</button>${d.kind === "prompt" ? `<button class="btn ghost" data-dact2="term">Show terminal</button>` : ""}`;
  return `<article class="dcard" data-dkey="${esc(d.key)}" data-kind="${d.kind}" style="--pc:${pc(r.project)};--kc:var(--${kindVar})">
    <header><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span><span class="dk">${kindLabel}</span>${multiMachine() ? `<span class="hint">${esc(machineLabel(r.machine))}</span>` : ""}<span class="dhr"><span class="hint" data-t="${d.at}">${esc(agoText(d.at))}</span><button class="dskip" data-dact2="skip" title="Hide it for now without answering (s)">Skip${kh("s")}</button><button class="ib" data-dact2="open" title="Open the session (o)">${ICON.jump}</button></span></header>
    <div class="dtitle">${esc(r.title)} <span class="hint">${paneTag(r)}</span></div>
    <div class="dq">${inline(d.question)}</div>
    ${d.context && d.kind !== "prompt" ? `<details class="dctx"><summary>Context</summary><div class="md">${md(d.context)}</div></details>` : d.kind === "prompt" ? `<pre class="dterm">${ansi((r.tail ?? []).slice(-6).join("\n"))}</pre>` : ""}
    ${jevLine(d)}
    ${opts ? `<div class="dopts">${opts}</div>` : ""}
    ${check}
    <div class="dacts">${acts}</div>
    <form class="dreply" hidden><textarea rows="2" placeholder="Reply to the agent"></textarea><button class="btn primary">Send</button></form>
  </article>`;
}
// Jev panel: what the suggestions cost and how often they matched what you did (from ~/.jev receipts).
S.jevOpen = load("jevOpen", false);
let jevLoading = 0;
async function loadJevStats(force) {
  if (!force && Date.now() - jevLoading < 4000) return;
  jevLoading = Date.now();
  try { S.jevStats = await api("/api/jev/stats", {}); S.jevErr = null; } catch (e) { S.jevErr = e.message; }
  if (S.mode === "inbox") renderInbox();
}
const money = (n) => (n == null ? "–" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const ktok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n ?? 0));
const pctOf = (r) => (r == null ? "–" : `${Math.round(r * 100)}%`);
function jevBar(j) {
  const label = j.available ? `Jev · ${j.calls ?? 0}/${j.cap ?? "–"} today` : "Jev is off on this machine";
  return `<div class="jevbar"><button class="jevtog" data-jevtog aria-expanded="${!!S.jevOpen}"><span class="jb">Jev</span>${esc(label.replace(/^Jev · /, ""))}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button></div>${S.jevOpen ? jevPanel(S.jevStats, j) : ""}`;
}
// What each Jev feature sends, so you can switch off any of them.
const JEV_FEATS = [
  ["risk", "Risk level on permission prompts", "adds one question to the prompt check it already sends"],
  ["radar", "Stuck radar", "sends the last tool calls of a running session when it looks stuck"],
  ["route", "Send by description", "sends your message and your sessions' titles and what each is doing when you ask it to route"],
];
function jevPanel(st, j) {
  if (!st) return `<section class="jevp"><p class="hint">${S.jevErr ? esc(S.jevErr) : "Reading the receipts…"}</p></section>`;
  const span = (t, x) => `<div class="jst"><span class="jl">${t}</span><b>${x.calls}</b><span>call${x.calls === 1 ? "" : "s"}</span><span class="jm">${ktok(x.inputTokens)} tok · ${money(x.cost)}</span>${x.repeats ? `<span class="jm jwarn" title="Asked again with the exact same state (before the dedupe fix)">${x.repeats} repeat${x.repeats === 1 ? "" : "s"}</span>` : ""}</div>`;
  const KN = { prompt: "Permissions", question: "Questions", done: "Done?" };
  const hitRow = (k) => { const h = st.hit[k]; return `<div class="jhr"><span>${KN[k]}</span><span class="jbarv"><i style="width:${h.n ? Math.round((h.hits / h.n) * 100) : 0}%"></i></span><b>${h.n ? pctOf(h.rate) : "–"}</b><span class="jm">${h.hits}/${h.n}</span></div>`; };
  const cal = (rows, verb) => rows.map((b) => `<span class="jcal"><b>${esc(b.band)}</b> ${b.n ? `${verb} ${b.accepted ?? b.hits}/${b.n}` : "none yet"}</span>`).join("");
  const KS = { prompt: "Permission", question: "Question", done: "Done?" };
  const recent = st.recent.length ? st.recent.map((x) => {
    const mark = x.followed == null ? `<span class="jno"></span>` : x.followed ? `<span class="jok" title="You did what Jev suggested">✓</span>` : `<span class="jx" title="You did something else">✗</span>`;
    const rep = x.repeats ? ` <span class="jwarn" title="Asked ${x.repeats + 1} times with the same state (before the dedupe fix)">×${x.repeats + 1}</span>` : "";
    return `<li><span class="jt" data-t="${x.at}">${esc(agoText(x.at))}</span><span class="jk">${KS[x.kind]}${rep}</span><span class="jq">${x.label ? esc(x.label) : `<span class="hint">–</span>`}</span><span class="js">Jev <b>${esc(x.suggestion)}</b>${x.pickTitle ? ` <span class="hint">${esc(x.pickTitle)}</span>` : ""}</span><span class="ja">${x.actual ? `You <b>${esc(x.actual)}</b>${x.actualTitle ? ` <span class="hint">${esc(x.actualTitle)}</span>` : ""}` : `<span class="hint">no answer recorded</span>`}</span>${mark}</li>`;
  }).join("") : `<li class="hint">No deck decisions in the receipts yet.</li>`;
  const cap = st.cap;
  const feats = JEV_FEATS.map(([k, title, sends]) => `<label class="nchk"><input type="checkbox" data-jevfeat="${k}" ${j.features?.[k] !== false ? "checked" : ""}><span><b>${title}</b>${st.features ? ` <span class="hint">${st.features[k] ?? 0} today</span>` : ""}<small>${sends}</small></span></label>`).join("");
  return `<section class="jevp" aria-label="Jev">
    <div class="jgrid">${span("Today", st.today)}${span("7 days", st.week)}${span("All time", st.total)}</div>
    <div class="jcols">
      <div><h4>Matched what you did <span class="hint">${st.hit.all.n ? `${pctOf(st.hit.all.rate)} of ${st.hit.all.n}` : ""}</span></h4>${["prompt", "question", "done"].map(hitRow).join("")}</div>
      <div><h4>Calibration</h4><div class="jcr"><span class="jl">“Done” said</span>${cal(st.calibration.done, "accepted")}</div><div class="jcr"><span class="jl">Pick confidence</span>${cal(st.calibration.pick, "right")}</div></div>
    </div>
    <h4>Last ${st.recent.length} decisions</h4>
    <ul class="jrec">${recent}</ul>
    <form class="jcap"><label>Daily cap <input type="number" min="0" max="100000" step="1" value="${cap.cap}" inputmode="numeric" aria-label="Jev calls per day"></label><button class="btn">Save</button><span class="hint">${cap.used} used today · at the cap ≈ ${money(cap.cap * 1200 * st.price.perMillionInput / 1e6)}/day${cap.source === "env" ? " · from DECK_JEV_DAILY until you save" : ""}</span></form>
    <div class="jfeat">${feats}</div>
    <p class="hint jfoot">${st.asked} decisions asked, ${st.answered} answered in the deck. All Jev use today: ${st.allAgentsToday.calls} calls, ${money(st.allAgentsToday.cost)}. $${st.price.perMillionInput} per million input tokens, output free.</p>
  </section>`;
}
// Keyboard triage: a focus ring over the cards (S.ifocus), skips that hide a card until it changes or you undo.
const IFILTERS = [["all", "All"], ["quick", "Quick ones"], ["prompt", "Permissions"], ["question", "Questions"], ["review", "Done?"]];
S.skipped = new Map(); // key → the decision's signature when skipped; it comes back when the decision changes
S.skipStack = [];
S.ifocus = null; S.ifocusIdx = 0;
const dsig = (d) => d.id ?? `${d.kind}|${d.at}|${d.question}`; // what was skipped: that decision, not the session
const isSkipped = (d) => S.skipped.get(d.key) === dsig(d);
const KEYHINTS = [[["j", "k"], "move"], [["1–9"], "pick"], [["y", "n"], "yes / no"], [["v"], "verify"], [["r"], "reply"], [["o"], "open"], [["s"], "skip"], [["u"], "undo skip"], [["f"], "filter"], [["Esc"], "back"]];
