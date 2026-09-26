"use strict";
// Project page: the journey graph (one inline SVG, re-laid out on pan and zoom).
/** Lays out and draws the graph into `host` for its current zoom; cheap enough to run every animation frame. */
function jgDraw(host) {
  const g = host._jg;
  if (!g) return;
  const { j, vert } = g;
  const W = host.clientWidth || 800;
  const pc0 = jhue(j.project);
  const sc = g.sc ?? (g.sc = jScale(j));
  // Along-axis geometry: horizontal = x, vertical = y. The past gets most of it; the future a fixed stretch.
  const futN = Math.min(4, j.milestones.filter((m) => m.state !== "unlocked").length);
  const A0 = vert ? 46 : 56;
  const pastLen = vert ? Math.max(620, Math.min(2600, j.events.length * 9 + 380)) : Math.max(360, W - 56 - Math.max(150, W * 0.2));
  const futLen = vert ? 70 + futN * 58 : Math.max(150, W * 0.2) - 30;
  const k = g.k, tx = g.tx;
  const along = (t) => tx + A0 + (t >= j.now.t ? pastLen * k + ((t - j.now.t) / JDAY) * 0 : sc.f(t) * pastLen * k);
  const nowA = along(j.now.t), futEnd = nowA + futLen * (vert ? 1 : Math.min(k, 1.6));
  const H = vert ? A0 + pastLen * k + futLen + 70 : 390;
  const X0 = vert ? 70 : 0, Y0 = vert ? 0 : 164; // the main line's across position
  const P = (a, c) => (vert ? [X0 + c, a] : [a, Y0 + c]); // along/across → x,y
  const r1 = (n) => Math.round(n * 10) / 10;
  const pt = (a, c) => P(a, c).map(r1).join(",");
  // Turns bend the line: each one moves it to a new offset, easing in over a short window.
  const turns = j.turns.map((t, i) => ({ ...t, a: along(t.t), off: (i % 2 ? 1 : -1) * (vert ? 10 + (i % 3) * 3 : 16 + (i % 3) * 6), i }));
  const win = vert ? 26 : 34;
  const offAt = (a) => { let o = 0; for (const t of turns) { const s = Math.max(0, Math.min(1, (a - (t.a - win)) / (2 * win))); o += (t.off - (t.i ? turns[t.i - 1].off : 0)) * (s * s * (3 - 2 * s)); } return o; };
  const vis0 = vert ? -200 : -80, vis1 = vert ? H + 200 : W + 80;
  const seen = (a) => a > vis0 && a < vis1;
  let s = "";
  // Era bands: each stretch between turns gets its own hue; subtle wash behind the line.
  const bounds = [along(sc.t0), ...turns.map((t) => t.a), nowA];
  // Time axis and squeezed gaps.
  const axisC = vert ? -X0 + 6 : 390 - 34 - Y0;
  const ticks = jTicks(sc.t0, j.now.t);
  const minGap = vert ? 30 : 64;
  const placed = sc.breaks.map((b) => (along(b.a) + along(b.b)) / 2); // ticks keep clear of the "≈ 3 d" gap marks
  let tk = "";
  for (const tkx of ticks) {
    const a = along(tkx.t);
    if (!seen(a) || a < A0 - 10 || a > nowA - 12 || placed.some((p) => Math.abs(p - a) < minGap)) continue;
    placed.push(a);
    const [x, y] = P(a, axisC);
    tk += vert ? `<text class="jtk${tkx.p <= 1 ? " maj" : ""}" x="${r1(x)}" y="${r1(y + 3)}">${esc(tkx.l)}</text>` : `<line class="jgl${tkx.p <= 1 ? " maj" : ""}" x1="${r1(x)}" y1="18" x2="${r1(x)}" y2="${r1(y - 8)}"/><text class="jtk${tkx.p <= 1 ? " maj" : ""}" x="${r1(x)}" y="${r1(y + 12)}">${esc(tkx.l)}</text>`;
  }
  for (const b of sc.breaks) {
    const a = (along(b.a) + along(b.b)) / 2;
    if (!seen(a)) continue;
    const [x, y] = P(a, vert ? -X0 + 30 : axisC);
    const gap = b.b - b.a, label = gap > 60 * JDAY ? `${Math.round(gap / (30 * JDAY))} mo` : `${Math.round(gap / JDAY)} d`;
    tk += vert ? `<text class="jbrk" x="${r1(x)}" y="${r1(y + 3)}">≈ ${label}</text>` : `<text class="jbrk" x="${r1(x)}" y="${r1(y + 12)}">≈ ${label}</text><path class="jgap" d="M${r1(x - 3)} ${r1(y - 14)} l3 -4 l3 4 l3 -4"/>`;
  }
  s += `<g class="jaxis">${tk}</g>`;
  // The main line, one segment per era, sampled so the bends are smooth.
  const step = 5;
  let line = "";
  for (let e = 0; e < bounds.length - 1; e++) {
    const a = Math.max(bounds[e], vis0), b = Math.min(bounds[e + 1], vis1);
    if (b <= a) continue;
    let d = `M${pt(a, offAt(a))}`;
    for (let x = a + step; x < b; x += step) d += `L${pt(x, offAt(x))}`;
    d += `L${pt(b, offAt(b))}`;
    line += `<path class="jline" pathLength="1" d="${d}" style="stroke:${jhue(j.project, e)};--d:${e * 140}"/>`;
  }
  // The future: dashed, from now to where it's heading.
  const fo = offAt(nowA);
  line += `<path class="jfut" d="M${pt(nowA, fo)} C${pt(nowA + (futEnd - nowA) * 0.4, fo)} ${pt(nowA + (futEnd - nowA) * 0.6, fo + (vert ? 0 : -18))} ${pt(futEnd, fo + (vert ? 0 : -18))}"/>`;
  // Side quests: lanes below the line (right of it on a phone), assigned so overlapping ones don't collide.
  const maxLanes = vert ? 4 : 5;
  const big = j.quests.slice().sort((a, b) => (b.commits + b.sessions.length * 3) - (a.commits + a.sessions.length * 3));
  const shown = big.slice(0, vert ? 6 : 10);
  const laneEnd = [];
  const qpos = new Map();
  for (const q of shown.slice().sort((a, b) => a.from - b.from)) {
    const a = along(q.from), b = Math.max(along(q.to), a + 26);
    let l = laneEnd.findIndex((e) => e < a - 18);
    if (l < 0) { if (laneEnd.length < maxLanes) l = laneEnd.length; else l = laneEnd.indexOf(Math.min(...laneEnd)); }
    laneEnd[l] = b + 40;
    qpos.set(q.id, { a, b, l, c: (vert ? 40 : 46) + l * (vert ? 15 : 20) });
  }
  let qs = "";
  const qcol = (q) => (q.kind === "spinoff" ? "var(--jgold)" : q.status === "abandoned" ? "var(--ink-3)" : jhue(j.project, 3));
  for (const q of shown) {
    const p = qpos.get(q.id);
    if (!p || (p.b < vis0 && p.a < vis0) || p.a > vis1) continue;
    const c0 = offAt(p.a) + (vert ? 14 : 16), bend = vert ? 18 : 26;
    let d = `M${pt(p.a, c0 - (vert ? 14 : 16))} C${pt(p.a + bend * 0.5, c0)} ${pt(p.a + bend * 0.4, p.c)} ${pt(p.a + bend, p.c)} L${pt(Math.max(p.a + bend, p.b), p.c)}`;
    const end = Math.max(p.a + bend, p.b);
    if (q.status === "merged") d += ` C${pt(end + bend * 0.6, p.c)} ${pt(end + bend * 0.4, offAt(end + bend))} ${pt(end + bend, offAt(end + bend))}`;
    const fade = q.status === "abandoned";
    qs += `<g class="jq ${q.status}" data-jq="${esc(q.id)}"><path class="jqp" d="${d}" style="stroke:${qcol(q)}${fade ? `;stroke:url(#jfade${vert ? "v" : "h"})` : ""}"/>`;
    if (q.status === "active") { const [x, y] = P(end, p.c); qs += `<circle class="jqend" cx="${r1(x)}" cy="${r1(y)}" r="3.4" style="fill:${qcol(q)}"/>`; }
    if (q.kind === "spinoff") { const [x, y] = P(end + 6, p.c); qs += `<path class="jqarrow" d="${vert ? `M${r1(x - 4)} ${r1(y - 4)} L${r1(x)} ${r1(y + 2)} L${r1(x + 4)} ${r1(y - 4)}` : `M${r1(x - 4)} ${r1(y - 4)} L${r1(x + 2)} ${r1(y)} L${r1(x - 4)} ${r1(y + 4)}`}" style="stroke:${qcol(q)}"/>`; }
    const [lx, ly] = P(p.a + bend + 4, p.c);
    const room = vert ? W - lx - 8 : Math.max(0, end - p.a - bend - 8);
    if (room > 40) { const lbl = q.label.length * 5.6 > room ? q.label.slice(0, Math.max(3, Math.floor(room / 5.6) - 1)) + "…" : q.label; qs += vert ? "" : `<text class="jql" x="${r1(lx)}" y="${r1(ly - 5)}">${esc(lbl)}</text>`; }
    qs += `<title>${jEsc(`${q.label} · ${q.kind === "spinoff" ? "spin-off" : q.status} · ${[q.commits ? `${q.commits} commits` : "", q.sessions.length ? `${q.sessions.length} sessions` : ""].filter(Boolean).join(", ")}`)}</title></g>`;
  }
  // Events: three tracks hugging the line (notes above, commits on it, sessions below); close ones merge into one dot.
  const clusters = [];
  const byTrack = new Map();
  for (const [i, e] of j.events.entries()) {
    let a = along(e.t);
    if (!seen(a)) continue;
    const q = e.lane && qpos.get(e.lane);
    const tr = q ? `q:${e.lane}` : String(J_TRACK[e.kind] ?? 0);
    if (!byTrack.has(tr)) byTrack.set(tr, []);
    byTrack.get(tr).push({ e, i, a, q });
  }
  const gap = vert ? 9 : 11;
  for (const [tr, list] of byTrack) {
    list.sort((x, y) => x.a - y.a);
    let cur = null;
    for (const it of list) {
      if (cur && it.a - cur.last < gap) { cur.items.push(it); cur.last = it.a; cur.w += it.e.weight || 1; cur.sa += it.a * (it.e.weight || 1); }
      else { cur = { tr, items: [it], last: it.a, w: it.e.weight || 1, sa: it.a * (it.e.weight || 1), q: it.q }; clusters.push(cur); }
    }
  }
  g.clusters = clusters;
  let dots = "";
  for (const [ci, cl] of clusters.entries()) {
    const a = cl.sa / cl.w;
    const tr = cl.tr.startsWith("q:") ? null : Number(cl.tr);
    const c = cl.q ? cl.q.c : offAt(a) + (tr ? tr * (vert ? 14 : 17) : 0);
    const [x, y] = P(a, c);
    const n = cl.items.length;
    const r = Math.max(tr === 0 ? 3.6 : 2.8, Math.min(vert ? 10 : 13, (tr === 0 ? 2.4 : 1.8) + Math.sqrt(cl.w) * (tr === 0 ? 1.15 : 0.9)));
    const kinds = new Set(cl.items.map((x) => x.e.kind));
    const top = cl.items.slice().sort((p, q) => (q.e.weight || 0) - (p.e.weight || 0))[0].e;
    const cls = kinds.has("milestone") ? "ms" : kinds.has("release") || kinds.has("tag") || kinds.has("deploy") ? "rel" : top.kind === "merge" ? "mg" : tr === 1 || cl.q ? "se" : tr === -1 ? "nt" : "cm";
    const live = cl.items.some((x) => x.e.kind === "session" && S.rows.get(x.e.link?.session)?.status === "working");
    const d = Math.round(((a - A0) / Math.max(1, nowA - A0)) * 900);
    const shape = cls === "rel" ? `<path d="M${r1(x)} ${r1(y - r - 1.5)} L${r1(x + r + 1.5)} ${r1(y)} L${r1(x)} ${r1(y + r + 1.5)} L${r1(x - r - 1.5)} ${r1(y)}Z"/>`
      : cls === "nt" ? `<rect x="${r1(x - r)}" y="${r1(y - r)}" width="${r1(2 * r)}" height="${r1(2 * r)}" rx="1.5"/>`
      : `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(r)}"/>`;
    const tip = n === 1 ? `${J_KIND[top.kind] ?? top.kind} · ${jdate(top.t)} · ${top.title}` : `${n} events · ${jdate(cl.items[0].e.t)}${cl.items.at(-1).e.t - cl.items[0].e.t > JDAY ? ` – ${jdate(cl.items.at(-1).e.t)}` : ""}`;
    dots += `<g class="jp ${cls}${live ? " live" : ""}${S.jp.card?.ci === ci && S.jp.card?.kind === "cl" ? " on" : ""}" data-jc="${ci}" style="--d:${d}${cl.q ? `;--qc:${qcol(j.quests.find((q) => q.id === cl.items[0].e.lane) ?? {})}` : ""}">${shape}${n >= 3 && r >= 7 ? `<text x="${r1(x)}" y="${r1(y + 3.2)}">${n > 99 ? "99+" : n}</text>` : ""}<title>${jEsc(tip)}</title></g>`;
  }
  // Milestone flags where they were unlocked; ghosts ahead for the next ones.
  let flags = "";
  const flag = (a, c, cls, id, tip, lbl) => {
    const [x, y] = P(a, c);
    const pole = vert ? 0 : 26;
    return vert
      ? `<g class="jflag ${cls}" data-jm="${esc(id)}"><path class="pole" d="M${r1(x)} ${r1(y)} H${r1(x - 20)}"/><path class="pen" d="M${r1(x - 20)} ${r1(y)} v-11 l-11 4 l11 4"/>${lbl ? `<text class="jfl" x="${r1(x + 26)}" y="${r1(y + 3)}">${esc(lbl)}</text>` : ""}<title>${jEsc(tip)}</title></g>`
      : `<g class="jflag ${cls}" data-jm="${esc(id)}"><path class="pole" d="M${r1(x)} ${r1(y)} V${r1(y - pole)}"/><path class="pen" d="M${r1(x)} ${r1(y - pole)} h12 l-3 4.5 l3 4.5 h-12"/><title>${jEsc(tip)}</title></g>`;
  };
  for (const m of j.milestones) if (m.state === "unlocked" && m.at) { const a = along(Math.min(m.at, j.now.t)); if (seen(a)) flags += flag(a, offAt(a), "won", m.id, `Unlocked: ${m.title} · ${jdate(m.at)}`); }
  const ahead = j.milestones.filter((m) => m.state !== "unlocked").slice(0, futN);
  ahead.forEach((m, i) => {
    const a = nowA + ((i + 1) / (ahead.length + 1)) * (futEnd - nowA);
    const c = vert ? fo : fo + (-18 * (0.5 - 0.5 * Math.cos(Math.PI * ((i + 1) / (ahead.length + 1)))));
    flags += flag(a, c, `ghost${j.next.includes(m.id) ? " next" : ""}`, m.id, `Ahead: ${m.title}${m.pct ? ` · ${Math.round(m.pct * 100)}%` : ""}`, vert ? m.title : "");
  });
  // Turns: bigger rings with a labelled callout; labels stack so they don't collide.
  let tl = "";
  const levels = vert ? [along(j.origin?.t ?? sc.t0)] : []; // on a phone the first label starts below the origin's
  for (const t of turns) {
    if (!seen(t.a)) continue;
    const c = offAt(t.a);
    const [x, y] = P(t.a, c);
    const on = S.jp.card?.kind === "turn" && S.jp.card.id === t.event;
    tl += `<g class="jturn${on ? " on" : ""}" data-jt="${esc(t.event)}" style="--d:${Math.round(((t.a - A0) / Math.max(1, nowA - A0)) * 900) + 300}"><circle class="halo" cx="${r1(x)}" cy="${r1(y)}" r="13"/><circle class="ring" cx="${r1(x)}" cy="${r1(y)}" r="7.5" style="stroke:${jhue(j.project, t.i + 1)}"/>`;
    const text = t.label;
    const w = Math.min(vert ? W - 170 : 220, text.length * 6.3 + 30);
    if (vert) {
      let ly = t.a;
      const last = levels.at(-1) ?? -Infinity;
      if (ly < last + 34) ly = last + 34;
      levels.push(ly);
      const lx = X0 + 96;
      tl += `<path class="lead" d="M${r1(x + 8)} ${r1(y)} C${r1(x + 40)} ${r1(y)} ${r1(lx - 30)} ${r1(ly)} ${r1(lx)} ${r1(ly)}"/><foreignObject x="${r1(lx)}" y="${r1(ly - 13)}" width="${r1(W - lx - 6)}" height="40"><div class="jtl" xmlns="http://www.w3.org/1999/xhtml"><b>${esc(text)}</b><span>${esc(jdate(t.t))}</span></div></foreignObject>`;
    } else {
      let lv = 0;
      const lx = Math.max(4, Math.min(W - w - 4, x - w / 2)); // keep the pill inside the graph
      for (; lv < 3; lv++) if (!(levels[lv] ?? []).some(([a, b]) => !(lx + w < a || lx > b))) break;
      if (lv < 3) {
        (levels[lv] = levels[lv] ?? []).push([lx - 6, lx + w + 6]);
        const ly = Y0 - 50 - lv * 30;
        tl += `<path class="lead" d="M${r1(x)} ${r1(y - 9)} V${r1(ly + 11)}"/><foreignObject x="${r1(lx)}" y="${r1(ly - 11)}" width="${r1(w)}" height="24"><div class="jtl h" xmlns="http://www.w3.org/1999/xhtml">${J_ICON.turn}<b>${esc(text)}</b></div></foreignObject>`;
      }
    }
    tl += `<title>${jEsc(`${t.label} · ${jdate(t.t)}${t.why ? ` · ${t.why}` : ""}`)}</title></g>`;
  }
  // Origin and now.
  const oa = along(j.origin?.t ?? sc.t0);
  let marks = "";
  if (seen(oa)) {
    const [x, y] = P(oa, offAt(oa));
    marks += `<g class="jorigin" data-jo="1"><circle class="o2" cx="${r1(x)}" cy="${r1(y)}" r="11" style="stroke:${pc0}"/><circle class="o1" cx="${r1(x)}" cy="${r1(y)}" r="5.5" style="fill:${pc0}"/>${vert ? `<text class="jol" x="${r1(x + 18)}" y="${r1(y + 4)}">origin · ${esc(jdate(j.origin?.t))}</text>` : `<text class="jol" x="${r1(x)}" y="${r1(y + 30)}">origin</text>`}<title>${jEsc(`Origin · ${jdate(j.origin?.t)}${j.origin?.idea ? ` · ${j.origin.idea.slice(0, 160)}` : ""}`)}</title></g>`;
  }
  {
    const [x, y] = P(nowA, fo);
    const live = (j.now.live ?? []).some((l) => (S.rows.get(l.key)?.status ?? l.status) === "working");
    marks += vert
      ? `<g class="jnow${live ? " live" : ""}"><line x1="8" y1="${r1(y)}" x2="${r1(W - 8)}" y2="${r1(y)}"/><circle class="pulse" cx="${r1(x)}" cy="${r1(y)}" r="6"/><circle cx="${r1(x)}" cy="${r1(y)}" r="4.5"/><text x="${r1(W - 10)}" y="${r1(y - 6)}" text-anchor="end">now</text></g>`
      : `<g class="jnow${live ? " live" : ""}"><line x1="${r1(x)}" y1="16" x2="${r1(x)}" y2="${r1(390 - 44)}"/><circle class="pulse" cx="${r1(x)}" cy="${r1(y)}" r="6"/><circle cx="${r1(x)}" cy="${r1(y)}" r="4.5"/><text x="${r1(x)}" y="12" text-anchor="middle">now</text></g>`;
  }
  const [hx, hy] = P(futEnd, fo + (vert ? 0 : -18));
  marks += `<g class="jhead"><circle cx="${r1(hx)}" cy="${r1(hy)}" r="4"/></g>`;
  host.querySelector(".jlayer").innerHTML = s + `<g class="jlines">${line}</g><g class="jqs">${qs}</g><g class="jdots">${dots}</g>` + flags + tl + marks;
  const svg = host.querySelector("svg");
  svg.setAttribute("height", String(Math.round(H)));
  svg.setAttribute("viewBox", `0 0 ${Math.round(W)} ${Math.round(H)}`);
  svg.setAttribute("width", String(Math.round(W)));
  // Heading text sits in HTML over the future end (it wraps; SVG text doesn't).
  const hd = host.querySelector(".jhd");
  if (hd) {
    if (vert) { hd.style.top = `${Math.round(hy + 14)}px`; hd.style.left = "12px"; hd.style.right = "12px"; }
    else { const left = Math.max(nowA + 12, Math.min(W - 250, hx - 240)); hd.style.left = `${Math.round(left)}px`; hd.style.top = "20px"; hd.style.width = `${Math.round(Math.max(150, Math.min(260, W - left - 10)))}px`; hd.hidden = nowA > W - 60; }
  }
  g.nowA = nowA; g.A0 = A0; g.pastLen = pastLen; g.W = W;
}

/** Mounts the graph (once per page render) and wires pan, zoom, pinch and taps. */
function jgMount(host, j) {
  const vert = isPhone();
  const prev = host._jg;
  const keep = prev && prev.j.project === j.project && prev.vert === vert;
  host._jg = { j, vert, k: keep ? prev.k : 1, tx: keep ? prev.tx : 0, sc: null };
  const intro = !S.jp.intro.has(j.project) && !reduceMotion.matches;
  host.innerHTML = `<svg class="jg${intro ? " intro" : ""}${vert ? " vert" : ""}" role="img" aria-label="Journey of ${esc(j.project)}"><defs>
      <linearGradient id="jfadeh" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="var(--ink-3)" stop-opacity=".9"/><stop offset="1" stop-color="var(--ink-3)" stop-opacity="0"/></linearGradient>
      <linearGradient id="jfadev" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--ink-3)" stop-opacity=".9"/><stop offset="1" stop-color="var(--ink-3)" stop-opacity="0"/></linearGradient>
    </defs><g class="jlayer"></g></svg>
    <div class="jhd">${j.heading?.direction ? `<small>Heading</small><b>${esc(j.heading.direction)}</b>` : `<small>Next</small><b>${esc(j.milestones.find((m) => m.id === j.next?.[0])?.title ?? "")}</b>`}</div>
    ${vert ? "" : `<div class="jzoom"><button data-jz="in" title="Zoom in" aria-label="Zoom in">${J_ICON.plus}</button><button data-jz="out" title="Zoom out" aria-label="Zoom out">${J_ICON.minus}</button><button data-jz="fit" title="Fit it all" aria-label="Fit">${J_ICON.fit}</button></div>`}`;
  if (intro) { S.jp.intro.add(j.project); setTimeout(() => host.querySelector("svg")?.classList.remove("intro"), 2400); }
  jgDraw(host);
  if (host._wired) return;
  host._wired = true;
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; jgDraw(host); }); };
  const clampTx = () => {
    const g = host._jg; const W = host.clientWidth;
    if (g.vert) { g.tx = 0; return; }
    const content = g.pastLen * g.k + 180;
    g.tx = Math.min(W * 0.3, Math.max(-(content - W * 0.7), g.tx));
  };
  const zoomAt = (px, f) => {
    const g = host._jg;
    const k2 = Math.max(1, Math.min(60, g.k * f));
    if (g.vert) { g.k = k2; redraw(); return; }
    // Keep the point under the pointer still.
    const a = px - g.tx - g.A0;
    g.tx = px - g.A0 - (a * k2) / g.k;
    g.k = k2;
    if (k2 === 1) g.tx = 0;
    clampTx(); redraw();
  };
  host._zoomAt = zoomAt;
  host.addEventListener("wheel", (e) => {
    const g = host._jg;
    if (g.vert) return;
    const r = host.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(e.clientX - r.left, Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01)); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { e.preventDefault(); g.tx -= e.shiftKey ? e.deltaY : e.deltaX; clampTx(); redraw(); }
  }, { passive: false });
  const pts = new Map();
  let drag = null, pinch = null, moved = false;
  host.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".jzoom, .jcard")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) drag = { x: e.clientX, tx: host._jg.tx };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: host._jg.k, tx: host._jg.tx, mid: host._jg.vert ? (a.y + b.y) / 2 : (a.x + b.x) / 2 }; drag = null; }
  });
  host.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = host._jg;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = host.getBoundingClientRect();
      g.k = pinch.k; g.tx = pinch.tx;
      zoomAt(pinch.mid - (g.vert ? r.top : r.left), d / Math.max(20, pinch.d));
      moved = true;
      return;
    }
    if (drag && !g.vert && e.pointerType !== "touch" || drag && !g.vert && e.pointerType === "touch") {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) { moved = true; host.classList.add("dragging"); try { host.setPointerCapture(e.pointerId); } catch {} }
      if (moved) { g.tx = drag.tx + dx; clampTx(); redraw(); }
    }
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { drag = null; host.classList.remove("dragging"); } };
  host.addEventListener("pointerup", up); host.addEventListener("pointercancel", up);
  host.addEventListener("click", (e) => {
    if (moved) { moved = false; return; }
    const z = e.target.closest("[data-jz]")?.dataset.jz;
    if (z) { const W = host.clientWidth; if (z === "fit") { host._jg.k = 1; host._jg.tx = 0; redraw(); } else zoomAt(W * 0.6, z === "in" ? 1.8 : 1 / 1.8); return; }
    if (e.target.closest(".jcard")) return;
    const r = host.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    const c = e.target.closest("[data-jc]"), t = e.target.closest("[data-jt]"), q = e.target.closest("[data-jq]"), m = e.target.closest("[data-jm]"), o = e.target.closest("[data-jo]");
    if (c) S.jp.card = { kind: "cl", ci: Number(c.dataset.jc), at };
    else if (t) S.jp.card = { kind: "turn", id: t.dataset.jt, at };
    else if (q) S.jp.card = { kind: "quest", id: q.dataset.jq, at };
    else if (m) S.jp.card = { kind: "ms", id: m.dataset.jm, at };
    else if (o) S.jp.card = { kind: "origin", at };
    else S.jp.card = null;
    jgCard(host); jgDraw(host);
  });
  new ResizeObserver(() => { const g = host._jg; if (g && Math.abs((g.W ?? 0) - host.clientWidth) > 2) redraw(); }).observe(host);
}
