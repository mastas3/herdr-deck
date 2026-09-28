"use strict";
// Inbox: rendering, keyboard triage, skipping and answering decisions.
function renderInbox() {
  const box = $("dbody");
  // A reply being written survives the re-render that any decision change triggers.
  const drafts = box._mode === "inbox" ? [...box.querySelectorAll(".dcard .dreply:not([hidden])")].map((f) => { const ta = f.querySelector("textarea"); return { key: f.closest(".dcard").dataset.dkey, text: ta.value, action: f.dataset.action, focus: document.activeElement === ta, a: ta.selectionStart, b: ta.selectionEnd }; }) : [];
  const waiting = (S.decisions ?? []).filter((d) => rowOf(d.key) && !S.done.has(d.key));
  for (const k of [...S.skipped.keys()]) if (!waiting.some((d) => d.key === k && isSkipped(d))) S.skipped.delete(k);
  const all = waiting.filter((d) => !isSkipped(d)).sort((a, b) => ({ prompt: 0, question: 1, review: 2 })[a.kind] - ({ prompt: 0, question: 1, review: 2 })[b.kind] || b.at - a.at);
  const quick = (d) => d.jev?.low >= 0.7 || (d.kind === "review" && (d.jev?.done ?? 0) >= 0.7);
  const f = S.inboxFilter;
  const list = all.filter((d) => f === "all" || (f === "quick" ? quick(d) : d.kind === f));
  const count = (k) => all.filter((d) => (k === "quick" ? quick(d) : d.kind === k)).length;
  const chips = IFILTERS.map(([k, l]) => [k, l, k === "all" ? all.length : count(k)])
    .map(([k, l, n]) => `<button class="chip" data-ifilter="${k}" aria-pressed="${f === k}">${l}${n ? ` <b>${n}</b>` : ""}</button>`).join("") + (isPhone() ? "" : `<span class="chipkey">${kh("f")} cycles</span>`);
  const j = S.jev ?? {};
  const nSkip = S.skipped.size;
  const skipped = nSkip ? ` <button class="iunskip" data-iunskip title="Show the skipped ones again">${nSkip} skipped · show</button>` : "";
  const hints = isPhone() ? "" : `<div class="khint" aria-label="Keyboard">${KEYHINTS.map(([ks, t]) => `<span>${ks.map((k) => `<kbd>${k}</kbd>`).join("")} ${t}</span>`).join("")}</div>`;
  modeHTML(`<header class="vh"><h2>${ICON.inbox}Decisions</h2><p>${all.length ? `${all.length} waiting on you. Answer here; it goes straight to the agent.` : "Nothing is waiting on you."}${skipped}</p>${jevBar(j)}${hints}<div class="chips">${chips}</div></header>
    ${list.length ? `<div class="dlist">${list.map(decisionCard).join("")}</div>` : `<div class="empty-v"><p>${all.length ? "None in this filter." : nSkip ? "Only skipped ones left." : "All clear. When an agent asks something, needs permission, or says it’s done, it shows up here."}</p></div>`}`);
  for (const x of drafts) {
    const form = box.querySelector(`.dcard[data-dkey="${CSS.escape(x.key)}"] .dreply`);
    if (!form || !form.hidden) continue;
    const ta = form.querySelector("textarea");
    form.hidden = false; form.dataset.action = x.action ?? ""; ta.value = x.text; autosize(ta);
    if (x.focus) { ta.focus(); ta.setSelectionRange(x.a, x.b); }
  }
  applyInboxFocus(false);
}
const inboxCards = () => [...$("dbody").querySelectorAll(".dcard:not(.leaving)")];
const cardOf = (key) => document.querySelector(`#dbody .dcard[data-dkey="${CSS.escape(key)}"]`);
/** Put the focus ring on S.ifocus, or on the card now at its old place (the next one) when it's gone. */
function applyInboxFocus(scroll) {
  const cards = inboxCards();
  const el = cards.find((c) => c.dataset.dkey === S.ifocus) ?? cards[Math.min(S.ifocusIdx, cards.length - 1)];
  for (const c of $("dbody").querySelectorAll(".dcard.kfocus")) if (c !== el) c.classList.remove("kfocus");
  if (!el) { S.ifocus = null; return; }
  S.ifocus = el.dataset.dkey; S.ifocusIdx = cards.indexOf(el);
  if (!isPhone()) el.classList.add("kfocus");
  if (scroll) el.scrollIntoView({ block: el.offsetHeight > $("dbody").clientHeight - 24 ? "start" : "nearest", behavior: "smooth" });
}
function moveInboxFocus(delta) {
  const cards = inboxCards();
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.dataset.dkey === S.ifocus);
  S.ifocus = cards[i < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, i + delta))].dataset.dkey;
  applyInboxFocus(true);
}
/** The answered or skipped card is leaving: the ring goes to the one after it (or before, at the end). */
function focusPast(key) {
  const cards = inboxCards(), i = cards.findIndex((c) => c.dataset.dkey === key);
  if (i < 0 || S.ifocus !== key) return;
  S.ifocus = (cards[i + 1] ?? cards[i - 1])?.dataset.dkey ?? null;
  S.ifocusIdx = i;
}
function nextHint() {
  const d = S.ifocus && (S.decisions ?? []).find((x) => x.key === S.ifocus);
  if (!d) return "All clear · Esc to go back";
  if (d.kind === "review") return "Next: y looks good · n send back · v verify · s skip";
  const n = Math.min(d.options.length, 9);
  return `Next: ${yesNoOption(d, "yes") ? "y / n · " : ""}${n ? `1–${n} pick · ` : ""}r reply · s skip`;
}
function triageToast(msg) {
  const t = toast(msg);
  if (t && !isPhone()) { const h = document.createElement("span"); h.className = "tnext"; h.textContent = nextHint(); t.append(h); }
}
async function decide(key, action, fn, choice, sent) {
  const card = cardOf(key);
  if (card?.classList.contains("leaving")) return;
  focusPast(key);
  card?.classList.add("leaving");
  applyInboxFocus(true);
  try {
    await fn();
    S.done.set(key, Date.now());
    api("/api/decide", { key, action, choice }).catch(() => {});
    if (action !== "verify") api("/api/seen", { key }).catch(() => {});
    if (sent) triageToast(sent);
    setTimeout(() => { renderInbox(); renderViews(); if (S.mode === "inbox") applyInboxFocus(true); }, 180); // the answered card is gone: keep the next one in view
  } catch (e) { card?.classList.remove("leaving"); S.ifocus = key; applyInboxFocus(true); toast(e.message, true); }
}
setInterval(() => { for (const [k, t] of S.done) if (Date.now() - t > 20_000) S.done.delete(k); }, 5000);
/** Answer with one of the card's options: the digit or cursor keys for a terminal prompt, the option's text for a question. */
function inboxPick(key, o) {
  const d = (S.decisions ?? []).find((x) => x.key === key), r = rowOf(key);
  if (!d || !r) return;
  const sent = `Sent “${plain(o.title).slice(0, 60)}” to ${r.project}`;
  if (d.kind === "prompt") return decide(key, "answer", () => api("/api/keys", { key, keys: o.keys ?? [String(o.id)] }), String(o.id), sent);
  return decide(key, "answer", () => api("/api/send", { key, text: o.send ?? o.title }), String(o.id), sent);
}
function inboxAct(key, act) {
  const card = cardOf(key), r = rowOf(key);
  if (!card || !r) return;
  if (act === "open") return select(key, { scroll: true, open: true });
  if (act === "term") { select(key, { open: true }); return showTerminal(); }
  if (act === "skip") return skipDecision(key);
  if (act === "accept") return decide(key, "accept", async () => {}, undefined, `Looks good: ${r.project} accepted`);
  if (act === "verify") return verifyRow(r, true);
  if (act === "sendback" || act === "reply") {
    const form = card.querySelector(".dreply");
    form.hidden = false;
    const ta = form.querySelector("textarea");
    if (act === "sendback" && !ta.value) ta.value = r.check?.state === "fail" ? `The checks fail (\`${r.check.cmd}\`, exit ${r.check.exit}). Fix it, re-run them, and show me the output.` : "Not done yet: run the tests and type checks, show me the output, and fix anything that fails.";
    form.dataset.action = act;
    ta.focus();
    autosize(ta);
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function closeReply(form) {
  form.hidden = true;
  if (form.contains(document.activeElement)) document.activeElement.blur();
  applyInboxFocus(false);
}
function skipDecision(key) {
  const d = (S.decisions ?? []).find((x) => x.key === key);
  if (!d) return;
  focusPast(key);
  S.skipped.set(key, dsig(d));
  S.skipStack.push(key);
  renderInbox();
  applyInboxFocus(true);
  triageToast(`Skipped ${rowOf(key)?.project ?? "it"} for now · u brings it back`);
}
function undoSkip() {
  while (S.skipStack.length) {
    const k = S.skipStack.pop();
    if (!S.skipped.has(k)) continue;
    S.skipped.delete(k);
    S.ifocus = k;
    renderInbox();
    applyInboxFocus(true);
    return toast(`Back: ${rowOf(k)?.project ?? "the decision"}`);
  }
  toast("Nothing skipped to bring back");
}
function setInboxFilter(f) { S.inboxFilter = f; store("inboxFilter", f); S.ifocus = null; S.ifocusIdx = 0; renderInbox(); }
/** Inbox keys, called by the global handler (which already skips inputs, dialogs and menus). True when handled. */
function inboxKeydown(e) {
  const k = e.key;
  if (k === "Escape") { const form = $("dbody").querySelector(".dreply:not([hidden])"); if (form) { closeReply(form); return true; } return false; }
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveInboxFocus(1); return true; }
  if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveInboxFocus(-1); return true; }
  if (k === "f" || k === "F") {
    const i = IFILTERS.findIndex(([id]) => id === S.inboxFilter);
    const [id, label] = IFILTERS[(i + (k === "F" ? IFILTERS.length - 1 : 1)) % IFILTERS.length];
    setInboxFilter(id);
    toast(`Showing: ${label}`);
    return true;
  }
  if (k === "u") { undoSkip(); return true; }
  if (k === "Enter" && e.target.closest?.("button, a, summary")) return false; // Enter on a focused button presses it
  const isCardKey = /^([1-9ynvrosx]|Enter)$/.test(k);
  const card = S.ifocus && cardOf(S.ifocus);
  const d = card && !card.classList.contains("leaving") && (S.decisions ?? []).find((x) => x.key === S.ifocus);
  if (!d) return isCardKey; // an empty inbox swallows card keys instead of running their global meanings
  const a = inboxKey(d, k);
  if (!a) return false;
  e.preventDefault();
  if (a.miss) toast(a.miss);
  else if (a.opt) inboxPick(d.key, a.opt);
  else inboxAct(d.key, a.act);
  return true;
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "inbox") return;
  const chip = e.target.closest("[data-ifilter]");
  if (chip) return setInboxFilter(chip.dataset.ifilter);
  if (e.target.closest("[data-iunskip]")) { S.skipped.clear(); S.skipStack = []; return renderInbox(); }
  if (e.target.closest("[data-jevtog]")) { S.jevOpen = !S.jevOpen; store("jevOpen", S.jevOpen); renderInbox(); if (S.jevOpen) loadJevStats(true); return; }
  const card = e.target.closest(".dcard");
  if (!card) return;
  const key = card.dataset.dkey;
  const d = S.decisions.find((x) => x.key === key);
  const r = rowOf(key);
  if (!d || !r) return;
  if (S.ifocus !== key && !card.classList.contains("leaving")) { S.ifocus = key; applyInboxFocus(false); }
  const opt = e.target.closest("[data-dopt]");
  if (opt) {
    const o = d.options.find((x) => String(x.id) === opt.dataset.dopt);
    return o && inboxPick(key, o);
  }
  const chk = e.target.closest("[data-dcheck]")?.dataset.dcheck;
  if (chk) {
    if (chk === "never") return api("/api/verify", { key, approve: false }).then(() => toast(`Checks off for ${r.project}`)).catch((x) => toast(x.message, true));
    let cmd = r.check?.cmd;
    if (chk === "edit") { cmd = await askDialog({ title: `Check command for ${r.project}`, text: "Runs in the project folder when an agent says it’s done. Only this command, only for this project.", input: cmd ?? "", ok: "Allow" }); if (!cmd) return; }
    return api("/api/verify", { key, approve: true, cmd }).then(() => toast(`Checking ${r.project}…`)).catch((x) => toast(x.message, true));
  }
  const act = e.target.closest("[data-dact2]")?.dataset.dact2;
  if (act) inboxAct(key, act);
});
$("dbody").addEventListener("change", async (e) => {
  const f = e.target.closest?.("[data-jevfeat]");
  if (!f) return;
  const on = f.checked;
  try { const r = await api("/api/jev/feature", { name: f.dataset.jevfeat, on }); S.jev = r.jev; toast(`${JEV_FEATS.find((x) => x[0] === f.dataset.jevfeat)?.[1] ?? "Jev feature"}: ${on ? "on" : "off"}`); } catch (x) { f.checked = !on; toast(x.message, true); }
});
$("dbody").addEventListener("submit", async (e) => {
  const cap = e.target.closest(".jcap");
  if (cap) {
    e.preventDefault();
    const n = Number(cap.querySelector("input").value);
    try { const r = await api("/api/jev/cap", { cap: n }); S.jev = r.jev; toast(`Jev daily cap: ${n}`); loadJevStats(true); } catch (x) { toast(x.message, true); }
    return;
  }
  const form = e.target.closest(".dreply");
  if (!form) return;
  e.preventDefault();
  const key = form.closest(".dcard").dataset.dkey;
  const text = form.querySelector("textarea").value.trim();
  if (!text) return;
  const back = form.dataset.action === "sendback";
  decide(key, back ? "sendback" : "reply", () => api("/api/send", { key, text }), undefined, `${back ? "Sent back to" : "Sent to"} ${rowOf(key)?.project ?? "the agent"}: “${plain(text).slice(0, 50)}${text.length > 50 ? "…" : ""}”`);
});
$("dbody").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.matches(".dreply textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === "Escape" && e.target.matches(".dreply textarea")) { e.preventDefault(); e.stopPropagation(); closeReply(e.target.form); }
});

// History ──────────────────────────────────────────────────────────────────
