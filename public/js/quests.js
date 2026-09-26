"use strict";
// ── Quest board (the game: src/game*.ts) ────────────────────────────────────── <quests>
// One project is the main quest (its proofs count double), three quests a day, bosses whose health is a real business
// number, founder levels that only business milestones unlock, a streak of days you shipped, sold or talked to users,
// and a weekly season with Jev's honest read. Everything on this board comes from /api/game, and every XP line links
// its evidence. Nothing starts without the New session dialog; nothing is posted or sent for you.
S.qb = { data: null, loading: false, polls: 0, err: null, logAll: false };
S.game = S.game ?? null;
const QTZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const qsvg = (vb, body, cls = "") => `<svg class="${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const QI = {
  sword: qsvg("0 0 16 16", '<path d="M13.5 2.5 6.8 9.2M13.5 2.5v3l-5 5M13.5 2.5h-3l-5 5"/><path d="m4 9.5 2.5 2.5M3 13l2.2-2.2M2.5 11.8l1.7 1.7"/>'),
  flame: qsvg("0 0 24 24", '<path class="f1" d="M12 2.5c.8 3.2 4.6 5.3 4.6 10a4.6 4.6 0 0 1-9.2 0c0-2.3 1-3.7 2.2-4.9.3 1.6 1.1 2.5 2 2.8C11 8.2 10.7 5.4 12 2.5z"/><path class="f2" d="M12 21.2a2.6 2.6 0 0 1-2.6-2.6c0-1.6 1.3-2.4 2.6-4 1.3 1.6 2.6 2.4 2.6 4a2.6 2.6 0 0 1-2.6 2.6z"/>'),
  rocket: qsvg("0 0 16 16", '<path d="M9.5 2.2c2.4-.6 4 .1 4.3.3.2.3.9 1.9.3 4.3L9 11.9 4.1 7z"/><path d="M4.1 7 2 7.5l1.6-2.6 3-.6M9 11.9l-.5 2.1 2.6-1.6.6-3"/><circle cx="10.6" cy="5.4" r="1.2"/><path d="M4.6 11.4c-.9.3-1.7 1.3-2 2.6 1.3-.3 2.3-1.1 2.6-2"/>'),
  user: qsvg("0 0 16 16", '<circle cx="8" cy="5.5" r="2.7"/><path d="M2.8 14c.6-2.8 2.6-4.3 5.2-4.3s4.6 1.5 5.2 4.3"/>'),
  coin: qsvg("0 0 16 16", '<circle cx="8" cy="8" r="6"/><path d="M9.9 5.6c-.4-.6-1.1-.9-1.9-.9-1.1 0-1.9.6-1.9 1.4 0 1.9 3.9.9 3.9 2.9 0 .8-.9 1.4-2 1.4-.8 0-1.6-.3-2-.9M8 3.8v1M8 11.2v1"/>'),
  chat: qsvg("0 0 16 16", '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>'),
  chats: qsvg("0 0 16 16", '<path d="M1.8 2.8h8.4v5.8H5.5L3.2 10.5V8.6H1.8z"/><path d="M12 5.5h2.2v5.8h-1.4v1.9l-2.3-1.9H6.6"/>'),
  send: qsvg("0 0 16 16", '<path d="M14.2 1.8 1.8 7l5 1.9 1.9 5z"/><path d="m6.8 8.9 7.4-7.1"/>'),
  skull: qsvg("0 0 16 16", '<path d="M3 7.2a5 5 0 1 1 10 0c0 1.6-.8 2.6-1.8 3.2v2.1H4.8v-2.1C3.8 9.8 3 8.8 3 7.2z"/><circle cx="6" cy="7.4" r="1.1"/><circle cx="10" cy="7.4" r="1.1"/><path d="M7 12.5v1.5M9 12.5v1.5"/>'),
  check: qsvg("0 0 16 16", '<path d="m3 8.5 3 3 7-7.5"/>'),
  scroll: qsvg("0 0 16 16", '<path d="M4 2.5h8a1.5 1.5 0 0 1 0 3h-1.5v7a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5v-1h6.5v1a1.5 1.5 0 0 0 1.5 1.5"/><path d="M4 2.5A1.5 1.5 0 0 0 2.5 4v7.5M6 8h2.5M6 5.5h3"/>'),
  ship: qsvg("0 0 16 16", '<path d="M2 10.5h12l-1.8 3H3.8z"/><path d="M4 10.5V7h8v3.5M8 7V2.5M8 3.5l3 2H8"/>'),
  cart: qsvg("0 0 16 16", '<path d="M1.5 2.5h2l1.7 7.3h7.3L14 4.5H4.2"/><circle cx="6" cy="12.8" r="1.1"/><circle cx="11.5" cy="12.8" r="1.1"/>'),
  people: qsvg("0 0 16 16", '<circle cx="5.5" cy="5.5" r="2.2"/><circle cx="11" cy="6.2" r="1.8"/><path d="M1.5 13.5c.4-2.4 1.9-3.7 4-3.7s3.6 1.3 4 3.7M10 9.8c1.9-.3 3.8.8 4.3 3"/>'),
  crown: qsvg("0 0 16 16", '<path d="M2 5.5 4.8 8 8 3l3.2 5L14 5.5 12.8 12H3.2z"/><path d="M3.5 14h9"/>'),
  wrench: qsvg("0 0 16 16", '<path d="M9.8 3.2a3 3 0 0 0-3.9 3.9L2.5 10.5a1.4 1.4 0 0 0 2 2l3.4-3.4a3 3 0 0 0 3.9-3.9L10 7l-1.9-.4L7.8 4.8z"/>'),
  pillars: qsvg("0 0 16 16", '<path d="M2 5.5 8 2l6 3.5zM3 13.5h10M2 14.8h12M4.2 6.5v6M7 6.5v6M9 6.5v6M11.8 6.5v6"/>'),
  link: qsvg("0 0 16 16", '<path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2L8 3.7"/><path d="M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l1-.9"/>'),
  dice: qsvg("0 0 16 16", '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><circle cx="5.7" cy="5.7" r=".6" fill="currentColor"/><circle cx="10.3" cy="10.3" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/>'),
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.2v9.6L12.8 8z"/></svg>',
  plus: qsvg("0 0 16 16", '<path d="M8 3v10M3 8h10"/>'),
  quest: qsvg("0 0 16 16", '<path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="m5.5 8 1.6 1.6 3.4-3.5"/>'),
};
const Q_LEVEL_ICON = { maker: "wrench", shipper: "rocket", seller: "coin", founder: "pillars", operator: "crown" };
const Q_PROOF = { sell: ["Sell", "coin"], talk: ["Talk to users", "chats"], lead: ["Leads", "send"], ship: ["Ship", "rocket"], milestone: ["Milestone", "sword"], metric: ["Numbers", "scroll"], check: ["Code", "check"] };
const Q_TYPE_ICON = { ship: "rocket", sell: "coin", talk: "chat", build: "wrench", prune: "skull", bonus: "quest" };
const qmoney = (n) => `$${Number(n || 0).toLocaleString("en", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
const qnum = (n) => (n == null ? "–" : Number(n).toLocaleString("en", { maximumFractionDigits: 1 }));
const qreduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const qseen = (k) => new Set(load(`qseen:${k}`, []));
const qmark = (k, ids) => { const s = qseen(k); for (const i of ids) s.add(i); store(`qseen:${k}`, [...s].slice(-400)); };

function qBadge(lv, size = 64) {
  const pts = (r) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i - Math.PI / 2; return `${(32 + r * Math.cos(a)).toFixed(1)},${(32 + r * Math.sin(a)).toFixed(1)}`; }).join(" ");
  return `<svg class="qbadge lv-${lv.id}" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
    <polygon points="${pts(29)}" class="hx-o"/><polygon points="${pts(24)}" class="hx-i"/>
    <g transform="translate(20 19) scale(1.5)" class="glyph" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${QI[Q_LEVEL_ICON[lv.id]].replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>
    <circle cx="50.5" cy="50" r="9.5" class="rkc"/><text x="50.5" y="53.6" class="rk">${lv.rank}</text></svg>`;
}
function qSigil(s, cls = "") {
  const inner = QI[{ cart: "cart", coin: "coin", people: "people", crown: "crown" }[s] ?? "sword"].replace(/^<svg[^>]*>|<\/svg>$/g, "");
  return `<svg class="qsig ${cls}" viewBox="0 0 64 64" aria-hidden="true"><path class="sh" d="M32 3 57 13v18c0 15-10.6 25.3-25 30C17.6 56.3 7 46 7 31V13z"/><path class="sh2" d="M32 9.5 51 17v14c0 11.4-7.9 19.4-19 23.3C20.9 50.4 13 42.4 13 31V17z"/><g transform="translate(18 16) scale(1.75)" class="g" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
}
/** Where an XP line's evidence lives: a link, a commit on GitHub, the project page, or just the words. */
function qEvLink(l, label = "") {
  if (!l) return "";
  const a = (href, t) => `<a class="qev-a" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(t)}">${QI.link}${label ? `<span>${esc(label)}</span>` : ""}</a>`;
  if (l.url) return a(l.url, l.url);
  if (l.commit && l.github) return a(`https://github.com/${l.github}/commit/${l.commit}`, `commit ${l.commit.slice(0, 8)} on GitHub`);
  if (l.session) return a(`/s/${encodeURIComponent(l.machine ?? "")}/claude/${encodeURIComponent(l.session)}`, "the session");
  if (l.project) return `<button class="qev-a" data-qopen="${esc(l.project)}" title="${esc(l.commit ? `commit ${l.commit.slice(0, 8)}` : l.wiki ? `wiki: ${l.wiki}` : l.file ?? "the project page")}">${QI.link}${label ? `<span>${esc(label)}</span>` : ""}</button>`;
  return "";
}

