"use strict";
// Project page: the detail card, milestones, the page itself and the projects index.
/** The detail card for what was tapped: a floating card on a desktop, a bottom sheet on a phone. */
function jgCard(host) {
  host.querySelector(".jcard")?.remove();
  const c = S.jp.card, g = host._jg;
  if (!c || !g) return;
  const j = g.j;
  let html = "";
  const evHTML = (e) => {
    const link = e.link ?? {};
    const acts = [
      link.session ? `<button class="btn primary" data-jsess="${esc(link.session)}">${J_ICON.chat}Open the session</button>` : "",
      link.commit ? (j.now.github ? `<a class="btn" href="https://github.com/${esc(j.now.github)}/commit/${esc(link.commit)}" target="_blank" rel="noopener">${J_ICON.git}${esc(link.commit.slice(0, 7))} ↗</a>` : `<button class="btn" data-jcopy="${esc(link.commit)}">${J_ICON.git}${esc(link.commit.slice(0, 7))}</button>`) : "",
      link.wiki ? `<a class="btn fpath" data-path="wiki:${esc(link.wiki === "log" ? "log" : link.wiki)}">${J_ICON.doc}Wiki</a>` : "",
      link.file ? `<a class="btn fpath" data-path="${esc(link.file)}">${J_ICON.doc}Open the file</a>` : "",
      link.url ? `<a class="btn" href="${esc(link.url)}" target="_blank" rel="noopener">Open ↗</a>` : "",
    ].filter(Boolean).join("");
    const lane = e.lane && j.quests.find((q) => q.id === e.lane);
    return `<div class="jck ${esc(e.kind)}"><span>${esc(J_KIND[e.kind] ?? e.kind)}${e.n && e.kind === "session" ? ` · ${e.n} prompt${e.n === 1 ? "" : "s"}` : ""}${lane ? ` · side quest “${esc(lane.label)}”` : ""}</span><time>${esc(jdate(e.t))}${e.end && e.end - e.t > 60_000 ? ` → ${esc(e.end - e.t > JDAY ? jdate(e.end) : when(e.end))}` : ""}</time></div>
      <h4>${esc(e.title)}</h4>${e.detail ? `<p>${esc(e.detail)}</p>` : ""}${e.items?.length > 1 ? `<ul>${e.items.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join("")}${e.items.length > 8 ? `<li class="hint">and ${e.items.length - 8} more</li>` : ""}</ul>` : ""}${acts ? `<div class="jca">${acts}</div>` : ""}`;
  };
  if (c.kind === "cl") {
    const cl = g.clusters?.[c.ci];
    if (!cl) return;
    const items = cl.items.map((x) => x.e);
    if (c.pick != null && items[c.pick]) html = evHTML(items[c.pick]) + (items.length > 1 ? `<button class="btn ghost jback" data-jpick="-1">← ${items.length} events here</button>` : "");
    else if (items.length === 1) html = evHTML(items[0]);
    else html = `<div class="jck"><span>${items.length} events</span><time>${esc(jdate(items[0].t))}${items.at(-1).t - items[0].t > JDAY ? ` – ${esc(jdate(items.at(-1).t))}` : ""}</time></div><ol class="jlist">${items.slice(0, 40).map((e, i) => `<li><button data-jpick="${i}"><i class="k ${esc(e.kind)}"></i><span>${esc(e.title)}</span><small>${esc(J_KIND[e.kind] ?? e.kind)}</small></button></li>`).join("")}</ol>${items.length > 40 ? `<p class="hint">and ${items.length - 40} more: zoom in</p>` : ""}<div class="jca"><button class="btn" data-jzoomhere="1">${J_ICON.plus}Zoom in here</button></div>`;
  } else if (c.kind === "turn") {
    const t = j.turns.find((x) => x.event === c.id);
    const e = j.events.find((x) => x.id === c.id);
    if (!t) return;
    html = `<div class="jck turn"><span>${J_ICON.turn} A turn</span><time>${esc(jdate(t.t))}</time></div><h4>${esc(t.label)}</h4>${t.why ? `<p>${esc(t.why)}</p>` : ""}${e ? `<div class="jsub">${evHTML(e)}</div>` : ""}`;
  } else if (c.kind === "quest") {
    const q = j.quests.find((x) => x.id === c.id);
    if (!q) return;
    html = `<div class="jck quest"><span>${J_ICON.branch} ${q.kind === "spinoff" ? "Spin-off" : "Side quest"} · ${esc(q.status)}</span><time>${esc(jdate(q.from))}${q.to - q.from > JDAY ? ` – ${esc(jdate(q.to))}` : ""}</time></div><h4>${esc(q.label)}</h4>
      <p>${[q.branch ? `branch <code>${esc(q.branch)}</code>` : "", q.commits ? `${q.commits} commit${q.commits === 1 ? "" : "s"}` : "", q.sessions.length ? `${q.sessions.length} session${q.sessions.length === 1 ? "" : "s"}` : "", q.note ? esc(q.note) : ""].filter(Boolean).join(" · ")}</p>
      ${q.subjects?.length ? `<ul>${q.subjects.slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${q.kind === "spinoff" && q.branch ? `<div class="jca"><button class="btn" data-jopen="${esc(q.branch)}">${J_ICON.journey}Its own journey</button></div>` : ""}`;
  } else if (c.kind === "ms") {
    const m = j.milestones.find((x) => x.id === c.id);
    if (!m) return;
    html = `<div class="jck ms"><span>${m.state === "unlocked" ? `${J_ICON.trophy} Unlocked` : m.state === "progress" ? "In progress" : `${J_ICON.lock} Locked`}</span><time>${m.at ? esc(jdate(m.at)) : ""}</time></div><h4>${esc(m.title)}</h4><p>${esc(m.metric)}: ${m.value != null ? `${jnum(m.value)} / ` : ""}${jnum(m.target)} ${esc(m.unit)}</p>${m.evidence ? `<p class="ev">${esc(m.evidence)}</p>` : ""}`;
  } else if (c.kind === "origin") {
    const o = j.origin ?? {};
    html = `<div class="jck origin"><span>${J_ICON.spark} Origin</span><time>${esc(jdate(o.t))}</time></div>${o.idea ? `<blockquote>${esc(o.idea.slice(0, 420))}</blockquote>` : ""}<div class="jca">${o.session?.session ? `<button class="btn primary" data-jsess="${esc(o.session.session)}">${J_ICON.chat}The first session</button>` : ""}${o.commit ? `<span class="hint">First commit: ${esc(o.commit.subject)}</span>` : ""}</div>`;
  }
  const el = document.createElement("div");
  el.className = "jcard";
  el.innerHTML = `<button class="jcx" data-jclose aria-label="Close">${ICON.x}</button>${html}`;
  host.append(el);
  if (!g.vert) {
    const W = host.clientWidth;
    const w = Math.min(360, W - 24);
    el.style.width = `${w}px`;
    el.style.left = `${Math.round(Math.max(12, Math.min(W - w - 12, c.at.x - w / 2)))}px`;
    el.style.top = `${Math.round(c.at.y > 200 ? 14 : Math.min(c.at.y + 22, 200))}px`;
  }
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest("[data-jclose]")) { S.jp.card = null; el.remove(); jgDraw(host); return; }
    const pick = e.target.closest("[data-jpick]");
    if (pick) { const i = Number(pick.dataset.jpick); S.jp.card = { ...c, pick: i < 0 ? undefined : i }; jgCard(host); return; }
    if (e.target.closest("[data-jzoomhere]")) { const cl = g.clusters[c.ci]; const a = cl.sa / cl.w; S.jp.card = null; el.remove(); host._zoomAt(g.vert ? a : a, 3.5); return; }
    const cp = e.target.closest("[data-jcopy]");
    if (cp) return copy(cp.dataset.jcopy, "commit id");
    const s = e.target.closest("[data-jsess]");
    if (s) return jOpenSession(s.dataset.jsess);
    const op = e.target.closest("[data-jopen]");
    if (op) return openJourney(op.dataset.jopen);
  });
}
/** A session from the page: live ones open in the deck, past ones through History (any machine). */
function jOpenSession(key) {
  if (!key) return;
  if (S.rows.has(key)) { setMode(null); select(key, { open: true, scroll: true }); return; }
  openHist(key);
}

// ── the page ────────────────────────────────────────────────────────────────
function jSpark(series, w = 132, h = 34, color = "currentColor") {
  const s = (series ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (s.length < 2) return `<svg class="jspark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="M0 ${h - 2} H${w}" stroke="var(--line-2)" stroke-dasharray="3 3"/></svg>`;
  const t0 = s[0][0], t1 = s.at(-1)[0] || t0 + 1, v0 = Math.min(0, ...s.map((p) => p[1])), v1 = Math.max(...s.map((p) => p[1])) || 1;
  const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 4) + 2, Y = (v) => h - 3 - ((v - v0) / Math.max(1e-9, v1 - v0)) * (h - 8);
  const d = s.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("");
  return `<svg class="jspark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path class="a" d="${d}L${X(t1).toFixed(1)} ${h}L${X(t0).toFixed(1)} ${h}Z" style="fill:${color}"/><path d="${d}" style="stroke:${color}"/><circle cx="${X(s.at(-1)[0]).toFixed(1)}" cy="${Y(s.at(-1)[1]).toFixed(1)}" r="2.4" style="fill:${color}"/></svg>`;
}
function jWeeksSpark(weeks, commits, w = 220, h = 40, color) {
  const n = Math.max(weeks?.length ?? 0, commits?.length ?? 0);
  if (!n) return "";
  const v = Array.from({ length: n }, (_, i) => (weeks?.[i] ?? 0) * 3 + (commits?.[i] ?? 0));
  const max = Math.max(1, ...v);
  const X = (i) => (i / (n - 1)) * (w - 4) + 2, Y = (x) => h - 3 - Math.sqrt(x / max) * (h - 8);
  let d = `M${X(0)} ${Y(v[0])}`;
  for (let i = 1; i < n; i++) { const xm = (X(i - 1) + X(i)) / 2; d += ` C${xm.toFixed(1)} ${Y(v[i - 1]).toFixed(1)} ${xm.toFixed(1)} ${Y(v[i]).toFixed(1)} ${X(i).toFixed(1)} ${Y(v[i]).toFixed(1)}`; }
  return `<svg class="jspark wk" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="a" d="${d} L${X(n - 1)} ${h} L${X(0)} ${h}Z" style="fill:${color}"/><path d="${d}" style="stroke:${color}"/>${v[n - 1] ? `<circle cx="${X(n - 1)}" cy="${Y(v[n - 1]).toFixed(1)}" r="2.6" style="fill:${color}"/>` : ""}</svg>`;
}
function jStageRing(j) {
  const n = j.milestones.length || 1, u = j.counts.unlocked;
  const partial = j.milestones.filter((m) => m.state === "progress").reduce((a, m) => a + (m.pct ?? 0), 0);
  const p = Math.min(1, (u + partial * 0.999) / n);
  const R = 42, C = 2 * Math.PI * R;
  return `<svg class="jring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${R}" class="bg"/><circle cx="50" cy="50" r="${R}" class="fg" style="stroke:${jhue(j.project)};stroke-dasharray:${(C * p).toFixed(1)} ${C.toFixed(1)}"/>${j.milestones.map((m, i) => { const a = (i / n) * 2 * Math.PI - Math.PI / 2; return `<circle cx="${(50 + R * Math.cos(a)).toFixed(1)}" cy="${(50 + R * Math.sin(a)).toFixed(1)}" r="2.6" class="tick ${m.state}"/>`; }).join("")}</svg>`;
}
function jMilestoneCard(j, m, i) {
  const seen = load(`jseen:${j.project}`, []);
  const fresh = m.state === "unlocked" && !seen.includes(m.id);
  const isNext = j.next.includes(m.id);
  const pct = Math.round((m.pct ?? 0) * 100);
  const src = m.source.startsWith("manual.") ? "you log it" : m.source.split(".")[0];
  return `<article class="jm ${m.state}${isNext ? " next" : ""}${fresh ? " fresh" : ""}" data-jmid="${esc(m.id)}" style="--i:${i}">
    <div class="jmi">${m.state === "unlocked" ? J_ICON.trophy : m.state === "progress" ? `<span class="jmp" style="--p:${pct}">${pct}%</span>` : J_ICON.lock}</div>
    <div class="jmb"><b>${esc(m.title)}</b><span class="jmm">${m.metric === "Done" ? "A moment you mark" : `${esc(m.metric)} · ${jnum(m.target)}${m.unit && m.unit !== "$" ? ` ${esc(m.unit)}` : ""}${m.unit === "$" ? " $" : ""}`}</span>
      <div class="jbar"><i style="width:${m.state === "unlocked" ? 100 : pct}%"></i></div>
      <span class="jme">${m.state === "unlocked" ? `${m.at ? `Unlocked ${esc(jdate(m.at))}` : "Unlocked"}${m.manual ? " · by you" : ""}` : m.value != null ? `${jnum(m.value)} of ${jnum(m.target)}` : m.metric === "Done" ? "Not yet" : "Not measured yet"}<em>${esc(m.metric === "Done" ? "you mark it" : src)}</em></span>
      ${m.evidence && (m.value != null || m.state === "unlocked") ? `<span class="jmev" title="${esc(m.evidence)}">${esc(m.evidence)}</span>` : ""}
      <span class="jmacts">${m.state === "unlocked" ? (m.manual ? `<button class="link" data-jundo="${esc(m.id)}">Undo</button>` : "") : `${m.source.startsWith("manual.") && m.metric !== "Done" ? `<button class="link" data-jlog="${esc(m.source.slice(7))}">Log ${esc(m.metric.toLowerCase())}</button>` : ""}<button class="link" data-junlock="${esc(m.id)}">Mark unlocked…</button>`}</span>
    </div>${isNext && m.state !== "unlocked" ? '<span class="jnext">next</span>' : ""}</article>`;
}
function jHome(j) {
  const h = projectHome(j.project);
  if (h) return h;
  if (j.root) return { machine: S.self, cwd: j.root, project: j.project };
  return null;
}
function jPlanPrompt(j) {
  const m = j.milestones.find((x) => x.id === j.next[0]) ?? j.milestones.find((x) => x.state !== "unlocked");
  const ahead = j.next.map((id) => j.milestones.find((x) => x.id === id)).filter(Boolean).map((x) => `“${x.title}”`).join(", ");
  return m ? `Read ~/wiki/projects/${j.project}.md (if it exists) and this repo's README for context. The next milestone for ${j.project} is “${m.title}” (${m.metric}: target ${m.target}${m.unit ? ` ${m.unit}` : ""}; now ${m.value ?? "not measured"}; measured by ${m.source}).${ahead ? ` After it: ${ahead}.` : ""}${j.heading?.direction ? ` Where it seems to be heading: ${j.heading.direction}` : ""}

Plan the smallest path to unlock it: what to build or do, how we'll know it happened (the evidence), risks, and the first three tasks. Write the plan to ~/.config/herdr-deck/ideas/${j.project}-${m.id}.md, then stop and wait for my go before changing anything.` : `Read ~/wiki/projects/${j.project}.md for context and propose the next milestone for ${j.project}, with a plan and the first three tasks. Don't change anything yet.`;
}

function renderJourney(fresh) {
  const name = S.jp.name;
  const j = S.jp.data.get(name);
  if (!j && !S.jp.loading.has(name)) loadJourney(name);
  if (!j || j.error) {
    modeHTML(`<div class="jpage"><header class="jhero skel"><div class="jh-l"><p class="jcrumb"><button class="link" data-jidx>${J_ICON.grid} Projects</button></p><h2>${esc(name ?? "")}</h2><p class="jpitch">${j?.error ? esc(j.error) : '<span class="spin"></span> Reading its history: git, the wiki, every session…'}</p></div></header><div class="jgwrap skel"></div></div>`);
    return;
  }
  // Re-render only when the journey itself changed; live bits (who's working) are patched in place, so the graph
  // and the animations don't restart on every deck update.
  const box = $("dbody");
  const sig = [j.project, j.builtAt, j.ai?.at, j.ai?.state, !!j.pending, isPhone(), S.jp.allSessions, S.jp.allQuests].join("|");
  if (!fresh && box._mode === "project" && box._jsig === sig && box.querySelector(".jpage")) return jPatchLive(j);
  const calm = S.jp.shown?.has(j.project);
  (S.jp.shown ??= new Set()).add(j.project);
  const pcol = jhue(j.project);
  const live = (j.now.live ?? []).map((l) => ({ ...l, status: S.rows.get(l.key)?.status ?? l.status }));
  const working = live.filter((l) => l.status === "working").length;
  const M = new Map(j.metrics.map((m) => [m.key, m]));
  const nums = [
    ["Commits", M.get("git.commits")?.value, "git.commits"], ["Sessions", j.counts.sessions, "sessions.count"], ["Agent hours", M.get("sessions.agent_hours")?.value, "sessions.agent_hours"],
    ["Active days", M.get("git.active_days")?.value, "git.active_days"], ["Turns", j.turns.length], ["Side quests", j.quests.length],
  ].filter(([, v]) => v != null);
  const next = j.milestones.find((m) => m.id === j.next[0]);
  const days = j.origin?.t ? jdays(j.origin.t, j.now.t) : 0;
  const status = j.status ?? "active";
  const ai = j.ai ?? {};
  const aiLine = ai.state === "running" ? `<span class="spin"></span> Reading the journey with ${ai.source === "ollama" ? "a local model" : "Claude"}…` : ai.source ? `${ai.source === "rules" ? "Simple rules" : `${esc(ai.source === "claude" ? "Claude" : "Ollama")}${ai.model ? ` ${esc(ai.model)}` : ""}`} · ${esc(when(ai.at))}${ai.note ? ` · ${esc(ai.note)}` : ""}` : "Not read yet";
  const sessions = j.events.filter((e) => e.kind === "session").slice().sort((a, b) => (b.end ?? b.t) - (a.end ?? a.t));
  const liveKeys = new Set(live.map((l) => l.key));
  const quests = j.quests.slice().sort((a, b) => b.to - a.to);
  const metricTiles = j.metrics.filter((m) => m.value || m.series?.length > 1 || m.key.startsWith("manual.")).map((m) => `<div class="jmt"><span>${esc(m.label)}</span><b>${jnum(m.value)}${m.unit === "$" ? " $" : ""}</b>${jSpark(m.series, 132, 34, m.key.startsWith("manual.") ? "var(--jgold)" : pcol)}<small title="${esc(m.evidence)}">${esc(m.evidence)}</small></div>`).join("");
  const showAllS = S.jp.allSessions === j.project;
  const html = `<div class="jpage${calm ? " calm" : ""}" style="--pc:${pcol}">
    <header class="jhero">
      <div class="jh-l">
        <p class="jcrumb"><button class="link" data-jidx>${J_ICON.grid} Projects</button><span>/</span><span class="jstat ${esc(status)}">${esc(status)}</span><span class="jnat">${esc(j.nature.replace("-", " "))}</span><span id="jliveChip">${jLiveChip(working, live.length)}</span></p>
        <h2><span class="jsw"></span>${esc(j.project)}</h2>
        <p class="jpitch">${esc(j.pitch || j.tldr || "")}</p>
        <div class="jnums">${nums.map(([l, v]) => `<div><b>${jnum(v)}</b><span>${l}</span></div>`).join("")}${days ? `<div><b>${jnum(days)}</b><span>Days since origin</span></div>` : ""}</div>
        <div class="jacts">
          <button class="btn primary" data-jact="start">${J_ICON.play}Start a session here</button>
          <button class="btn" data-jact="plan">${J_ICON.flag}Plan the next milestone</button>
          <button class="btn" data-jact="log">${J_ICON.plus}Log a metric</button>
          <button class="btn ghost" data-jact="regen" ${ai.state === "running" ? "disabled" : ""}>${J_ICON.refresh}Regenerate</button>
          ${j.wikiPage ? `<a class="btn ghost fpath" data-path="wiki:${esc(j.wikiPage)}">${J_ICON.doc}Wiki</a>` : ""}
        </div>
      </div>
      <div class="jh-r">
        <div class="jstage">${jStageRing(j)}<div class="jst-t"><small>Stage</small><b>${j.stage ? esc(j.stage.title) : "Just starting"}</b><span>${j.counts.unlocked} of ${j.counts.milestones} unlocked</span></div></div>
        ${next ? `<div class="jnextc"><small>Next milestone</small><b>${esc(next.title)}</b><div class="jbar"><i style="width:${Math.round((next.pct ?? 0) * 100)}%"></i></div><span>${next.value != null ? `${jnum(next.value)} of ${jnum(next.target)} ${esc(next.unit)}` : "not measured yet"}</span></div>` : ""}
      </div>
    </header>
    <section class="jgwrap"><div class="jghead"><h3>${J_ICON.journey}The journey</h3><span class="jlegend"><i class="cm"></i>commits<i class="se"></i>sessions<i class="nt"></i>notes<i class="tn"></i>turns<i class="fl"></i>milestones<i class="qq"></i>side quests</span><span class="hint jhint">${isPhone() ? "Pinch to zoom · tap a point" : "Drag to pan · ⌘/ctrl + scroll or pinch to zoom · click a point"}</span></div><div class="jg-host" id="jgHost"></div></section>
    <section class="jsec jms"><div class="jsh"><h3>${J_ICON.trophy}Milestones</h3><span class="hint">${j.counts.unlocked} unlocked · the ladder is written for this project by ${ai.source === "rules" || !ai.source ? "simple rules" : "AI"}, and unlocks only from evidence</span></div>
      <div class="jladder">${j.milestones.map((m, i) => jMilestoneCard(j, m, i)).join("")}</div></section>
    <div class="jcolz">
      <section class="jsec"><h3>${J_ICON.spark}Original idea</h3>
        ${j.origin?.summary ? `<p class="jidea">${esc(j.origin.summary)}</p>` : ""}
        ${j.origin?.idea ? `<blockquote class="jq1">${esc(j.origin.idea)}</blockquote>` : '<p class="hint">No first prompt or note found.</p>'}
        <p class="jmeta">${j.origin?.t ? `${esc(jdate(j.origin.t))} · ` : ""}${j.origin?.ideaFrom === "session" ? `your first message${j.origin.session?.session ? ` in <button class="link" data-jsess="${esc(j.origin.session.session)}">“${esc(j.origin.session.title ?? "the first session")}”</button>` : ""}` : j.origin?.ideaFrom === "wiki" ? "from the wiki page" : j.origin?.ideaFrom === "git" ? "the first commit" : ""}${j.origin?.commit ? ` · first commit “${esc(j.origin.commit.subject)}”` : ""}${j.origin?.parent ? ` · grew out of <a class="fpath" data-path="wiki:${esc(j.origin.parent)}">${esc(j.origin.parent)}</a>` : ""}</p>
      </section>
      <section class="jsec"><h3>${J_ICON.chat}Story so far</h3>${j.story ? `<p class="jstory">${esc(j.story)}</p>` : '<p class="hint">Not written yet.</p>'}<p class="jmeta">${aiLine}</p></section>
      <section class="jsec"><h3>${J_ICON.turn}Where it’s heading</h3>${j.heading?.direction ? `<p class="jdir">${esc(j.heading.direction)}</p>` : ""}
        <div class="jnext3">${j.next.map((id) => j.milestones.find((m) => m.id === id)).filter(Boolean).map((m) => `<div class="jn"><b>${esc(m.title)}</b><div class="jbar"><i style="width:${Math.round((m.pct ?? 0) * 100)}%"></i></div><small>${m.value != null ? `${jnum(m.value)} / ${jnum(m.target)} ${esc(m.unit)}` : "not measured yet"}</small></div>`).join("") || '<p class="hint">Everything on the ladder is unlocked. Regenerate for a new one.</p>'}</div>
        ${j.turns.length ? `<ol class="jturns">${j.turns.map((t) => `<li><time>${esc(jd10(t.t))}</time><b>${esc(t.label)}</b>${t.why ? `<span>${esc(t.why)}</span>` : ""}</li>`).join("")}</ol>` : ""}
      </section>
      <section class="jsec"><h3>${J_ICON.branch}Side quests <span class="n">${j.quests.length}</span></h3>
        ${quests.length ? `<ul class="jquests">${quests.slice(0, S.jp.allQuests === j.project ? 200 : 8).map((q) => `<li class="${esc(q.status)}"><i style="background:${q.kind === "spinoff" ? "var(--jgold)" : q.status === "abandoned" ? "var(--ink-3)" : jhue(j.project, 3)}"></i><div><b>${esc(q.label)}</b><small>${esc(q.kind === "spinoff" ? "spin-off" : q.status)} · ${esc(jdate(q.from))}${q.to - q.from > JDAY ? ` – ${esc(jdate(q.to))}` : ""}${q.commits ? ` · ${q.commits} commit${q.commits === 1 ? "" : "s"}` : ""}${q.sessions.length ? ` · ${q.sessions.length} session${q.sessions.length === 1 ? "" : "s"}` : ""}</small></div>${q.kind === "spinoff" && q.branch ? `<button class="link" data-jopen="${esc(q.branch)}">open</button>` : ""}</li>`).join("")}</ul>${quests.length > 8 && S.jp.allQuests !== j.project ? `<button class="link" data-jallq>Show all ${quests.length}</button>` : ""}` : '<p class="hint">No branches, worktrees or spin-offs off the main line.</p>'}
      </section>
    </div>
    <section class="jsec"><div class="jsh"><h3>${J_ICON.chat}Sessions <span class="n">${sessions.length}</span></h3>${live.length ? `<span class="hint">${live.length} open now</span>` : ""}<span class="spacer"></span><button class="link" data-jhist>Search them in History</button></div>
      <ul class="jsess">${sessions.slice(0, showAllS ? 400 : 10).map((e) => { const k = e.link?.session; const r = S.rows.get(k); const st = r?.status; const lane = e.lane && j.quests.find((q) => q.id === e.lane); return `<li><button data-jsess="${esc(k ?? "")}"><span class="dot" style="--c:${st ? statusVar(st) : "var(--line-2)"}"></span><span class="t">${esc(e.title)}</span><small>${esc(jdate(e.t))}${e.n ? ` · ${e.n} prompt${e.n === 1 ? "" : "s"}` : ""}${lane ? ` · ${esc(lane.label)}` : ""}${e.link?.machine && multiMachine() ? ` · ${esc(machineLabel(e.link.machine))}` : ""}${liveKeys.has(k) ? ` · <b>${esc(STATUS_NAME[st] ?? "open")}</b>` : ""}</small></button></li>`; }).join("")}</ul>
      ${sessions.length > 10 && !showAllS ? `<button class="link" data-jalls>Show all ${sessions.length}</button>` : ""}
    </section>
    <section class="jsec"><h3>${J_ICON.grid}Metrics</h3><div class="jmetrics">${metricTiles || '<p class="hint">Nothing measured yet. Log a metric.</p>'}</div></section>
    <footer class="jfooter">Built from ${[j.sources.git ? `git${j.now.github ? ` (${esc(j.now.github)})` : ""}${j.now.branch ? ` on <code>${esc(j.now.branch)}</code>` : ""}${j.now.dirty ? `, ${j.now.dirty} uncommitted` : ""}` : "", j.sources.wiki ? "the wiki page" : "", `${j.sources.sessions} session${j.sources.sessions === 1 ? "" : "s"}${j.sources.machines.length ? ` on ${j.sources.machines.map((m) => esc(machineLabel(m))).join(", ")}` : ""}`, j.sources.notes ? `${j.sources.notes} saved plan${j.sources.notes === 1 ? "" : "s"}/leads` : "", j.sources.github ? `GitHub: ${esc(j.sources.github)}` : "", j.sources.gumroad ? `Gumroad: ${esc(j.sources.gumroad)}` : ""].filter(Boolean).join(" · ")}. Updated ${esc(when(j.builtAt))}${j.pending ? ' · <span class="spin"></span> refreshing' : ""}.</footer>
  </div>`;
  modeHTML(html);
  box._jsig = sig;
  const host = $("dbody").querySelector("#jgHost");
  if (host && (!host._jg || host._jg.j !== j || host._jg.vert !== isPhone())) { jgMount(host, j); if (S.jp.card) jgCard(host); }
  // First sight of an unlock: the card plays its animation once, then it's remembered.
  const fresh2 = j.milestones.filter((m) => m.state === "unlocked").map((m) => m.id);
  if (fresh2.some((id) => !load(`jseen:${j.project}`, []).includes(id))) setTimeout(() => store(`jseen:${j.project}`, fresh2), 2600);
}

const jLiveChip = (working, open) => (working ? `<span class="jlive"><span class="spin"></span>${working} working now</span>` : open ? `<span class="jlive idle">${open} open session${open === 1 ? "" : "s"}</span>` : "");
/** Who's working right now, without touching the rest of the page. */
function jPatchLive(j) {
  const box = $("dbody");
  const live = (j.now.live ?? []).map((l) => S.rows.get(l.key)?.status ?? l.status);
  const chip = box.querySelector("#jliveChip");
  if (chip) setHTML(chip, jLiveChip(live.filter((x) => x === "working").length, live.length));
  for (const b of box.querySelectorAll(".jsess [data-jsess]")) { const st = S.rows.get(b.dataset.jsess)?.status; b.querySelector(".dot")?.style.setProperty("--c", st ? statusVar(st) : "var(--line-2)"); }
}
function renderProjects() {
  const d = S.jp.idx;
  if (!d) { modeHTML(`<header class="vh"><h2>${J_ICON.grid}Projects</h2><p><span class="spin"></span> Gathering every project…</p></header>`); return; }
  const q = S.jp.q.trim().toLowerCase();
  const list = (d.projects ?? []).filter((p) => !q || `${p.project} ${p.tldr ?? ""} ${(p.tags ?? []).join(" ")} ${p.status ?? ""}`.toLowerCase().includes(q));
  const shown = S.jp.all || q ? list : list.slice(0, 48);
  const card = (p, i) => {
    const col = jhue(p.project);
    const working = S.rows.size ? [...S.rows.values()].filter((r) => r.project === p.project && r.status === "working").length : p.working;
    return `<button class="jpc" data-jopen="${esc(p.project)}" style="--pc:${col};--i:${Math.min(i, 24)}">
      <span class="jpc-h"><span class="jsw"></span><b>${esc(p.project)}</b>${p.status ? `<span class="jstat ${esc(p.status)}">${esc(p.status)}</span>` : ""}${working ? `<span class="jlive"><span class="spin"></span>${working}</span>` : p.live ? `<span class="jlive idle">${p.live} open</span>` : ""}</span>
      <span class="jpc-p">${esc(p.pitch || p.tldr || (p.root ? home(p.root) : ""))}</span>
      ${jWeeksSpark(p.weeks, p.commitWeeks, 220, 40, col)}
      <span class="jpc-f">${p.next ? `<span class="jpc-n">${J_ICON.flag}<span>${esc(p.next.title)}</span><span class="jbar"><i style="width:${Math.round((p.next.pct ?? 0) * 100)}%"></i></span></span>` : p.stage ? `<span class="jpc-n">${J_ICON.trophy}${esc(p.stage)}</span>` : `<span class="hint">${p.sessions ? `${p.sessions} session${p.sessions === 1 ? "" : "s"}` : p.root ? "git repo" : p.wiki ? "wiki page" : p.live ? "open now" : ""}</span>`}<span class="jpc-a">${p.last ? esc(agoText(p.last)) : ""}</span></span>
    </button>`;
  };
  modeHTML(`<header class="vh jvh"><h2>${J_ICON.grid}Projects</h2><p>Every project as a journey: where it started, the turns it took, and the milestones ahead. Open one to see its whole story.</p>
    <div class="jsearch"><input class="inp" id="jpq" type="search" placeholder="Filter ${d.projects?.length ?? 0} projects" value="${esc(S.jp.q)}" autocomplete="off"></div></header>
    <div class="jpgrid">${shown.map(card).join("") || '<p class="hint">No project matches.</p>'}</div>
    ${list.length > shown.length ? `<p style="text-align:center"><button class="btn" data-jallp>Show all ${list.length}</button></p>` : ""}`);
}

$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "project" && S.mode !== "projects") return;
  const t = e.target;
  if (t.closest(".jg-host")) return; // the graph handles its own clicks
  const open = t.closest("[data-jopen]");
  if (open) return openJourney(open.dataset.jopen);
  if (t.closest("[data-jidx]")) return openProjects();
  if (t.closest("[data-jallp]")) { S.jp.all = true; return renderProjects(); }
  const j = S.jp.data.get(S.jp.name);
  if (!j || S.mode !== "project") return;
  const sess = t.closest("[data-jsess]");
  if (sess) return jOpenSession(sess.dataset.jsess);
  if (t.closest("[data-jalls]")) { S.jp.allSessions = j.project; return renderJourney(); }
  if (t.closest("[data-jallq]")) { S.jp.allQuests = j.project; return renderJourney(); }
  if (t.closest("[data-jhist]")) { S.hq = j.project; setMode("history"); const q = $("dbody").querySelector(".view input[type=search], .view .inp"); if (q) { q.value = j.project; q.dispatchEvent(new Event("input", { bubbles: true })); } return; }
  const log = t.closest("[data-jlog]");
  if (log) return jLogDialog(j, log.dataset.jlog);
  const un = t.closest("[data-junlock]");
  if (un) {
    const m = j.milestones.find((x) => x.id === un.dataset.junlock);
    const note = await askDialog({ title: `Mark “${m?.title}” unlocked`, text: "What happened? Your note is the evidence shown on the milestone.", input: "", ok: "Unlock it", multiline: true });
    if (!note || !String(note).trim()) return;
    try { const r = await api("/api/journey/unlock", { project: j.project, id: un.dataset.junlock, note: String(note) }); S.jp.data.set(j.project, r); renderJourney(true); toast(`Unlocked “${m?.title}”`); } catch (err) { toast(err.message, true); }
    return;
  }
  const undo = t.closest("[data-jundo]");
  if (undo) { try { const r = await api("/api/journey/unlock", { project: j.project, id: undo.dataset.jundo, undo: true }); S.jp.data.set(j.project, r); renderJourney(true); } catch (err) { toast(err.message, true); } return; }
  const act = t.closest("[data-jact]")?.dataset.jact;
  if (!act) return;
  if (act === "start" || act === "plan") {
    const h = jHome(j);
    if (!h) return toast(`${j.project}’s folder isn’t on this machine`, true);
    const next = j.milestones.find((x) => x.id === j.next[0]);
    return openNew(act === "start" ? { ...h, title: `New session in ${j.project}` } : { ...h, kind: "claude", prompt: jPlanPrompt(j), label: `plan ${next?.title ?? "next milestone"}`.slice(0, 40), title: `Plan the next milestone${next ? `: ${next.title}` : ""}` });
  }
  if (act === "log") return jLogDialog(j);
  if (act === "regen") { toast("Reading the journey again…"); S.jp.polls = 0; return loadJourney(j.project, { regen: true, force: true }); }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode === "projects" && e.target.id === "jpq") { S.jp.q = e.target.value; const pos = e.target.selectionStart; renderProjects(); const el = $("jpq"); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
});
function jLogDialog(j, metric = "") {
  const names = [...new Set([...j.milestones.filter((m) => m.source.startsWith("manual.")).map((m) => m.source.slice(7)), ...j.metrics.filter((m) => m.key.startsWith("manual.")).map((m) => m.key.slice(7)), "users", "paying_customers", "mrr", "dau", "views", "downloads_month"])];
  const d = document.createElement("dialog");
  d.className = "dlg jlogd";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Log a metric for ${esc(j.project)}</h3><p class="hint">A reading on a date (users on that day, revenue that month…). Milestones measured by it unlock when a reading reaches their target.</p>
    <label class="jf"><span>Metric</span><input class="inp" name="metric" list="jmlist" value="${esc(metric)}" placeholder="users" required pattern="[A-Za-z][A-Za-z0-9 _-]{1,30}"><datalist id="jmlist">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></label>
    <div class="jf2"><label class="jf"><span>Value</span><input class="inp" name="value" type="number" step="any" required inputmode="decimal"></label><label class="jf"><span>Date</span><input class="inp" name="at" type="date" value="${jd10(Date.now())}"></label></div>
    <label class="jf"><span>Note (optional)</span><input class="inp" name="note" placeholder="Where the number came from"></label></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Log it</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const f = d.querySelector("form");
    const ok = d.returnValue === "ok";
    const data = Object.fromEntries(new FormData(f));
    d.remove();
    if (!ok) return;
    try {
      const r = await api("/api/journey/metric", { project: j.project, metric: data.metric, value: Number(data.value), at: data.at ? new Date(`${data.at}T12:00:00`).getTime() : undefined, note: data.note });
      S.jp.data.set(j.project, r); renderJourney(true); toast(`Logged ${data.metric} = ${data.value}`);
    } catch (err) { toast(err.message, true); }
  });
  d.showModal();
  (metric ? d.querySelector("[name=value]") : d.querySelector("[name=metric]")).focus();
}
// ──────────────────────────────────────────────────────────────────────────── </journey>
