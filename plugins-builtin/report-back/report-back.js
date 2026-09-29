"use strict";
// Report back's page side (server: server.ts beside this file). When a session finishes, its report card: a chip on
// the list row and board card ("Done · 3 files · tests pass"), and in the session view a card above the composer with
// its one-line summary, what changed, the checks it ran and what it's waiting for, until you dismiss it.
S.reports = S.reports ?? new Map();

/** The card for this row's latest finished turn, if it has one (none while it works again). */
function rbOf(r) {
  const rep = S.reports.get(r.key);
  if (!rep || r.status === "working" || r.status === "blocked" || r.hist) return;
  if (r.turnStartedAt && rep.at && r.turnStartedAt > rep.at + 5000) return; // a newer turn has started since
  return rep;
}
function rbVerdict(rep) {
  const last = new Map();
  for (const c of rep.checks ?? []) last.set(c.cmd, c.ok);
  if (last.size) return [...last.values()].every(Boolean) ? "pass" : "fail";
  if (rep.proof?.state === "pass" || rep.proof?.state === "fail") return rep.proof.state;
}
const rbFiles = (rep) => Math.max(rep.fileCount ?? 0, rep.git?.files ?? 0);
function rbChipText(rep) {
  const n = rbFiles(rep), v = rbVerdict(rep);
  return ["Done", n ? `${n} file${n === 1 ? "" : "s"}` : "no file changes", v ? `${rep.checks?.length ? "tests" : "checks"} ${v}` : ""].filter(Boolean).join(" · ");
}
function rbChip(rep) {
  return `<span class="rbchip" data-v="${rbVerdict(rep) ?? ""}" title="${esc(rep.summary)}">${esc(rbChipText(rep))}</span>`;
}

/** "row.chips": the chip on list rows; on board cards the summary line too. */
function rbRowChips(r, where) {
  const rep = rbOf(r);
  if (!rep) return "";
  return where === "board" ? `<div class="rbline">${rbChip(rep)}<span class="rbsum">${esc(rep.summary)}</span></div>` : rbChip(rep);
}

const rbPlural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** "session.bar": the report card above the composer. */
function rbBar(r) {
  const rep = rbOf(r);
  if (!rep || rep.dismissed) return "";
  const v = rbVerdict(rep), ask = pendingAsk(r);
  const facts = [
    rep.fileCount ? `<span title="Files it edited in this turn">${rbPlural(rep.fileCount, "file")} edited</span>` : "",
    rep.git && (rep.git.add || rep.git.del || rep.git.commits) ? `<span class="mono" title="Uncommitted changes, plus commits made during this turn">+${rep.git.add} −${rep.git.del}${rep.git.commits ? ` · ${rbPlural(rep.git.commits, "commit")}` : ""}</span>` : "",
    rep.checks?.length ? `<span class="rbv" data-v="${v}" title="${esc(rep.checks.map((c) => `${c.ok ? "passed" : "failed"}: ${c.cmd}`).join("\n"))}">${v === "pass" ? "tests pass" : "tests fail"} <span class="hint">(${esc(rep.checks[rep.checks.length - 1].cmd)})</span></span>` : "",
    rep.proof ? `<span class="rbv" data-v="${rep.proof.state === "pass" ? "pass" : "fail"}" title="${esc(rep.proof.cmd ?? "")}">proof of done: ${rep.proof.state === "pass" ? "checks pass" : "checks fail"}</span>` : "",
    !rep.fileCount && !rep.git?.files ? `<span>no file changes</span>` : "",
  ].filter(Boolean);
  const files = (rep.files ?? []).slice(0, 4).map((f) => `<a class="fpath rbf" data-path="${esc(f)}" title="${esc(f)}">${esc(f.split("/").pop())}</a>`).join("") + ((rep.files?.length ?? 0) > 4 ? `<span class="hint">+${rep.files.length - 4}</span>` : "");
  const next = ask
    ? `<div class="rbnext"><span>Waiting for you: <b>${esc(plain(ask.question).slice(0, 120))}</b></span><button class="btn" data-rbact="answer">Answer</button></div>`
    : `<div class="rbnext">${rep.reportFile ? `<a class="fpath" data-path="${esc(rep.reportFile)}">REPORT.md</a>${rep.doneMarker ? ` <span class="hint">and DONE</span>` : ""}` : `<span class="hint">${esc(agoText(rep.at))}</span>`}<span class="spacer"></span>${rep.reportFile ? "" : `<button class="btn ghost" data-rbact="ask" title="Sends a short message asking it to write REPORT.md and a DONE marker">Ask for a report</button>`}</div>`;
  return `<div class="rbcard" data-rbkey="${esc(r.key)}" data-rbat="${rep.at}">
    <div class="rbtop">${rbChip(rep)}<b class="rbsum" title="${esc(rep.source === "report-file" ? "From its REPORT.md" : "From its last message")}">${esc(rep.summary)}</b><button class="ib" data-rbact="dismiss" aria-label="Dismiss the report" title="Dismiss">${ICON.x}</button></div>
    ${facts.length || files ? `<div class="rbfacts">${facts.join("")}${files ? `<span class="rbfiles">${files}</span>` : ""}</div>` : ""}${next}${rbWorktree(r)}</div>`;
}

