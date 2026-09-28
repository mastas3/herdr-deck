// Gallery: the starter kit inside an idea's sheet. Built on request (one Claude call on the server, cached per idea;
// src/ideagen/kit.ts), with a readiness meter (what's ready vs what needs you) and tabs for the spec, architecture,
// build plan (each task with a prompt to paste into an agent), connectors, go-to-market copy (for you to send) and
// quests. Building a kit writes nothing into your projects; only Play does, after you confirm.
S.gal.kitTab = load("galKitTab", "plan");
const GAL_TABS = [["spec", "Spec"], ["arch", "Architecture"], ["plan", "Build plan"], ["conn", "Connectors"], ["comps", "Comparable founders"], ["gtm", "Go-to-market"], ["quests", "Quests"]];
let galKitTimer;
async function galKitLoad(id) {
  try { S.gal.kits.set(id, await api("/api/ideas/kit", { id }, 30_000)); } catch (e) { toast(e.message, true); }
  galSheetRefresh();
}
async function galKitBuild(id) {
  if (S.gal.kitJobs.get(id)?.running) return;
  S.gal.kitJobs.set(id, { running: true, t0: Date.now() });
  galSheetRefresh(); galKitTick();
  try {
    const k = await api("/api/ideas/kit", { id }, 360_000);
    S.gal.kits.set(id, k);
    S.gal.kitJobs.delete(id);
    if (S.gal.data && !S.gal.data.kits?.includes(galKitId(id))) S.gal.data.kits = [...(S.gal.data.kits ?? []), galKitId(id)];
    toast("Starter kit ready");
  } catch (e) { S.gal.kitJobs.set(id, { error: e.message }); }
  galSheetRefresh(); galPaint();
}
/** The clock on a kit being built ticks each second, without redrawing the sheet. */
function galKitTick() {
  clearInterval(galKitTimer);
  galKitTimer = setInterval(() => {
    const el = document.querySelector(".galdlg [data-galsince]");
    if (!el) { if (![...S.gal.kitJobs.values()].some((j) => j.running)) clearInterval(galKitTimer); return; }
    el.textContent = clock(Date.now() - Number(el.dataset.galsince));
  }, 1000);
}
function galKitHTML(c) {
  const k = S.gal.kits.get(c.id), job = S.gal.kitJobs.get(c.id);
  const intro = "The spec, the architecture, a build plan whose tasks come with prompts you can paste into an agent, the connectors and keys it needs, and launch copy for you to send.";
  if (!k && job?.running) return `<h3>Starter kit</h3><div class="galkitrun" role="status"><div class="galbar indet"><i></i></div><p><span class="spin"></span>Writing the kit: one Claude call, usually a minute or two. <span class="mono" data-galsince="${job.t0}">${clock(Date.now() - job.t0)}</span></p><p class="hint">${intro} You can close this; it keeps going.</p></div>`;
  if (!k && galHasKit(c.id)) return `<h3>Starter kit</h3><p><span class="spin"></span>Opening the kit…</p>`;
  if (!k) return `<h3>Starter kit</h3><p>${intro}</p>${job?.error ? `<p class="galerr">${ICON.warn}${esc(job.error)}</p>` : ""}<p><button class="btn primary" data-galkitbuild>${job?.error ? "Try again" : "Build the kit"}</button> <span class="hint">Nothing is written to your projects until you Play.</span></p>`;
  const items = k.readiness?.items ?? [];
  const n = (s) => items.filter((i) => i.status === s).length;
  const ready = n("ready"), you = n("needs-user"), miss = n("missing"), all = Math.max(1, items.length);
  const tab = GAL_TABS.some(([t]) => t === S.gal.kitTab) ? S.gal.kitTab : "plan";
  return `<h3>Starter kit</h3>
    <div class="galready"><div class="galmeter" role="img" aria-label="${ready} ready, ${you} need you, ${miss} missing"><i class="r" style="flex:${ready}"></i><i class="u" style="flex:${you}"></i><i class="m" style="flex:${miss}"></i></div>
      <p><b>${ready} of ${all} ready.</b> ${you} need you${miss ? `, ${miss} missing` : ""}.${k.judge ? ` A reviewer rated it ${k.judge.ready}/5 to start from.` : ""}</p>
      <details><summary>What needs you</summary><ul class="galneeds">${items.filter((i) => i.status !== "ready").map((i) => `<li class="${i.status}"><b>${esc(i.label)}</b>${i.how ? ` <span class="hint">${esc(i.how)}</span>` : ""}</li>`).join("")}</ul></details></div>
    <nav class="seg small galtabs" role="tablist">${GAL_TABS.map(([t, l]) => `<button role="tab" data-galtab="${t}" aria-pressed="${t === tab}" aria-selected="${t === tab}">${l}</button>`).join("")}</nav>
    <div class="galtab">${galKitTab(k, tab)}</div>`;
}
const galList = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
function galKitTab(k, tab) {
  if (tab === "spec") {
    const s = k.spec;
    return `<p>${esc(s.problem)}</p><dl class="galkv"><div><dt>Buyer</dt><dd>${esc(s.buyer)}</dd></div></dl><h4>Jobs</h4>${galList(s.jobs)}<div class="galcols"><div><h4>In v1</h4>${galList(s.scopeIn)}</div><div><h4>Not in v1</h4>${galList(s.scopeOut)}</div></div>
      ${s.metrics?.length ? `<h4>Success metrics</h4><table class="galtbl"><tr><th>Metric</th><th>Target</th><th>Milestone</th></tr>${s.metrics.map((m) => `<tr><td>${esc(m.metric)}</td><td>${esc(m.target)}</td><td>${esc(m.milestone)}</td></tr>`).join("")}</table>` : ""}`;
  }
  if (tab === "arch") {
    const a = k.architecture;
    return `<p>${esc(a.summary)}</p><h4>Components</h4><table class="galtbl"><tr><th>Component</th><th>Does</th><th>Uses</th></tr>${a.components.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.does)}</td><td>${esc(x.uses)}</td></tr>`).join("")}</table>
      ${a.dataModel.length ? `<h4>Data model</h4><ul>${a.dataModel.map((e) => `<li><b>${esc(e.entity)}</b>: ${esc(e.fields.join(", "))}</li>`).join("")}</ul>` : ""}
      ${a.flows.map((f) => `<h4>${esc(f.name)}</h4><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`).join("")}
      <p class="hint">Deploy: ${esc(k.scaffold.deploy)} · Base: ${esc(k.scaffold.base)}</p>`;
  }
  if (tab === "plan") return `<p class="hint">Do them in order; each fits one agent session. Play opens task 1 for you.</p>${k.buildPlan.map((t, i) => `<article class="galtask"><header><span class="galtid">${esc(t.id)}</span><b>${esc(t.title)}</b><span class="galsz" title="Size">${esc(t.size)}</span>${t.dependsOn.length ? `<span class="hint">after ${esc(t.dependsOn.join(", "))}</span>` : ""}<span class="spacer"></span><button class="btn ghost sm" data-galcopyp="${i}">${ICON.copy}Copy prompt</button></header>
      <pre class="galpre">${esc(t.prompt)}</pre>${t.accept.length ? `<p class="hint">Done when</p>${galList(t.accept)}` : ""}</article>`).join("")}`;
  if (tab === "conn") {
    const c = k.connectors;
    const sec = (h, rows) => (rows ? `<h4>${h}</h4><ul class="galck">${rows}</ul>` : "");
    return sec("Repos", c.repos.map((r) => `<li class="${r.verified ? "ok" : "no"}"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> <span class="hint">${r.verified ? "checked on GitHub" : "couldn't verify it exists"} · ${esc(r.why)}</span></li>`).join(""))
      + sec("Services", c.services.map((s) => `<li class="${s.have ? "ok" : "no"}"><b>${esc(s.name)}</b> <span class="hint">${s.have ? "you have it" : "sign up"} · ${esc(s.why)}${s.free ? ` · ${esc(s.free)}` : ""}</span>${!s.have && s.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">site</a>` : ""}</li>`).join(""))
      + sec("Keys (names only)", c.keys.map((x) => `<li class="${x.have ? "ok" : "no"}"><code>${esc(x.name)}</code> <span class="hint">${x.have ? `set (${esc(x.where ?? "")})` : "missing: create it"} · ${esc(x.purpose)}</span></li>`).join(""))
      + sec("MCP servers & skills", c.mcpAndSkills.map((t) => `<li class="ok"><b>${esc(t.name)}</b> <span class="hint">${esc(t.use)}</span></li>`).join(""))
      + sec("Still missing", c.missing.map((m) => `<li class="no"><b>${esc(m.label)}</b>${m.suggestions[0] ? ` <span class="hint">${esc(m.suggestions[0].type)}: ${esc(m.suggestions[0].name)}</span>` : ""}</li>`).join(""));
  }
  if (tab === "comps") return galKitCompHTML(k);
  if (tab === "gtm") {
    const g = k.gtm, l = g.landing;
    const cite = (x) => (x && x !== "none" ? ` <span class="galcite">like ${galCiteHTML(x)}</span>` : "");
    return `<p class="hint">Copy for you to use and send yourself. Nothing is posted or sent from here.</p>
      <div class="gallanding" dir="auto"><p class="galkick">Landing page</p><h4 dir="auto">${esc(l.headline)}</h4><p dir="auto">${esc(l.subhead)}</p>${galList(l.benefits)}<span class="btn primary sm" aria-hidden="true">${esc(l.cta)}</span></div>
      ${g.pricing.length ? `<h4>Pricing</h4><div class="galtiers">${g.pricing.map((p) => `<div><b>${esc(p.tier)}</b><span>${esc(p.price)}</span>${galList(p.includes)}</div>`).join("")}</div>` : ""}
      ${g.pricingWhy ? `<p class="galwhy" dir="auto">${galCiteHTML(g.pricingWhy)}</p>` : ""}
      ${g.first10?.length ? `<h4>The first 10 customers</h4><ol class="galsteps">${g.first10.map((x) => `<li dir="auto">${esc(x.step)}${cite(x.cites)}</li>`).join("")}</ol>` : ""}
      ${g.launchPlan?.length ? `<h4>Launch plan</h4><ul class="galsteps">${g.launchPlan.map((x) => `<li dir="auto"><b>${esc(x.when)}</b> ${esc(x.what)}${cite(x.cites)}</li>`).join("")}</ul>` : ""}
      ${g.launchPosts.length ? `<h4>Launch posts</h4>${g.launchPosts.map((p, i) => `<article class="galpost"><header><b>${esc(p.channel)}</b><span class="spacer"></span><button class="btn ghost sm" data-galcopypost="${i}">${ICON.copy}Copy</button></header><p dir="auto">${esc(p.text)}</p></article>`).join("")}` : ""}
      ${g.outreach ? `<h4>First 10 people</h4><article class="galpost"><header><span class="hint">One message you send personally</span><span class="spacer"></span><button class="btn ghost sm" data-galcopyout>${ICON.copy}Copy</button></header><p dir="auto">${esc(g.outreach)}</p></article>` : ""}`;
  }
  return `<ol class="galquests">${k.quests.map((q) => `<li><b>${esc(q.title)}</b><span class="hint">Verified when ${esc(q.verify)}</span></li>`).join("")}</ol><p class="hint">Play puts this idea on your quest board with a milestone ladder: offer page live, first user, first paying customer, 10 paying, $100 and $1k a month.</p>`;
}
/** Text with links in it (a kit's citations of comparable founders): the links become short "watch" links (core
 *  clock(), so they read the same while the Founder Library is off). */
