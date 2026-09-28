"use strict";
// herdr plugins: the tab's two lists. Installed: one section per machine, a card per plugin (actions to run, on/off,
// logs, config folder, uninstall). Browse: the herdr marketplace with search, sort, a Recommended row, and for each
// plugin whether it fits each machine's herdr. State and clicks: herdr-plugins.js.
const HP_SORTS = [["popular", "Most stars"], ["active", "Recently updated"], ["rising", "Rising"], ["new", "New"]];
const HP_OS = { macos: "macOS", linux: "Linux", windows: "Windows" };

/** Whether a marketplace plugin fits a machine: the server says (compat.ts), from each machine's herdr and OS. */
const herdrPlugFit = (man, m) => (m.error || !m.version ? { ok: false, why: m.error ? "can’t tell" : "no herdr" } : man.fit?.[m.id] ?? { ok: true });
/** What the server needs to say whether plugins fit: each machine's herdr version and OS. */
const herdrPlugMachineInfo = () => herdrPlugMachines().filter((m) => m.version).map((m) => ({ id: m.id, version: m.version, platform: m.platform }));
const herdrPlugAgo = (iso) => (iso ? agoText(Date.parse(iso)) : "");
const herdrPlugArgv = (argv) => argv.map((x) => (/^[\w./:=@%+-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(" ");

function herdrPlugView() {
  if (herdrPlug.review || herdrPlug.jobs) return herdrPlugTrustView();
  const n = herdrPlugMachines().reduce((k, m) => k + m.plugins.length, 0);
  const seg = [["installed", `Installed${n ? ` <span class="n">${n}</span>` : ""}`], ["browse", "Browse"]].map(([id, label]) => `<button data-hp-sub="${id}" aria-pressed="${herdrPlug.sub === id}">${label}</button>`).join("");
  const bar = `<div class="hp-bar"><nav class="seg">${seg}</nav><span class="spacer"></span>${herdrPlug.sub === "installed" ? `<button class="btn ghost" data-hp-refresh ${herdrPlug.mLoading ? "disabled" : ""}>${herdrPlug.mLoading ? "Checking…" : "Check again"}</button>` : ""}</div>`;
  const intro = `<p class="hint hp-intro">herdr’s own plugins: small programs herdr runs for you, with actions, event hooks and panes. They run with your full permissions, and herdr doesn’t review them.</p>`;
  return bar + intro + (herdrPlug.sub === "browse" ? herdrPlugBrowseView() : herdrPlugInstalledView());
}

function herdrPlugInstalledView() {
  if (!herdrPlug.m) return `<p class="hint">Asking each machine’s herdr…</p>`;
  return herdrPlugMachines().map((m) => `<section class="hp-mach">
    <h3>${esc(m.label)} <small>${m.version ? `herdr ${esc(m.version)} · ${esc(HP_OS[m.platform] ?? m.platform ?? "")}` : ""}</small></h3>
    ${m.error ? `<p class="derr">${ICON.warn}${esc(m.error)}</p>` : ""}
    ${!m.error && !m.plugins.length ? `<div class="pempty"><p>No herdr plugins on this machine yet.</p><button class="btn ghost" data-hp-sub="browse">Browse the marketplace</button></div>` : ""}
    ${m.plugins.length ? `<div class="plist">${m.plugins.map((p) => herdrPlugCard(m, p)).join("")}</div>` : ""}
  </section>`).join("");
}

function herdrPlugCard(m, p) {
  const s = p.source, k = `${m.id}|${p.id}`;
  const from = s.kind === "github" ? `from ${[s.owner, s.repo, s.subdir].filter(Boolean).join("/")}${s.commit ? ` at ${s.commit.slice(0, 7)}` : s.ref ? ` at ${s.ref}` : ""}` : "linked from a folder";
  const sel = rowOf(S.sel), selHere = sel && !sel.app && !sel.hist && herdrPlugRowMachine(sel) === m.id ? sel : null;
  const acts = p.actions.map((a) => {
    const fits = herdrPlugFits(a);
    const tip = `${herdrPlugArgv(a.command)}${fits ? (selHere ? `\nFor “${selHere.title || selHere.agent}”` : "\nFor the pane focused in herdr") : ""}`;
    return `<button class="btn ghost hp-act" data-hp-run="${esc(a.id)}" title="${esc(tip)}" ${p.enabled ? "" : "disabled"}>${esc(herdrPlugShort(p, a))}${fits && selHere ? ` <small>for this session</small>` : ""}</button>`;
  }).join("");
  const auto = [
    ...p.startup.map((c) => `at herdr start: <code>${esc(herdrPlugArgv(c.command))}</code>`),
    ...p.events.map((e) => `on <b>${esc(e.on)}</b>: <code>${esc(herdrPlugArgv(e.command))}</code>`),
  ];
  const logs = herdrPlug.logs[k], dir = herdrPlug.dirs[k];
  return `<article class="pcard hp-card" data-hp-card="${esc(p.id)}" data-hp-m="${esc(m.id)}">
    <div class="ptop">${plugIcon(p.name)}<div class="pid"><b>${esc(p.name)}</b><small>${esc(p.version)} · ${esc(from)}</small></div><span class="pstate ${p.enabled ? "pon" : "poff"}">${p.enabled ? "On" : "Off"}</span></div>
    ${p.description ? `<p class="hp-desc">${esc(p.description)}</p>` : ""}
    ${p.warnings.map((w) => `<p class="derr">${ICON.warn}${esc(w)}</p>`).join("")}
    ${acts && p.enabled ? `<div class="hp-acts">${acts}</div>` : acts ? `<p class="hint">Turn it on to use its ${p.actions.length === 1 ? "action" : `${p.actions.length} actions`}.</p>` : ""}
    ${auto.length ? `<details class="hp-auto"><summary>Runs on its own (${auto.length})</summary><ul>${auto.map((x) => `<li>${x}</li>`).join("")}</ul></details>` : ""}
    ${dir ? `<p class="hp-dir"><code>${esc(dir)}</code> <button class="link" data-hp-copy>Copy</button></p>` : ""}
    ${logs ? herdrPlugLogList(logs) : ""}
    <div class="pacts"><button class="btn ghost" data-hp-enable="${p.enabled ? "off" : "on"}">${p.enabled ? "Turn off" : "Turn on"}</button><button class="btn ghost" data-hp-logs aria-pressed="${!!logs}">Logs</button><button class="btn ghost" data-hp-dir>Config folder</button><span class="spacer"></span><button class="btn ghost danger" data-hp-remove>${s.kind === "local" ? "Unlink" : "Uninstall"}</button></div>
  </article>`;
}
function herdrPlugLogList(logs) {
  if (logs === "loading") return `<p class="hint">Reading its log…</p>`;
  if (!logs.length) return `<p class="hint">Nothing has run yet.</p>`;
  return `<ul class="hp-logs">${logs.map((l) => {
    const what = l.action_id ? `action ${l.action_id}` : l.event ? `on ${l.event}` : "startup";
    const out = [l.stderr, l.error, l.stdout].filter(Boolean).join("\n").trim();
    return `<li class="hp-${esc(l.status)}"><span class="hp-st">${esc(l.status)}${l.exit_code != null && l.exit_code !== 0 ? ` (${l.exit_code})` : ""}</span> ${esc(what)} <span class="hint">${esc(agoText(l.started_unix_ms))}</span>${out ? `<pre>${esc(out.slice(-600))}</pre>` : ""}</li>`;
  }).join("")}</ul>`;
}

function herdrPlugBrowseView() {
  const b = herdrPlug.browse;
  const sorts = HP_SORTS.map(([id, label]) => `<button data-hp-sort="${id}" aria-pressed="${herdrPlug.sort === id}">${label}</button>`).join("");
  const top = `<div class="hp-search"><input type="search" data-hp-q placeholder="Search ${b ? b.all.toLocaleString("en") : ""} plugins" value="${esc(herdrPlug.q)}" aria-label="Search herdr plugins"><nav class="seg hp-sorts">${sorts}</nav></div>`;
  if (herdrPlug.bErr) return top + `<p class="derr">${ICON.warn}${esc(herdrPlug.bErr)}</p>`;
  if (!b) return top + `<p class="hint">Reading the herdr marketplace…</p>`;
  const rec = !herdrPlug.q && herdrPlug.rec?.length ? `<h3 class="hp-h">Recommended</h3><p class="hint">Well starred, updated this month, and with a manifest you can read in a minute. Numbers come from the marketplace.</p><div class="plist hp-rec">${herdrPlug.rec.map((r) => herdrPlugRepo(r, r.why)).join("")}</div><h3 class="hp-h">All plugins</h3>` : "";
  const src = b.source === "github" ? " (from GitHub search: the herdr.dev index didn’t answer)" : "";
  return top + rec + `<p class="hint">${b.total.toLocaleString("en")} of ${b.all.toLocaleString("en")} repos${src}. Anyone can list a plugin by tagging a GitHub repo; nobody reviews them.</p>
    <div class="plist">${b.repos.map((r) => herdrPlugRepo(r)).join("") || `<p class="hint">Nothing matches.</p>`}</div>`;
}

function herdrPlugRepo(r, why) {
  const ms = herdrPlugMachines().filter((m) => m.version || m.error);
  const rows = r.manifests.map((man) => {
    const on = ms.filter((m) => m.plugins.some((p) => p.id === man.id));
    const fit = ms.map((m) => { const c = herdrPlugFit(man, m); return `<span class="ptag ${c.ok ? "" : "pw"}" title="${esc(c.ok ? "Fits this machine" : c.why)}">${esc(m.label)}${c.ok ? "" : `: ${esc(c.why)}`}</span>`; }).join("");
    return `<div class="hp-man">
      <div class="hp-manh"><b>${esc(man.name)}</b> <small>${esc(man.version)}${man.minHerdrVersion ? ` · herdr ${esc(man.minHerdrVersion)}+` : ""}</small>${on.length ? `<span class="pstate pon">Installed on ${esc(on.map((m) => m.label).join(", "))}</span>` : ""}</div>
      <div class="hp-fit">${fit}</div>
      <button class="btn ${on.length ? "ghost" : "primary"}" data-hp-review="${esc(r.fullName)}" data-hp-path="${esc(man.path)}">${on.length ? "Review" : "Review and install"}</button>
    </div>`;
  }).join("");
  const facts = [`${r.stars.toLocaleString("en")} stars`, r.starsDelta30d ? `+${r.starsDelta30d} this month` : "", r.pushedAt ? `updated ${herdrPlugAgo(r.pushedAt)}` : "", r.language ?? ""].filter(Boolean).join(" · ");
  return `<article class="pcard hp-repo">
    <div class="ptop">${plugIcon(r.fullName.split("/")[1])}<div class="pid"><b>${esc(r.manifests.length === 1 ? r.manifests[0].name : r.fullName.split("/")[1])}</b><small><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.fullName)}</a></small></div></div>
    ${r.description ? `<p class="hp-desc">${esc(r.description)}</p>` : ""}
    ${why ? `<ul class="hp-why">${why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : `<p class="hint">${esc(facts)}</p>`}
    ${rows}
  </article>`;
}
