"use strict";
// herdr plugins in the page: a tab in Plugins ("plugins.tabs") with each machine's installed herdr workflow plugins and
// the herdr marketplace, their actions in ⌘K ("herdr: …") and in a session's ⋯ menu when the action works on a pane.
// Cards: herdr-plugins-cards.js. Trust screen and installs: herdr-plugins-trust.js. Server: server.ts (/api/herdr-plugins).
const herdrPlug = {
  sub: load("hpSub", "installed"), m: null, mAt: 0, mLoading: false,
  q: "", sort: load("hpSort", "popular"), browse: null, rec: null, bLoading: false, bErr: "",
  logs: {}, dirs: {}, review: null, jobs: null, busy: false,
};
const herdrPlugApi = (body, ms) => api("/api/herdr-plugins", body, ms ?? 30_000);
const herdrPlugOn = () => S.mode === "plugins" && S.plug.tab === "herdr";
/** Redraws the tab, keeping the search box focused (with its caret) while results come in. */
function herdrPlugRedraw() {
  if (!herdrPlugOn()) return;
  const a = document.activeElement, keep = a?.matches?.("[data-hp-q]") ? a.selectionStart : null;
  renderPlugins();
  for (const p of $("dbody").querySelectorAll(".hp-job pre")) p.scrollTop = p.scrollHeight; // install logs: newest line in view
  if (keep != null) { const q = $("dbody").querySelector("[data-hp-q]"); q?.focus(); q?.setSelectionRange(keep, keep); }
}

/** Every machine's herdr and plugins (the hub asks each deck). Kept a minute for ⌘K and the ⋯ menu. */
function herdrPlugLoad(force) {
  if (herdrPlug.mLoading) return herdrPlug.mLoading;
  if (!force && herdrPlug.m && Date.now() - herdrPlug.mAt < 60_000) return Promise.resolve(herdrPlug.m);
  herdrPlug.mLoading = (async () => {
    try { herdrPlug.m = await herdrPlugApi({ op: "machines" }, 45_000); herdrPlug.mAt = Date.now(); }
    catch (e) { if (herdrPlugOn()) toast(e.message, true); }
    herdrPlug.mLoading = null;
    herdrPlugRedraw();
    return herdrPlug.m;
  })();
  herdrPlugRedraw();
  return herdrPlug.mLoading;
}
async function herdrPlugBrowse() {
  herdrPlug.bLoading = true; herdrPlug.bErr = ""; herdrPlugRedraw();
  await herdrPlugLoad(); // each machine's herdr first: the server says what fits where
  try {
    const [b, rec] = await Promise.all([
      herdrPlugApi({ op: "browse", q: herdrPlug.q, sort: herdrPlug.sort, machines: herdrPlugMachineInfo() }),
      herdrPlug.rec ? null : herdrPlugApi({ op: "recommended", skip: herdrPlugInstalledIds(), machines: herdrPlugMachineInfo() }, 60_000).catch(() => ({ repos: [] })),
    ]);
    herdrPlug.browse = b;
    if (rec) herdrPlug.rec = rec.repos;
  } catch (e) { herdrPlug.bErr = e.message; }
  herdrPlug.bLoading = false; herdrPlugRedraw();
}
const herdrPlugMachines = () => herdrPlug.m?.machines ?? [];
const herdrPlugMachine = (id) => herdrPlugMachines().find((m) => m.id === id);
const herdrPlugInstalledIds = () => herdrPlugMachines().flatMap((m) => m.plugins.map((p) => p.id));
/** A session's machine: rows from other machines carry theirs; this machine's may not. */
const herdrPlugRowMachine = (r) => r?.machine ?? herdrPlug.m?.self ?? S.self;
/** herdr titles often repeat the plugin's name ("Herdr Mobile Relay: Status"); on its own card the name is noise. */
const herdrPlugShort = (p, a) => (a.title.toLowerCase().startsWith(p.name.toLowerCase() + ":") ? a.title.slice(p.name.length + 1).trim() : a.title);
/** herdr's contexts: global, workspace, tab, pane, selection. A session is a pane, in a tab, in a workspace. */
const herdrPlugFits = (a) => (a.contexts ?? []).some((c) => c === "pane" || c === "tab" || c === "workspace");