function galCiteHTML(t) {
  return String(t ?? "").split(/(https?:\/\/[^\s)]+)/g).map((x, i) => (i % 2 ? `<a class="ltime" href="${esc(x)}" target="_blank" rel="noopener">${ICON.play ?? ""}${esc(/[?&]t=(\d+)s/.test(x) ? clock(Number(x.match(/[?&]t=(\d+)s/)[1]) * 1000) : "video")}</a>` : esc(x))).join("");
}
function galKitClick(e, id) {
  const t = e.target, k = S.gal.kits.get(id);
  if (t.closest("[data-galkitbuild]")) return galKitBuild(id);
  const tb = t.closest("[data-galtab]");
  if (tb) { S.gal.kitTab = tb.dataset.galtab; store("galKitTab", S.gal.kitTab); return galSheetRefresh(); }
  if (!k) return;
  const cp = t.closest("[data-galcopyp]");
  if (cp) return copy(k.buildPlan[Number(cp.dataset.galcopyp)]?.prompt ?? "", "the prompt");
  const post = t.closest("[data-galcopypost]");
  if (post) return copy(k.gtm.launchPosts[Number(post.dataset.galcopypost)]?.text ?? "", "the post");
  if (t.closest("[data-galcopyout]")) return copy(k.gtm.outreach, "the message");
}
