"use strict";
// herdr plugins: the red trust screen before an install, the install itself (one job per machine, its log as it
// comes), and uninstall with Undo. herdr doesn't review or sandbox plugins, so the screen shows every command the
// manifest will run, verbatim, at the exact commit the install pins, and needs a tick.

async function herdrPlugReview(fullName, path) {
  const repo = [...(herdrPlug.browse?.repos ?? []), ...(herdrPlug.rec ?? [])].find((r) => r.fullName === fullName);
  const man = repo?.manifests.find((m) => m.path === path);
  if (!repo || !man) return;
  herdrPlug.review = { repo, man, loading: true, tick: false, pick: new Set() };
  herdrPlugRedraw(); $("dbody").scrollTop = 0;
  try {
    const r = await herdrPlugApi({ op: "review", fullName, path, commit: repo.headCommit }, 45_000);
    if (herdrPlug.review?.repo !== repo) return;
    Object.assign(herdrPlug.review, r, { loading: false });
    // Start with this machine ticked when it fits and doesn't have it yet.
    const self = herdrPlugMachine(herdrPlug.m?.self);
    if (self && herdrPlugPickable(self)) herdrPlug.review.pick.add(self.id);
  } catch (e) { herdrPlug.review = null; toast(e.message, true); }
  herdrPlugRedraw();
}
/** Can this machine take it: herdr there, versions and platforms fit, and it isn't installed there already. */
function herdrPlugPickable(m) {
  const { man } = herdrPlug.review;
  return m.version && !m.error && herdrPlugFit(man, m).ok && !m.plugins.some((p) => p.id === man.id);
}
const herdrPlugSpec = (repo, man) => [repo.fullName, man.path.split("/").slice(0, -1).join("/")].filter(Boolean).join("/");

