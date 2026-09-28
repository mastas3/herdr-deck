"use strict";
// The inspector's core tabs: Terminal (its element is #tpane, terminal.js), Subagents and Servers. Plus the header's
// "N servers" chip and its menu, and the links that open the inspector on a tab.
ICON.panel = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/></svg>';
CORE_ITABS.push(
  { key: "term", label: "Terminal", icon: ICON.term, order: 10, hint: "type straight into it with t", when: (r) => !r.app && !r.hist },
  { key: "agents", label: "Subagents", icon: ICON.bot, order: 40, when: (r) => isAgent(r) || !!r.subagents?.length,
    badge: (r) => { const s = subsOf(r); const run = s.filter((x) => x.running).length; return run ? `${run} running` : s.length || ""; },
    render: (el, r) => setHTML(el, subsHTML(r)), patch: (el, r) => setHTML(el, subsHTML(r)) },
  { key: "ports", label: "Servers", icon: ICON.globe, order: 50, when: (r) => !r.app && !r.hist,
    badge: (r) => r.ports?.length || "", render: renderServers, patch: patchServers, leave: () => { srv.port = null; } },
);

// ── Subagents ──
const subsOf = (r) => S.details.get(r.key)?.data?.subagents ?? r.subagents ?? [];
function subsHTML(r) {
  const d = S.details.get(r.key)?.data;
  const subs = [...subsOf(r)].sort((a, b) => Number(b.running) - Number(a.running) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (!subs.length) return d || !isAgent(r) ? `<div class="iempty"><b>No subagents yet</b><p>When the agent hands part of the work to a subagent, it shows here while it runs. Open one to read its whole conversation.</p></div>` : `<p class="hint ipad">Reading the conversation…</p>`;
  const run = subs.filter((x) => x.running).length;
  return `<p class="hint ipad">${subs.length} subagent${subs.length === 1 ? "" : "s"}${run ? `, ${run} running now` : ""}. Open one to read its conversation in the chat.</p>
    <div class="ilist">${subs.map((x) => `<button class="irow${S.sub === x.id ? " on" : ""}" data-sub="${esc(x.id)}">${x.running ? '<span class="spin"></span>' : '<span class="dot" style="--c:var(--idle)"></span>'}<span class="im"><b>${esc(x.description ?? x.id)}</b><span class="hint">${esc([x.type, x.model, x.tools ? `${x.tools} tool calls` : ""].filter(Boolean).join(" · "))}</span>${x.running && x.now ? `<span class="mono hint inow">${esc(x.now)}</span>` : ""}</span><span class="hint iw">${x.running ? "running" : x.lastActiveAt ? "done " + esc(agoText(x.lastActiveAt)) : "done"}</span></button>`).join("")}</div>`;
}
$("insp").addEventListener("click", (e) => {
  const sub = e.target.closest("[data-sub]");
  if (!sub) return;
  if (isPhone()) setMView("detail");
  openSub(sub.dataset.sub);
});

// ── Servers: the dev servers this session runs, to open, share on the tailnet, or preview right here ──
const srv = { port: null };
const localPage = () => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
/** Where a server opens from this page: its tailnet link once shared; its local address when this page runs on the
 *  same machine as the session; otherwise nowhere (share it first). */
function portUrl(r, p) {
  if (p.url) return p.url;
  if (r.machine === S.self && localPage()) return `http://127.0.0.1:${p.port}/`;
  return null;
}
/** A preview may only show a server of this session, never the deck's own page. */
const canPreview = (r, p) => { const u = portUrl(r, p); try { return !!u && new URL(u).origin !== location.origin; } catch { return false; } };
function serversList(r) {
  const ps = r.ports ?? [];
  if (!ps.length) return `<div class="iempty"><b>No servers running</b><p>When the agent starts a dev server, it shows here: open it, share it on your tailnet for your phone, or preview it in this column.</p><p><button class="btn" data-srv="ask">Ask the agent to start one…</button></p></div>`;
  return `<p class="hint ipad">Servers this session started, or that run from its folder.${S.canShare || r.machine !== S.self ? "" : " Sharing needs Tailscale on this machine."}</p><div class="ilist">${ps.map((p) => {
    const u = portUrl(r, p);
    return `<div class="irow srow${srv.port === p.port ? " on" : ""}" data-port="${p.port}"><span class="sp mono">:${p.port}</span><span class="im"><b class="mono">${esc(p.cmd)}</b>${p.url ? `<span class="hint">on your tailnet · <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ""))}</a></span>` : `<span class="hint">${esc(p.addr ?? "")}</span>`}</span>
      <span class="sacts">${u ? `<a class="btn sm" href="${esc(u)}" target="_blank" rel="noopener" title="Open in a new tab">${ICON.ext}Open</a>` : ""}${canPreview(r, p) ? `<button class="btn sm${srv.port === p.port ? " on" : ""}" data-srv="preview">Preview</button>` : ""}${p.url ? `<button class="btn sm ghost" data-srv="unshare" title="Stop sharing it on your tailnet">Stop sharing</button>` : `<button class="btn sm" data-srv="share" title="Share it on your tailnet (your phone can open it)">Share</button>`}</span></div>`;
  }).join("")}</div>`;
}
function renderServers(el, r) {
  el.innerHTML = `<div class="slist"></div><div class="spv" hidden><div class="spvh"><span class="mono"></span><span class="spacer"></span><button class="btn sm ghost" data-srv="reload">Reload</button><button class="ib" data-srv="close" aria-label="Close the preview" title="Close the preview">${ICON.x}</button></div><iframe title="Preview" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals" referrerpolicy="no-referrer"></iframe></div>`;
  patchServers(el, r);
}
function patchServers(el, r) {
  setHTML(el.querySelector(".slist"), serversList(r));
  const p = (r.ports ?? []).find((x) => x.port === srv.port);
  const box = el.querySelector(".spv"), f = box.querySelector("iframe");
  if (!p || !canPreview(r, p)) { srv.port = null; box.hidden = true; if (f.getAttribute("src")) f.removeAttribute("src"); return; }
  const u = portUrl(r, p);
  box.hidden = false;
  box.querySelector(".spvh .mono").textContent = `:${p.port} · ${u.replace(/^https?:\/\//, "")}`;
  if (f.getAttribute("src") !== u) f.setAttribute("src", u); // same address: the page keeps its state
}
$("ipane").addEventListener("click", (e) => {
  const b = e.target.closest("[data-srv]"), r = rowOf(S.sel);
  if (!b || !r) return;
  const port = Number(b.closest("[data-port]")?.dataset.port), el = $("ipane").firstElementChild;
  const act = b.dataset.srv;
  if (act === "share") return shareRow(r, port);
  if (act === "unshare") return unshareRow(r, port);
  if (act === "ask") return shareRow(r);
  if (act === "preview") srv.port = srv.port === port ? null : port;
  if (act === "close") srv.port = null;
  if (act === "reload") { const f = el?.querySelector("iframe"); if (f?.src) f.src = f.src; return; }
  if (el) patchServers(el, r);
});

// ── the header's "N servers" chip: one menu instead of a chip per port ──
function portsChip(r) {
  const ps = r.ports ?? [];
  if (!ps.length) return "";
  const shared = ps.filter((p) => p.url).length;
  return `<button class="chip2" data-dact="ports" aria-haspopup="menu" title="${esc(ps.map((p) => `:${p.port} ${p.cmd}${p.url ? " (shared)" : ""}`).join("\n"))}">${ICON.globe}${ps.length} server${ps.length === 1 ? "" : "s"}${shared ? ` · ${shared} shared` : ""}${ICON.chev}</button>`;
}
function portsMenu(anchor, r) {
  const items = [];
  for (const p of r.ports ?? []) {
    const u = portUrl(r, p);
    if (u) items.push({ html: `Open :${p.port}<small>${esc(p.cmd)} · ${esc(u.replace(/^https?:\/\//, ""))}</small>`, run: () => window.open(u, "_blank", "noopener") });
    items.push(p.url ? { html: `Stop sharing :${p.port}`, run: () => unshareRow(r, p.port) } : { html: `Share :${p.port} on your tailnet`, title: "Copies the link your phone can open", run: () => shareRow(r, p.port) });
  }
  items.push("-", { html: `Show them in the inspector<small>Open, share or preview them there</small>`, run: () => openInspector("ports") });
  openMenu(anchor, items, `${r.ports.length} server${r.ports.length === 1 ? "" : "s"} in ${r.project}`);
}
// The header's inspector links: the toggle, the servers chip, and "N subagents" in the status line.
$("detail").addEventListener("click", (e) => {
  const b = e.target.closest('[data-dact="insp"], [data-dact="ports"], [data-insp]');
  const r = rowOf(S.sel);
  if (!b || !r) return;
  e.stopPropagation();
  if (b.dataset.insp) return openInspector(b.dataset.insp);
  if (b.dataset.dact === "ports") return portsMenu(b, r);
  toggleInspector();
}, true);
