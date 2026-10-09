"use strict";
// Pure directory hierarchy: machine identity + full path, never a project's display name.
function exPath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "";
  const parts = [];
  for (const p of raw.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
  return "/" + parts.join("/");
}
const exId = (machine, path) => JSON.stringify([machine, path]);
const exWithin = (parent, path) => path === parent || path.startsWith(parent === "/" ? "/" : parent + "/");
const exHome = path => path.match(/^\/(?:Users|home)\/[^/]+/)?.[0] || ((path === "/root" || path.startsWith("/root/")) ? "/root" : "/");
function exForest(machines, rows, self, listings = new Map(), homes = new Map()) {
  const roots = [], nodes = new Map();
  const physical = machines.filter(m => m.kind !== "app");
  const owner = r => machines.find(m => m.id === r.machine)?.kind === "app" ? self : r.machine;
  for (const r of rows) if (!physical.some(m => m.id === owner(r))) physical.push({ id: owner(r), label: owner(r), online: false });
  for (const m of physical) {
    const own = rows.filter(r => owner(r) === m.id);
    const base = homes.get(m.id) || exPath(m.home) || exHome(own.map(r => exPath(r.projectRoot || r.cwd)).find(Boolean) || "/");
    const root = { id: exId(m.id, ""), machine: m.id, name: m.label, path: base, root: true, info: m, children: [], rows: [], all: own, parent: null };
    roots.push(root); nodes.set(root.id, root);
    function ensure(raw) {
      const path = exPath(raw);
      if (!path || path === base) return root;
      const id = exId(m.id, path);
      if (nodes.has(id)) return nodes.get(id);
      const inHome = exWithin(base, path);
      const pp = path.slice(0, path.lastIndexOf("/")) || "/";
      const parent = (inHome && pp === base) || path === "/" ? root : ensure(pp);
      const node = { id, machine: m.id, name: path === "/" ? "Filesystem" : path.split("/").pop(), path, info: m, children: [], rows: [], all: [], parent: parent.id };
      nodes.set(id, node); parent.children.push(node); return node;
    }
    for (const r of own) { const n = ensure(r.projectRoot || r.cwd); n.rows.push(r); n.project = n.project || r.project; }
    for (const [id, listing] of listings) {
      if (JSON.parse(id)[0] !== m.id || !listing.data) continue;
      ensure(listing.data.path);
      for (const dir of listing.data.folders) ensure(dir.path);
    }
    function finish(n) {
      const all = [...n.rows];
      for (const child of n.children) all.push(...finish(child));
      n.all = all; n.attention = all.filter(r => ["failed", "unknown"].includes(r.startup?.state) || r.status === "blocked" || r.status === "done" && !r.seen).length;
      n.working = all.filter(r => r.status === "working").length;
      n.children.sort((a, b) => Number(!a.all.length) - Number(!b.all.length) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      return all;
    }
    finish(root);
  }
  return { roots, nodes };
}

// Search loaded folders as well as matching sessions, keeping every ancestor on the way.
function exSearch(forest, query) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const plain = words.filter(w => !w.startsWith("-") && !w.includes(":"));
  const excluded = words.filter(w => w.startsWith("-")).map(w => w.slice(1));
  const folderQuery = plain.length > 0 && !words.some(w => /^(is|agent):/.test(w));
  function visit(n) {
    const path = `${n.path} ${n.info.label}`.toLowerCase();
    const own = folderQuery && plain.every(w => path.includes(w)) && !excluded.some(w => path.includes(w));
    const children = n.children.map(visit).some(Boolean);
    n.matches = !words.length || n.rows.length > 0 || own || children;
    return n.matches;
  }
  forest.roots.forEach(visit);
}

// Live changes must not move a target under a resting pointer or a finger.
function exFreezeOrder(forest, previous) {
  const preserve = (items, before, key) => {
    const rank = new Map(before.map((item, i) => [key(item), i]));
    items.sort((a, b) => (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity));
  };
  for (const n of forest.nodes.values()) {
    const before = previous.get(n.id);
    if (before) { preserve(n.rows, before.rows, r => r.key); preserve(n.children, before.children, c => c.id); }
  }
}