function openQuests() { setMode("quests"); }
async function loadQuests(opts = {}) {
  if (S.qb.loading && !opts.force) return;
  S.qb.loading = true;
  try {
    const d = await api("/api/game", { tz: QTZ, refresh: !!opts.refresh }, 45_000);
    S.qb.data = d; S.qb.err = null;
    qSummary(d);
    if (S.mode === "quests") renderQuests();
    clearTimeout(loadQuests.t);
    if ((d.pending || d.quests?.generating) && S.qb.polls < 60) { S.qb.polls++; loadQuests.t = setTimeout(() => { if (S.mode === "quests") loadQuests({ force: true }); }, 2500); }
    else S.qb.polls = 0;
  } catch (e) { S.qb.err = e.message; if (S.mode === "quests") renderQuests(); }
  finally { S.qb.loading = false; }
}
/** The header chip's numbers from a full board (so it's right the moment the board changes). */
function qSummary(d) {
  S.game = { started: true, level: d.level.name, levelId: d.level.id, rank: d.level.rank, streak: d.streak.current, streakToday: d.streak.today, xpToday: d.xp.today, main: d.main?.project ?? null, questsOpen: d.quests.items.filter((q) => q.state !== "done").length };
  renderQChip();
}
function questsLive(sum) {
  S.game = { ...S.game, ...sum };
  renderQChip();
  if (S.mode === "quests" && !S.qb.loading) { clearTimeout(questsLive.t); questsLive.t = setTimeout(() => loadQuests({ force: true }), 400); }
}
function renderQChip() {
  let el = $("qchip");
  const g = S.game;
  if (!el) {
    const brand = document.querySelector(".lh-top .brand");
    if (!brand) return;
    el = document.createElement("button");
    el.id = "qchip"; el.className = "qchip"; el.type = "button";
    el.addEventListener("click", () => setMode(S.mode === "quests" ? null : "quests"));
    brand.after(el);
  }
  el.hidden = !g?.started;
  if (!g?.started) return;
  const id = g.levelId ?? String(g.level ?? "maker").toLowerCase();
  el.title = `${g.level} · rank ${g.rank}${g.streak ? ` · ${g.streak}-day streak${g.streakToday ? "" : " (ship, sell or talk today to keep it)"}` : ""} · Quest board (q)`;
  setHTML(el, `<span class="qc-lv lv-${esc(id)}">${QI[Q_LEVEL_ICON[id] ?? "wrench"]}</span><b>${esc(g.level)}</b><span class="qc-rk">${g.rank}</span>${g.streak ? `<span class="qc-fl ${g.streakToday ? "on" : "risk"}">${QI.flame}${g.streak}</span>` : ""}${g.questsOpen ? `<span class="qc-q">${g.questsOpen}</span>` : ""}`);
}