/** Runs an action. For a session (a pane), herdr gets that pane, its tab and workspace instead of what's focused. */
async function herdrPlugRun(machine, p, a, row) {
  const use = row && !row.app && !row.hist && herdrPlugFits(a) && herdrPlugRowMachine(row) === machine ? row : null;
  try {
    const r = await herdrPlugApi({ op: "invoke", machine, pluginId: p.id, actionId: a.id, key: use?.key });
    const logId = r.log?.log_id;
    toast(`Started ${herdrPlugShort(p, a)}${use ? ` for “${use.title || use.agent}”` : ""}`, false, logId ? { label: "Log", run: () => herdrPlugShowLog(machine, p, logId) } : undefined);
  } catch (e) { toast(e.message, true, { label: "Retry", run: () => herdrPlugRun(machine, p, a, row) }); }
}
/** One run's output, once it's done (herdr runs actions in the background). */
async function herdrPlugShowLog(machine, p, logId) {
  for (let i = 0; i < 20; i++) {
    const { logs } = await herdrPlugApi({ op: "logs", machine, id: p.id, limit: 30 }).catch(() => ({ logs: [] }));
    const l = logs.find((x) => x.log_id === logId);
    if (l && l.status !== "running") return askDialog({ title: `${p.name}: ${l.status}${l.exit_code != null ? ` (exit ${l.exit_code})` : ""}`, text: [l.stdout, l.stderr, l.error].filter(Boolean).join("\n").trim().slice(-4000) || "No output.", ok: "Close" });
    await new Promise((res) => setTimeout(res, 700));
  }
  toast("Still running. Its log is on the plugin’s card.");
}
/** Every action of every plugin that's on, on every machine. */
function herdrPlugActions() {
  const multi = herdrPlugMachines().filter((m) => m.version).length > 1;
  return herdrPlugMachines().flatMap((m) => m.plugins.filter((p) => p.enabled).flatMap((p) => p.actions.map((a) => ({ m, p, a, multi }))));
}
async function herdrPlugToggle(machine, p, on) {
  try {
    await herdrPlugApi({ op: "enable", machine, id: p.id, on });
    toast(`${p.name} is ${on ? "on" : "off"}`, false, { label: "Undo", run: () => herdrPlugToggle(machine, p, !on) });
  } catch (e) { toast(e.message, true); }
  herdrPlugLoad(true);
}
async function herdrPlugLogs(machine, id) {
  const k = `${machine}|${id}`;
  if (herdrPlug.logs[k] && herdrPlug.logs[k] !== "loading") { delete herdrPlug.logs[k]; return herdrPlugRedraw(); }
  herdrPlug.logs[k] = "loading"; herdrPlugRedraw();
  try { herdrPlug.logs[k] = (await herdrPlugApi({ op: "logs", machine, id, limit: 15 })).logs; } catch (e) { delete herdrPlug.logs[k]; toast(e.message, true); }
  herdrPlugRedraw();
}
async function herdrPlugDir(machine, id) {
  try { herdrPlug.dirs[`${machine}|${id}`] = (await herdrPlugApi({ op: "config-dir", machine, id })).path; herdrPlugRedraw(); } catch (e) { toast(e.message, true); }
}
const herdrPlugOpen = () => { setMode("plugins"); plugTab("herdr"); };