function herdrPlugTrustView() {
  if (herdrPlug.jobs) return herdrPlugJobsView();
  const { repo, man, detail: d, commit: c, loading, tick, pick } = herdrPlug.review;
  const back = `<button class="link" data-hp-back>← Back</button>`;
  if (loading || !d) return `<section class="ptrust ccode hp-trust">${back}<h3>${esc(man.name)}</h3><p class="hint">Reading its manifest at ${esc(repo.headCommit?.slice(0, 7) ?? "")}…</p></section>`;
  const owner = repo.fullName.split("/")[0], sub = man.path.split("/").slice(0, -1).join("/");
  const cmd = (argv) => `<code title="${esc(JSON.stringify(argv))}">${esc(herdrPlugArgv(argv))}</code>`;
  const sec = (title, items, none) => `<h4>${title}</h4>${items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<p class="hint">${none}</p>`}`;
  const machines = herdrPlugMachines().map((m) => {
    const ok = herdrPlugPickable(m), has = m.plugins.some((p) => p.id === man.id), fit = herdrPlugFit(man, m);
    const why = m.error ? m.error : has ? "already installed" : !fit.ok ? fit.why : `herdr ${m.version}`;
    return `<label class="hp-pick ${ok ? "" : "off"}"><input type="checkbox" data-hp-mach="${esc(m.id)}" ${pick.has(m.id) ? "checked" : ""} ${ok ? "" : "disabled"}> ${esc(m.label)} <small>${esc(why)}</small></label>`;
  }).join("");
  const can = tick && pick.size && !herdrPlug.busy;
  return `<section class="ptrust ccode hp-trust">${back}
    <div class="ptop">${plugIcon(man.name)}<div class="pid"><h3>${esc(d.name || man.name)} <small>${esc(d.version)}</small></h3><small><a href="${esc(repo.url)}" target="_blank" rel="noopener noreferrer">${esc(repo.fullName)}</a>${sub ? ` / ${esc(sub)}` : ""} · ${repo.stars.toLocaleString("en")} stars · last push ${esc(herdrPlugAgo(repo.pushedAt))}</small></div></div>
    <p class="cdanger">${ICON.warn}<span><b>This runs code with your full permissions.</b> herdr doesn’t review or sandbox plugins. The commands below can read and change your files, use your logins and reach the network. Install it only if you trust ${esc(owner)}.</span></p>
    ${d.description ? `<p class="pauthor"><span>The author says:</span> ${esc(d.description)}</p>` : ""}
    <h4>The commit it installs</h4>
    <p class="hp-commit"><a href="https://github.com/${esc(repo.fullName)}/tree/${esc(repo.headCommit)}${sub ? `/${esc(sub)}` : ""}" target="_blank" rel="noopener noreferrer"><code>${esc(repo.headCommit)}</code></a>${c?.date ? ` · ${esc(agoText(Date.parse(c.date)))}` : ""}${c?.author ? ` · ${esc(c.author)}` : ""}${c?.message ? `<br><span class="hint">${esc(c.message)}</span>` : ""}</p>
    ${sec("Runs while it installs", d.build.map(cmd), "Nothing: it has no build step.")}
    ${sec("Runs every time herdr starts", d.startup.map(cmd), "Nothing.")}
    ${sec("Runs on its own when something happens in herdr", d.events.map((e) => `on <b>${esc(e.on)}</b>: ${cmd(e.command)}`), "Nothing: it has no event hooks.")}
    ${sec("Actions (run only when you pick them)", d.actions.map((a) => `<b>${esc(a.title)}</b>${a.contexts?.length ? ` <span class="hint">(${esc(a.contexts.join(", "))})</span>` : ""}: ${cmd(a.command)}`), "None.")}
    ${d.panes.length ? sec("Panes it can open", d.panes.map((p) => `<b>${esc(p.title)}</b>: ${cmd(p.command)}`), "") : ""}
    ${d.linkHandlers.length ? sec("Links it takes over (Ctrl-click in herdr)", d.linkHandlers.map((l) => `<b>${esc(l.title)}</b>: <code>${esc(l.pattern)}</code>`), "") : ""}
    <p class="hint">These run from the plugin’s folder. The scripts they name are in the repo at the commit above; read them there before you install.</p>
    <h4>Install on</h4><div class="hp-picks">${machines}</div>
    <label class="ptick"><input type="checkbox" data-hp-tick ${tick ? "checked" : ""}> I read these commands and trust ${esc(owner)} to run them on ${pick.size > 1 ? "these machines" : "this machine"}</label>
    <div class="pacts"><button class="btn primary danger" data-hp-install ${can ? "" : "disabled"}>Install${pick.size > 1 ? ` on ${pick.size} machines` : ""}</button><button class="btn ghost" data-hp-back>Cancel</button></div>
  </section>`;
}

async function herdrPlugInstall() {
  const r = herdrPlug.review;
  if (!r?.tick || !r.pick.size || herdrPlug.busy) return;
  const spec = herdrPlugSpec(r.repo, r.man), ref = r.repo.headCommit;
  herdrPlug.busy = true;
  herdrPlug.jobs = [...r.pick].map((id) => ({ machine: id, label: herdrPlugMachine(id)?.label ?? id, state: "starting", lines: [] }));
  herdrPlugRedraw();
  await Promise.all(herdrPlug.jobs.map(async (j) => {
    try { Object.assign(j, await herdrPlugApi({ op: "install", machine: j.machine, spec, ref })); }
    catch (e) { Object.assign(j, { state: "failed", error: e.message }); }
  }));
  herdrPlug.busy = false;
  herdrPlugPoll();
}
/** Each machine's install log until every one is done. */
async function herdrPlugPoll() {
  const jobs = herdrPlug.jobs;
  if (!jobs) return;
  await Promise.all(jobs.filter((j) => j.state === "running" && j.id).map(async (j) => {
    try { Object.assign(j, await herdrPlugApi({ op: "job", machine: j.machine, id: j.id })); } catch (e) { Object.assign(j, { state: "failed", error: e.message }); }
  }));
  if (herdrPlug.jobs !== jobs) return;
  herdrPlugRedraw();
  const pre = $("dbody").querySelectorAll(".hp-job pre");
  for (const p of pre) p.scrollTop = p.scrollHeight;
  if (jobs.some((j) => j.state === "running")) return setTimeout(herdrPlugPoll, 800);
  const ok = jobs.filter((j) => j.state === "done");
  if (ok.length) toast(`${herdrPlug.review?.man.name ?? "Plugin"} installed on ${ok.map((j) => j.label).join(", ")}`);
  herdrPlugLoad(true);
}
function herdrPlugJobsView() {
  const r = herdrPlug.review, running = herdrPlug.jobs.some((j) => j.state === "running" || j.state === "starting");
  const blocks = herdrPlug.jobs.map((j) => `<div class="hp-job hp-${esc(j.state)}">
    <h4>${esc(j.label)}: ${j.state === "done" ? `installed${j.plugin?.commit ? ` at <code>${esc(j.plugin.commit.slice(0, 12))}</code>` : ""}` : j.state === "failed" ? "failed" : "installing…"}</h4>
    ${j.error ? `<p class="derr">${ICON.warn}${esc(j.error)}</p>` : ""}
    ${j.lines?.length ? `<pre>${esc(j.lines.slice(-80).join("\n"))}</pre>` : ""}
  </div>`).join("");
  const failed = herdrPlug.jobs.some((j) => j.state === "failed");
  return `<section class="ptrust hp-trust">
    <h3>${esc(r?.man.name ?? "Install")}</h3>
    <p class="hint">${esc(`herdr plugin install ${herdrPlugSpec(r.repo, r.man)} --ref ${r.repo.headCommit}`)}</p>
    ${blocks}
    <div class="pacts">${running ? `<span class="hint">herdr is cloning it and running its build steps…</span>` : `<button class="btn primary" data-hp-done>Done</button>${failed ? `<button class="btn ghost" data-hp-retry>Back to the review</button>` : ""}`}</div>
  </section>`;
}

async function herdrPlugRemove(machine, p) {
  const local = p.source.kind === "local", label = herdrPlugMachine(machine)?.label ?? machine;
  const ok = await askDialog({
    title: `${local ? "Unlink" : "Uninstall"} ${p.name} on ${label}?`,
    text: local ? "herdr forgets it. Its folder stays where it is." : "herdr removes its files. Its config folder stays, so putting it back keeps your settings.",
    ok: local ? "Unlink" : "Uninstall", danger: true,
  });
  if (!ok) return;
  try {
    const { undo } = await herdrPlugApi({ op: "remove", machine, id: p.id }, 45_000);
    toast(`${p.name} ${local ? "unlinked" : "uninstalled"}`, false, undo ? { label: "Undo", run: () => herdrPlugRestore(machine, p, undo) } : undefined);
  } catch (e) { toast(e.message, true); }
  herdrPlugLoad(true);
}
async function herdrPlugRestore(machine, p, undo) {
  toast(`Putting ${p.name} back…`);
  try { await herdrPlugApi({ op: "restore", machine, undo }, 15 * 60_000); toast(`${p.name} is back${undo.ref ? ` at ${undo.ref.slice(0, 7)}` : ""}`); }
  catch (e) { toast(e.message, true, { label: "Retry", run: () => herdrPlugRestore(machine, p, undo) }); }
  herdrPlugLoad(true);
}

/** Clicks for the review and install screens; true when it handled one. */
function herdrPlugTrustClick(t) {
  const rv = t.closest("[data-hp-review]");
  if (rv) { herdrPlugReview(rv.getAttribute("data-hp-review"), rv.getAttribute("data-hp-path")); return true; }
  if (t.closest("[data-hp-back]")) { herdrPlug.review = null; herdrPlugRedraw(); return true; }
  if (t.closest("[data-hp-install]")) { herdrPlugInstall(); return true; }
  if (t.closest("[data-hp-retry]")) { herdrPlug.jobs = null; if (herdrPlug.review) herdrPlug.review.tick = false; herdrPlugRedraw(); return true; }
  if (t.closest("[data-hp-done]")) { herdrPlug.jobs = null; herdrPlug.review = null; herdrPlug.sub = "installed"; store("hpSub", "installed"); herdrPlugRedraw(); return true; }
  return false;
}
function herdrPlugTrustChange(el) {
  const r = herdrPlug.review;
  if (!r) return;
  if (el.matches("[data-hp-tick]")) r.tick = el.checked;
  else if (el.matches("[data-hp-mach]")) { const id = el.getAttribute("data-hp-mach"); if (el.checked) r.pick.add(id); else r.pick.delete(id); }
  else return;
  herdrPlugRedraw();
}