// ── the page ──
function qHero(d) {
  const lv = d.level, st = d.streak, rv = d.revenue;
  const nextLv = lv.next ? `Next level: <b>${esc(lv.next.name)}</b> · ${esc(lv.next.need)}` : "Top level.";
  return `<header class="qhero lv-${lv.id}">
    <div class="qlvl" title="${esc(lv.by ? `${lv.name} since ${jdate(lv.since)}: ${lv.by.title}` : "Every founder starts here")}">
      ${qBadge(lv, isPhone() ? 58 : 76)}
      <div class="qlvl-t">
        <span class="qk">Founder level</span>
        <h2><span>${esc(lv.name)}</span><em>rank ${lv.rank}</em></h2>
        <div class="qxpbar" role="meter" aria-label="XP to the next rank" aria-valuemin="0" aria-valuemax="${lv.step}" aria-valuenow="${lv.step - lv.toNext}"><i style="--p:${lv.pct.toFixed(3)}"></i></div>
        <small class="qxpl"><b>${qnum(lv.step - lv.toNext)}</b> / ${qnum(lv.step)} XP · ${qnum(lv.toNext)} to rank ${lv.rank + 1}</small>
        <small class="qnextlv">${nextLv}</small>
      </div>
    </div>
    <div class="qstats">
      <div class="qstat qrev" title="${esc(rv.products.length ? `Gumroad: ${rv.products.join(", ")}` : "No Gumroad product matches your projects yet")}"><span class="qk">Revenue</span><b class="qmoney" data-to="${rv.total}">${qmoney(rv.total)}</b><small>${rv.last30 ? `${qmoney(rv.last30)} in 30 days` : rv.products.length ? `Gumroad · ${rv.sales} sale${rv.sales === 1 ? "" : "s"}` : "via Gumroad on project pages"}</small></div>
      <div class="qstat qflame ${st.current ? "on" : ""} ${st.today ? "lit" : st.atRisk ? "risk" : ""}" title="Days in a row you shipped, sold or talked to users (best: ${st.best})"><span class="qk">Streak</span><b>${QI.flame}<span>${st.current}</span></b><small>${st.today ? "kept today" : st.atRisk ? "ship, sell or talk today" : "ship, sell or talk to start"}</small></div>
      <div class="qstat qtodayxp" title="XP earned today (main quest ×2, side quests capped at ${d.xp.allowance})"><span class="qk">Today</span><b>+${qnum(d.xp.today)}</b><small>${qnum(d.xp.total)} XP all time</small></div>
    </div>
  </header>`;
}
function qBoss(d) {
  const bs = d.main.bosses ?? [];
  const b = bs.find((x) => x.state === "alive");
  const seenHits = qseen("hits");
  const newHit = b?.hits.some((h) => !seenHits.has(h.id));
  const chips = bs.length > 1 ? `<div class="qbosses" aria-label="Bosses">${bs.map((x) => `<span class="qbchip ${x.state}${x === b ? " cur" : ""}" title="${esc(`${x.title}: ${x.state === "defeated" ? `defeated${x.at ? ` ${jdate(x.at)}` : ""}` : `${Math.round(x.hp * 100)}% health`}`)}">${QI[x.state === "defeated" ? "skull" : x.sigil] ?? QI.sword}<span>${esc(x.title)}</span></span>`).join("")}</div>` : "";
  if (!b) return `<div class="qboss cleared"><div class="qsigwrap">${qSigil("crown", "won")}</div><div class="qboss-b"><span class="qk">Bosses</span><b class="qboss-t">All bosses defeated</b><small>Log bigger numbers on the project page to unlock the next ladder.</small></div></div>${chips}`;
  const i = bs.indexOf(b);
  const hp = Math.round(b.hp * 100);
  const unit = b.unit === "$" ? "" : ` ${b.unit}`;
  const val = (v) => (b.unit === "$" ? qmoney(v) : qnum(v));
  return `<div class="qboss s-${b.sigil}${newHit ? " hit" : ""}" data-boss="${esc(b.id)}">
    <div class="qsigwrap">${qSigil(b.sigil)}<span class="qdmg" aria-hidden="true">${newHit ? `−${qnum(b.hits[0].dmg)}` : ""}</span></div>
    <div class="qboss-b">
      <span class="qk">${QI.sword} Boss ${i + 1} of ${bs.length}${b.standard ? " · standard" : ""}</span>
      <b class="qboss-t">${esc(b.title)}</b>
      <div class="qhp${hp <= 25 ? " low" : ""}" role="meter" aria-label="Boss health" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${hp}"><i style="--hp:${b.hp.toFixed(3)}"></i><span>${hp}%</span></div>
      <small class="qbv">${b.known ? `<b>${val(b.value)}</b> of ${val(b.target)}${esc(unit)} · ` : `target ${val(b.target)}${esc(unit)} · `}<span title="${esc(b.measured)}">${esc(b.measured)}</span></small>
    </div>
  </div>
  ${chips}
  ${b.hits.length ? `<ol class="qhits" aria-label="Battle log for this boss">${b.hits.slice(0, 3).map((h) => `<li class="${seenHits.has(h.id) ? "" : "new"}"><span class="dmg">−${qnum(h.dmg)}</span><span class="t">${esc(h.title)}</span><time>${esc(agoText(h.t))}</time>${qEvLink(h.link)}</li>`).join("")}</ol>` : `<p class="qhint qnohit">No hits yet. Every sale, and every number you log with a note, lands a hit.</p>`}`;
}
function qMainCard(d) {
  if (!d.main) {
    const cand = d.candidate;
    return `<section class="qcard qpick">
      ${cand ? `<div class="qcand" style="--pc:${pc(cand.project)}"><span class="qk">${QI.dice} New run</span><b>${esc(cand.run?.name ?? cand.project)}</b><small>${esc(cand.run?.pitch ?? cand.pitch ?? "")}</small><button class="btn primary" data-qmain="${esc(cand.project)}">Make it the main quest</button></div>` : ""}
      <h3>Pick your main quest</h3>
      <p class="qhint">The main quest's proofs count <b>double</b>, today's quests are written for it, and its money and user milestones become bosses. Other projects are side quests, capped each day.</p>
      <div class="qpicks">${(d.suggest ?? []).map((s) => `<button class="qpickb" data-qmain="${esc(s.project)}" style="--pc:${pc(s.project)}"><span class="dot"></span><b>${esc(s.project)}</b><small>${esc(s.pitch || s.stage || "")}</small>${s.boss ? `<em>${QI.sword} ${esc(s.boss)}</em>` : ""}</button>`).join("") || `<p class="qhint"><span class="spin"></span> Reading your projects…</p>`}</div>
    </section>`;
  }
  const m = d.main;
  const nx = m.next;
  const cand = d.candidate && d.candidate.project !== m.project ? d.candidate : null;
  return `<section class="qcard qmain" style="--pc:${pc(m.project)}">
    <div class="qmain-h"><span class="qtag">${QI.sword} Main quest · ×2 XP</span><span class="spacer"></span><button class="link" data-qswitch>Switch</button></div>
    <h2 class="qmain-p"><button class="link" data-qopen="${esc(m.project)}">${esc(m.project)}</button></h2>
    ${m.pitch ? `<p class="qpitch">${esc(m.pitch)}</p>` : ""}
    <div class="qarena">${qBoss(d)}</div>
    ${nx && nx.title !== (m.bosses ?? []).find((b) => b.state === "alive")?.title ? `<div class="qnextms"><span class="qk">Next milestone</span><b>${esc(nx.title)}</b><span class="qmini"><i style="--p:${(nx.pct ?? 0).toFixed(3)}"></i></span><small>${nx.value != null ? `${qnum(nx.value)} of ${qnum(nx.target)}` : "not measured yet"}</small></div>` : ""}
    <div class="qmain-f"><button class="btn primary" data-qlogwin>${QI.plus} Log proof</button><button class="btn" data-qopen="${esc(m.project)}">Project page</button></div>
    ${cand ? `<div class="qcand mini" style="--pc:${pc(cand.project)}"><span class="qk">${QI.dice} New run waiting</span><b>${esc(cand.run?.name ?? cand.project)}</b><button class="link" data-qmain="${esc(cand.project)}">Make it the main quest</button></div>` : ""}
  </section>`;
}
function qQuestCard(q, i, d) {
  const [label, icon] = Q_PROOF[q.proof] ?? ["Quest", "quest"];
  const xp = q.xp * 2;
  const done = q.state === "done";
  const seen = qseen("done");
  const fresh = done && !seen.has(q.id);
  const prog = q.proof === "lead" && q.count > 1 ? `<span class="qprog" title="${q.progress ?? 0} of ${q.count} logged">${Array.from({ length: q.count }, (_, k) => `<i class="${k < (q.progress ?? 0) ? "on" : ""}"></i>`).join("")}</span>` : "";
  return `<article class="qq p-${q.proof}${done ? " done" : ""}${fresh ? " fresh" : ""}" style="--i:${i}" data-q="${esc(q.id)}">
    <div class="qq-top"><span class="qkind">${QI[icon]}${esc(label)}</span>${prog}<span class="qxp">+${xp} XP</span></div>
    <h4>${esc(q.title)}</h4>
    <p class="qwhy">${esc(q.why)}</p>
    ${q.milestoneTitle ? `<p class="qmove">${QI.sword} moves <b>${esc(q.milestoneTitle)}</b></p>` : ""}
    <p class="qver" title="How it's verified">${QI.check}<span>${esc(q.verify)}</span></p>
    ${done ? `<div class="qproof">${QI.check}<span><b>Done</b> · ${esc(q.evidence?.title ?? "")}</span>${qEvLink(q.evidence?.link, "evidence")}</div><span class="qstamp" aria-hidden="true">+${xp}</span>`
      : `<div class="qq-acts"><button class="btn primary" data-qstart="${esc(q.id)}">${q.mode === "agent" ? `${QI.play} Start` : "Do it yourself"}</button><button class="btn" data-qdone="${esc(q.id)}">Done…</button><button class="btn ghost" data-qreroll="${esc(q.id)}" ${d.quests.rerollsLeft ? "" : "disabled"} title="${d.quests.rerollsLeft ? `Swap for another quest (${d.quests.rerollsLeft} left today)` : "No rerolls left today"}">${QI.dice}<span>Reroll</span></button></div>`}
  </article>`;
}
function qQuests(d) {
  const Q = d.quests;
  if (!d.main) return "";
  const gen = !Q.items.length;
  const doneN = Q.items.filter((q) => q.state === "done").length;
  return `<section class="qcard qquests">
    <div class="qsec-h"><h3>Today's quests</h3>${Q.items.length ? `<span class="qcount">${doneN}/${Q.items.length}</span>` : ""}<span class="spacer"></span>${gen ? "" : `<span class="qhint" title="${esc([Q.note, ...Q.rejected.map((r) => `Rejected “${r.title}”: ${r.reason}`)].filter(Boolean).join("\n"))}">${Q.source === "claude" ? `Claude ${esc(Q.model ?? "")}` : "simple rules"}${Q.rejected.length ? ` · ${Q.rejected.length} generic rejected` : ""} · ${Q.rerollsLeft} reroll${Q.rerollsLeft === 1 ? "" : "s"} left</span>`}</div>
    ${gen ? `<div class="qgen"><span class="spin"></span> Writing today's quests from ${esc(d.main.project)}'s next milestone, its boss and fresh leads…</div>${[0, 1, 2].map(() => '<div class="qq skel"></div>').join("")}` : `<div class="qqs">${Q.items.map((q, i) => qQuestCard(q, i, d)).join("")}</div>`}
    ${Q.note && !gen ? `<p class="qhint qnote">${esc(Q.note)}</p>` : ""}
  </section>`;
}
function qLogCard(d) {
  const all = S.qb.logAll;
  const ls = d.log.slice(0, all ? 60 : isPhone() ? 6 : 9);
  const era = (l) => (l.main === true ? `<em class="m">main ×2</em>` : l.main === false ? `<em class="s">side</em>` : `<em>history</em>`);
  return `<section class="qcard qlogc">
    <div class="qsec-h"><h3>Battle log</h3><span class="spacer"></span><span class="qhint">every line links its evidence</span></div>
    ${ls.length ? `<ol class="qlog">${ls.map((l) => `<li class="t-${l.type}${l.capped ? " capped" : ""}"><span class="qli">${QI[Q_TYPE_ICON[l.type]] ?? QI.quest}</span><span class="qlx">${l.eff ? `+${qnum(l.eff)}` : "+0"}</span><div class="qlb"><b>${esc(l.title)}</b><small>${esc(l.project)} · ${era(l)}${l.capped ? ` · <span title="side quests share a daily allowance">capped ${l.xp}→${l.eff}</span>` : ""} · ${esc(when(l.t))}</small><small class="qev" title="${esc(l.evidence)}">${esc(l.evidence)}</small></div>${qEvLink(l.link)}${l.undo ? `<button class="link qundo" data-qundo="${esc(l.id)}">Undo</button>` : ""}</li>`).join("")}</ol>
      ${d.log.length > ls.length || all ? `<button class="link qmore" data-qlogall>${all ? "Show less" : `Show all ${d.log.length}`}</button>` : ""}`
      : `<p class="qhint">Nothing yet. A release, a deploy the wiki records, a sale, a lead you contacted or a conversation you log shows up here, with its evidence.</p>`}
  </section>`;
}
function qSeason(d) {
  const s = d.season, b = s.board;
  const j = s.judge;
  const pct = j?.p != null ? Math.round(j.p * 100) : null;
  const ring = pct != null ? `<svg class="qring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/><text x="22" y="26.5">${pct}%</text></svg>` : "";
  const cell = (n, l, cls = "") => `<div class="qsc ${cls}"><b>${n}</b><span>${l}</span></div>`;
  return `<section class="qcard qseason${s.sunday ? " sun" : ""}">
    <div class="qsec-h"><h3>Season</h3><span class="qhint">week of ${esc(jdate(Date.parse(`${s.week}T12:00:00`)))}</span><span class="spacer"></span>${s.sunday ? `<span class="qtag sm">Review day</span>` : ""}</div>
    ${s.goal ? `<p class="qgoal"><span class="qk">This week's goal</span>“${esc(s.goal)}” <button class="link" data-qgoal>Edit</button></p>` : `<button class="qgoal-set" data-qgoal>${QI.plus} Set this week's goal <small>one sentence, on Monday</small></button>`}
    <div class="qscore">${cell(b.shipped.length, "shipped", "sh")}${cell(b.sold, b.revenue ? `sold · ${qmoney(b.revenue)}` : "sold", "so")}${cell(b.talks + b.leads, "talks & leads", "ta")}${cell(qnum(b.xp), "XP", "xp")}${cell(b.hits, "boss hits", "bh")}${cell(b.quests, "quests", "qu")}</div>
    <details class="qreview"${s.sunday || j || s.lessons ? " open" : ""}><summary>${s.sunday ? "The Sunday review" : "Review now"}</summary>
      <label class="qles"><span class="qk">Lessons</span><textarea class="inp" rows="2" data-qlessons placeholder="What worked, what didn't, what you'll do differently">${esc(s.lessons ?? "")}</textarea></label>
      <div class="qjev">${j && !j.fallback ? `${ring}<div><span class="qk">Jev's read${j.cached ? "" : ""}</span><b>${esc(j.reason ?? "")}</b><small>${pct != null ? `${pct}% that the goal was met, judged only by the evidence above.` : ""}${s.dispute ? ` You disputed: “${esc(s.dispute.note)}”` : ""}</small>${s.dispute ? "" : `<button class="link" data-qdispute>Dispute</button>`}</div>`
        : j?.fallback ? `<p class="qhint">Jev couldn't judge: ${esc(j.fallback)}</p>` : ""}
        ${!s.goal ? `<p class="qhint">Set a goal and Jev will judge, from the evidence, whether the week met it.</p>` : s.jev ? `<button class="btn${j ? " ghost" : ""}" data-qjudge>${j ? "Ask Jev again" : "Ask Jev: was the goal met?"}</button>` : `<p class="qhint">Jev isn't set up on this machine, so there's no judgment.</p>`}</div>
    </details>
  </section>`;
}
function qAch(d) {
  const got = d.achievements.filter((a) => a.at).length;
  const seen = qseen("ach");
  return `<section class="qcard qachc">
    <div class="qsec-h"><h3>Achievements</h3><span class="qcount">${got}/${d.achievements.length}</span></div>
    <div class="qshelf">${d.achievements.map((a, i) => `<button class="qa${a.at ? " got" : ""}${a.at && !seen.has(a.id) ? " fresh" : ""}" style="--i:${i}" data-qach="${esc(a.id)}" title="${esc(a.at ? `${a.title}: ${jdate(a.at)} · ${a.evidence ?? ""}` : `${a.title}: ${a.desc}`)}"><span class="qai">${QI[a.icon] ?? QI.check}</span><span class="qat">${esc(a.title)}</span><small>${a.at ? esc(jdate(a.at)) : "locked"}</small></button>`).join("")}</div>
  </section>`;
}
function qSide(d) {
  const side = d.side ?? [];
  return `<section class="qcard qside">
    <div class="qsec-h"><h3>Side quests</h3><span class="spacer"></span><span class="qhint" title="Side quests share an allowance: 30% of the main quest's XP today, never under 50">${qnum(d.xp.side)} / ${qnum(d.xp.allowance)} XP today</span></div>
    ${side.length ? `<ul class="qsl">${side.slice(0, 12).map((s) => `<li style="--pc:${pc(s.project)}"><span class="dot"></span><div class="qsb"><button class="link" data-qopen="${esc(s.project)}">${esc(s.project)}</button><small>${s.loading ? "reading…" : esc([s.boss ? `boss: ${s.boss.title} (${Math.round(s.boss.hp * 100)}% health)` : "", s.last ? `active ${agoText(s.last)}` : ""].filter(Boolean).join(" · "))}</small></div>${s.xpToday ? `<span class="qsx${s.capped ? " capped" : ""}">+${qnum(s.xpToday)}</span>` : ""}<span class="qsa"><button class="link" data-qmain="${esc(s.project)}">Make main</button><button class="link danger" data-qretire="${esc(s.project)}" title="Retire it: pruning is progress">Retire…</button></span></li>`).join("")}</ul>` : `<p class="qhint">No side quests.</p>`}
    ${d.retired.length ? `<p class="qhint qret">${QI.skull} Retired: ${d.retired.map((r) => `${esc(r.project)} <button class="link" data-qunretire="${esc(r.project)}">bring back</button>`).join(", ")}</p>` : ""}
  </section>`;
}
function qDefeats(d) {
  const seen = qseen("def");
  const bs = (d.main?.bosses ?? []).filter((b) => b.state === "defeated" && b.at && b.at >= d.startedAt && !seen.has(b.id));
  if (!bs.length) return "";
  const b = bs[0];
  return `<div class="qdefeat" role="status" data-qdefeat="${esc(b.id)}"><div class="qdf-in">${qSigil(b.sigil, "dead")}<span class="qk">Boss defeated</span><b>${esc(b.title)}</b><small>${esc(b.measured)}</small><button class="btn primary" data-qdefok="${esc(b.id)}">Close</button></div></div>`;
}
function renderQuests(fresh) {
  const d = S.qb.data;
  if (!d || d.error) {
    if (!d && !S.qb.loading && !S.qb.err) loadQuests();
    modeHTML(`<div class="qb"><header class="qhero skel"><div class="qlvl"><div class="qbadge-sk"></div><div class="qlvl-t"><span class="qk">Quest board</span><h2>${S.qb.err ? "Couldn’t load" : "Reading your evidence…"}</h2><small>${S.qb.err ? esc(S.qb.err) : '<span class="spin"></span> releases, deploys, sales, milestones, checks'}</small>${S.qb.err ? '<button class="btn" data-qretry>Try again</button>' : ""}</div></div></header></div>`);
    return;
  }
  const box = $("dbody");
  const sig = JSON.stringify([d.xp, d.level.rank, d.level.id, d.streak, d.revenue.total, d.main?.project, (d.main?.bosses ?? []).map((b) => [b.hp, b.hits.length]), d.quests, d.season, d.side.map((s) => [s.project, s.xpToday, s.loading]), d.candidate?.project, d.retired.length, d.pending, d.log.length, d.log[0]?.id, d.log[0]?.undo, S.qb.logAll, isPhone(), (d.suggest ?? []).length]);
  if (!fresh && box._mode === "quests" && box._qsig === sig && box.querySelector(".qb")) return;
  box._qsig = sig;
  const calm = S.qb.shown;
  S.qb.shown = true;
  const phoneOrder = isPhone();
  const left = `${qMainCard(d)}${qQuests(d)}${phoneOrder ? "" : qLogCard(d)}`;
  const right = `${qSeason(d)}${phoneOrder ? qLogCard(d) : ""}${qAch(d)}${d.main || d.side.length ? qSide(d) : ""}`;
  modeHTML(`<div class="qb${calm ? " calm" : ""}"><p class="qtop"><span class="qk">Quest board</span><span>${esc(new Date(d.now).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}</span></p>${qHero(d)}<div class="qgrid"><div class="qcol">${left}</div><div class="qcol">${right}</div></div>${d.pending ? `<p class="qhint qpend"><span class="spin"></span> Reading more projects…</p>` : ""}${qDefeats(d)}</div>`);
  qTicker(box.querySelector(".qmoney"), d.revenue.total);
  // What's been celebrated stays celebrated: new hits, completions and achievements animate once.
  setTimeout(() => {
    qmark("hits", (d.main?.bosses ?? []).flatMap((b) => b.hits.map((h) => h.id)));
    qmark("done", d.quests.items.filter((q) => q.state === "done").map((q) => q.id));
    qmark("ach", d.achievements.filter((a) => a.at).map((a) => a.id));
  }, 2600);
}
function qTicker(el, to) {
  if (!el) return;
  const from = S.qb.lastRevenue ?? (qreduced() ? to : 0);
  S.qb.lastRevenue = to;
  if (from === to || qreduced()) { el.textContent = qmoney(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = qmoney(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