const herdrPlugReg = deckPlugins.register("herdr-plugins", {
  palette: (q, cur) => {
    if (!herdrPlug.m) { herdrPlugLoad(); return []; }
    return [
      { t: "herdr plugins: installed and marketplace", slot: "more", run: herdrPlugOpen },
      ...herdrPlugActions().map(({ m, p, a, multi }) => ({ t: `herdr: ${a.title}${multi ? ` · ${m.label}` : ""}`, slot: "more", run: () => herdrPlugRun(m.id, p, a, cur) })),
    ];
  },
  // Every full state (page load, reconnect) is a good moment to refresh what ⌘K and the ⋯ menu offer.
  state: () => setTimeout(() => herdrPlugLoad(), 2500),
});
herdrPlugReg.extend("plugins.tabs", {
  id: "herdr", label: "herdr", order: 25,
  count: () => herdrPlugMachines().reduce((n, m) => n + m.plugins.length, 0),
  render: () => { if (!herdrPlug.m && !herdrPlug.mLoading) setTimeout(herdrPlugLoad, 0); return herdrPlugView(); },
  open: () => { herdrPlugLoad(true); if (herdrPlug.sub === "browse" && !herdrPlug.browse) herdrPlugBrowse(); },
});
herdrPlugReg.extend("session.menu", (r, anchor) => {
  if (!r || r.app || r.hist) return [];
  const machine = herdrPlugRowMachine(r);
  const fit = herdrPlugActions().filter((x) => x.m.id === machine && herdrPlugFits(x.a));
  if (!fit.length) return [];
  const items = fit.map(({ p, a }) => ({ html: `${esc(herdrPlugShort(p, a))}<small>${esc(p.name)}</small>`, run: () => herdrPlugRun(machine, p, a, r) }));
  return [{ html: `herdr plugin actions…<small>${fit.length} can work on this pane</small>`, run: () => setTimeout(() => openMenu(anchor, items, "herdr plugin actions"), 0) }];
});

$("dbody").addEventListener("click", async (e) => {
  if (!herdrPlugOn()) return;
  const t = e.target, d = (k) => t.closest(`[data-${k}]`)?.getAttribute(`data-${k}`);
  const sub = d("hp-sub");
  if (sub) { herdrPlug.sub = sub; store("hpSub", sub); herdrPlug.review = null; herdrPlug.jobs = null; if (sub === "browse" && !herdrPlug.browse) herdrPlugBrowse(); return herdrPlugRedraw(); }
  const sort = d("hp-sort");
  if (sort) { herdrPlug.sort = sort; store("hpSort", sort); return herdrPlugBrowse(); }
  if (t.closest("[data-hp-refresh]")) return herdrPlugLoad(true);
  if (herdrPlugTrustClick(t)) return;
  const card = t.closest("[data-hp-card]");
  if (!card) return;
  const machine = card.getAttribute("data-hp-m"), p = herdrPlugMachine(machine)?.plugins.find((x) => x.id === card.getAttribute("data-hp-card"));
  if (!p) return;
  const run = d("hp-run");
  if (run) return herdrPlugRun(machine, p, p.actions.find((a) => a.id === run), rowOf(S.sel));
  const en = d("hp-enable");
  if (en) return herdrPlugToggle(machine, p, en === "on");
  if (t.closest("[data-hp-logs]")) return herdrPlugLogs(machine, p.id);
  if (t.closest("[data-hp-dir]")) return herdrPlugDir(machine, p.id);
  if (t.closest("[data-hp-copy]")) return copy(herdrPlug.dirs[`${machine}|${p.id}`], "folder path");
  if (t.closest("[data-hp-remove]")) return herdrPlugRemove(machine, p);
});
$("dbody").addEventListener("input", (e) => {
  if (!herdrPlugOn() || !e.target.matches("[data-hp-q]")) return;
  herdrPlug.q = e.target.value;
  clearTimeout(herdrPlug.qTimer);
  herdrPlug.qTimer = setTimeout(herdrPlugBrowse, 250);
});
$("dbody").addEventListener("change", (e) => { if (herdrPlugOn()) herdrPlugTrustChange(e.target); });