/** A session in a worktree: getting its work back, right on the card (the core's worktree dialogs, diff first). */
function rbWorktree(r) {
  if (!r.worktree) return "";
  return `<div class="rbwt"><span class="rbwt-b" title="Worktree ${esc(r.worktree)}">${ICON.tree}<span class="mono">${esc(r.branch ?? r.worktree)}</span></span><span class="spacer"></span>
    <button class="btn" data-rbact="wt-merge">Merge into ${esc(wtBaseOf(r))}</button><button class="btn ghost" data-rbact="wt-pr">Open PR</button><button class="btn ghost" data-rbact="wt-keep">Keep</button><button class="btn ghost" data-rbact="wt-remove">Remove worktree</button></div>`;
}
async function rbAct(e) {
  const b = e.target.closest("[data-rbact]"), card = b?.closest(".rbcard");
  if (!b || !card) return;
  e.stopPropagation();
  const key = card.dataset.rbkey, act = b.dataset.rbact;
  if (act.startsWith("wt-")) { const r = rowOf(key); if (r) wtOpen(r, act.slice(3)); return; }
  if (act === "answer") { const box = $("askbox"); if (!box.hidden) { box.scrollIntoView({ block: "nearest" }); box.querySelector(".ropt, button")?.focus(); } else setMode("inbox"); return; }
  if (act === "dismiss") {
    const rep = S.reports.get(key);
    if (rep) { S.reports.set(key, { ...rep, dismissed: true }); rbRefresh(); }
    try { await api("/api/report-back", { op: "dismiss", key, at: Number(card.dataset.rbat) }); } catch (x) { toast(x.message, true); }
    return;
  }
  if (act === "ask") {
    b.disabled = true;
    try { await api("/api/tool", { id: "report-back", keys: [key] }); toast("Asked it for a report. It writes REPORT.md and a DONE marker."); }
    catch (x) { b.disabled = false; toast(x.message, true, { label: "Retry", run: () => api("/api/tool", { id: "report-back", keys: [key] }) }); }
  }
}
$("pbar")?.addEventListener("click", rbAct);

function rbRefresh() { render(); renderDetail(); }

const rbReg = deckPlugins.register("report-back", {
  state: (data) => { S.reports = new Map((data.reports ?? []).map((r) => [r.key, r])); },
  events: { "report-back": (d) => { for (const r of d.upsert ?? []) S.reports.set(r.key, r); for (const k of d.remove ?? []) S.reports.delete(k); rbRefresh(); } },
});
rbReg.extend("row.chips", rbRowChips);
rbReg.extend("session.bar", rbBar);
