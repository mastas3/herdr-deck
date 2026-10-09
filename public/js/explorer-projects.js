"use strict";
// Projects are identities on a computer, not a path of intermediate directories.
function exProjectForest(machines, rows, self, allRows = rows) {
  const relevant = r => !r.empty || r.status === "working" || r.status === "blocked" || r.startup;
  const all = new Map(allRows.filter(relevant).map(r => [r.key, r]));
  const context = treeWithContext(rows.filter(relevant), all);
  const families = treeFamilies(context.rows, all), sessionTree = new Map();
  const owner = r => machines.find(m => m.id === r.machine)?.kind === "app" ? self : r.machine || self;
  const forest = exForest(machines, [], self), byMachine = new Map(forest.roots.map(n => [n.machine, n]));
  for (const r of context.rows) if (!byMachine.has(owner(r))) {
    const f = exForest([{ id: owner(r), label: owner(r), online: false }], [], self);
    forest.roots.push(f.roots[0]); forest.nodes.set(f.roots[0].id, f.roots[0]); byMachine.set(owner(r), f.roots[0]);
  }
  function register(node) { sessionTree.set(node.r.key, node); node.all.forEach(register); }
  for (const family of families) {
    for (const top of family.node ? [family.node] : family.tops) {
      register(top);
      const r = top.r, root = byMachine.get(owner(r));
      const path = exPath(r.gitRoot || r.projectRoot || r.cwd) || root.path;
      const id = "project:" + exId(root.machine, path);
      let project = forest.nodes.get(id);
      if (!project) {
        project = { id, machine: root.machine, path, name: r.project || path.split("/").pop() || "Sessions", projectNode: true, info: root.info, parent: root.id, children: [], rows: [], all: [] };
        forest.nodes.set(id, project); root.children.push(project);
      }
      project.rows.push(r);
      const collect = n => { project.all.push(n.r); n.all.forEach(collect); }; collect(top);
    }
  }
  for (const root of forest.roots) {
    root.all = root.children.flatMap(n => n.all);
    for (const n of [root, ...root.children]) {
      n.attention = n.all.filter(r => r.status === "blocked" || r.status === "done" && !r.seen || ["failed", "unknown"].includes(r.startup?.state)).length;
      n.working = n.all.filter(r => r.status === "working").length;
      n.latest = Math.max(0, ...n.all.map(r => r.lastActiveAt || r.createdAt || 0));
    }
    root.children.sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || Number(!!b.working) - Number(!!a.working) || b.latest - a.latest || a.name.localeCompare(b.name));
  }
  return { ...forest, sessionTree, context: context.ctx };
}

function exAgentList(r, tree) {
  const workers = tree?.all || [];
  const ids = new Set(workers.map(n => n.r.sessionId).filter(Boolean));
  const native = (r.subagents || []).filter(s => !ids.has(s.id)).slice().sort((a, b) => Number(b.running) - Number(a.running) || (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  return { workers, native, count: workers.length + native.length, running: workers.filter(n => n.r.status === "working").length + native.filter(s => s.running).length };
}

function exPlain(text, limit = 180) {
  const clean = String(text || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/<[^>]*>/g, " ").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + "…" : clean;
}
function exSessionStory(r, detail) {
  const same = (a, b) => { const norm = s => exPlain(s).toLowerCase().replace(/[.…]+$/g, ""); return norm(a) === norm(b) || norm(a).startsWith(norm(b)) && norm(b).length > 45; };
  const title = exPlain(r.title || r.overview?.request || r.firstPrompt || (r.agent === "shell" ? "Terminal" : "Untitled session"), 180);
  const purpose = exPlain(detail?.brief?.about || r.overview?.purpose || r.firstPrompt);
  const latest = exPlain(r.overview?.request);
  const about = purpose && !same(purpose, title) ? purpose : latest && !same(latest, title) ? latest : "";
  const last = r.overview ? r.overview.outcome : r.lastMessage;
  const activity = exPlain(r.status === "working" ? r.step || r.now : r.status === "blocked" ? last || r.step : last, 160);
  return { title, about, activity: activity && !same(activity, about) && !same(activity, title) ? activity : "" };
}
function exByteLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Not reported";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function exElapsed(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return "Not reported";
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor(mins % 1440 / 60)}h`;
}
