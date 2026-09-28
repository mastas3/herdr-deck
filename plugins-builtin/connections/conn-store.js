"use strict";
// Connections, part 1: store helpers, icons, loading inventories and recipes, the cards.
// Connections ─────────────────────────────────────────────────────────────
// An app store for what each machine can reach: categories, featured rows, search, select-all, and recipes
// that combine connections into workflows. Open it from a session to add picks to that session's context.
// Each machine keeps its own inventory; the hub gives every card a category and a state (store.ts).

// <conn-store> pure helpers (tested in test/store.test.ts)
function connState(i) { return i.state ?? (i.status === "off" ? "off" : i.status === "partial" ? "signed-out" : "ready"); }
function connSelectable(i) { return connState(i) !== "off"; }
/** Every card once, in section order. */
function connItems(inv) { const seen = new Map(); for (const s of inv?.sections ?? []) for (const i of s.items) if (!seen.has(i.id)) seen.set(i.id, i); return [...seen.values()]; }
/** Every word of the query appears in the name, what it's for, how it's reached, its group or its category. */
function connMatch(i, q, catLabel) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${i.name} ${i.detail ?? ""} ${i.note ?? ""} ${(i.via ?? []).join(" ")} ${i.group ?? ""} ${catLabel ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
/** Whether a card belongs to a rail category: "off" = not set up (recommendations have their own), "recommended" = services to sign up for. */
function connInCat(i, cat) {
  if (cat === "recommended") return i.cat === "recommended";
  if (cat === "off") return connState(i) === "off" && i.kind !== "rec";
  return i.cat === cat && connState(i) !== "off";
}
/** The cards in view: a search spans every category; otherwise one category ("off" = not set up). */
function connView(items, { cat, q, showHidden, labels }) {
  return items.filter((i) => (q ? true : connInCat(i, cat)) && (showHidden || q || !i.hidden) && connMatch(i, q, labels?.[i.cat]));
}
/** Cards whose saved login merged into a card outside Social media and Sites & accounts (GitHub, Netlify…). */
function connLoginsElsewhere(items) { return items.filter((i) => i.logins?.length && !["social", "sites"].includes(i.cat) && !i.hidden); }
/** The "Add account" picker: catalog entries grouped by category, account categories first. */
function connCatalogGroups(catalog, labels) {
  const order = ["social", "sites"], groups = new Map();
  for (const c of catalog ?? []) { const k = c.cat; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  return [...groups.entries()].sort(([a], [b]) => (order.includes(a) ? order.indexOf(a) : 9) - (order.includes(b) ? order.indexOf(b) : 9) || String(labels?.[a] ?? a).localeCompare(String(labels?.[b] ?? b)))
    .map(([cat, list]) => ({ cat, label: labels?.[cat] ?? cat, items: [...list].sort((x, y) => x.name.localeCompare(y.name)) }));
}
/** Select every selectable card in `items` (the category or search in view). Returns a new set. */
function connSelectAll(pick, items) { const s = new Set(pick); for (const i of items) if (connSelectable(i)) s.add(i.id); return s; }
/** Unselect the cards in `items`; with no items, unselect everything. Returns a new set. */
function connSelectNone(pick, items) { if (!items) return new Set(); const s = new Set(pick); for (const i of items) s.delete(i.id); return s; }
function connAllPicked(pick, items) { const sel = items.filter(connSelectable); return sel.length > 0 && sel.every((i) => pick.has(i.id)); }
/** Recipes that use any picked connection, most overlap first. */
function recipesFor(recipes, pick) {
  return recipes.map((r) => ({ r, n: [...r.ready.needs, ...r.ready.optional].filter((x) => x.id && pick.has(x.id)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n).map((x) => x.r);
}
/** "Ready to use": ready services, agents and plans, at most two per category, up to `max`. */
function connFeatured(items, order, max = 14) {
  const per = new Map(), out = [];
  const pool = items.filter((i) => connState(i) === "ready" && !i.hidden && ["service", "agent", "sub", "project"].includes(i.kind)).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || Number(!b.color) - Number(!a.color));
  for (const i of pool) { const n = per.get(i.cat) ?? 0; if (n >= 2) continue; per.set(i.cat, n + 1); out.push(i); if (out.length >= max) break; }
  return out;
}
function connRecent(items, now, days = 14) { return items.filter((i) => i.since && now - i.since < days * 864e5 && !i.hidden && connState(i) !== "off").sort((a, b) => b.since - a.since).slice(0, 12); }
// </conn-store>

const CICON = {
  home: TI2('<path d="M2.5 7.2 8 2.8l5.5 4.4M4 6v7h8V6"/>'),
  ai: TI2('<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>'),
  code: TI2('<path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5M9 3 7 13"/>'),
  cloud: TI2('<path d="M4.5 12.5h7a2.8 2.8 0 0 0 .4-5.6A4 4 0 0 0 4.2 7.5a2.5 2.5 0 0 0 .3 5z"/>'),
  data: TI2('<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/>'),
  comms: TI2('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  media: TI2('<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="m2.5 11 3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5"/><circle cx="10.5" cy="6" r="1"/>'),
  knowledge: TI2('<path d="M3 2.8h6.5A2.5 2.5 0 0 1 12 5.3v8H5.5A2.5 2.5 0 0 1 3 10.8z"/><path d="M3 10.8a2.5 2.5 0 0 1 2.5-2.5H12"/>'),
  commerce: TI2('<path d="M2 3h2l1.6 7.2h6.9L14 5H4.6"/><circle cx="6.2" cy="12.8" r=".9"/><circle cx="11.4" cy="12.8" r=".9"/>'),
  automation: TI2('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>'),
  research: TI2('<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.6 3.6"/>'),
  devices: TI2('<rect x="2" y="3" width="9" height="7" rx="1"/><path d="M4.5 12.5h4M12 6h2v7.5h-3"/>'),
  browsers: TI2('<circle cx="8" cy="8" r="5.8"/><path d="M2.3 8h11.4M8 2.2c1.7 1.7 2.4 3.6 2.4 5.8S9.7 12.1 8 13.8C6.3 12.1 5.6 10.2 5.6 8S6.3 3.9 8 2.2"/>'),
  mcp: TI2('<path d="M6 2v3.5M10 2v3.5M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>'),
  skills: TI2('<path d="M8 1.8 9.5 6l4.3.2-3.4 2.7 1.2 4.2L8 10.7l-3.6 2.4 1.2-4.2L2.2 6.2 6.5 6z"/>'),
  keys: TI2('<circle cx="5.5" cy="10.5" r="2.8"/><path d="m7.5 8.5 6-6M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/>'),
  yours: TI2('<path d="M8 3v10M3 8h10"/>'),
  off: TI2('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/>'),
  recipe: TI2('<path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3"/>'),
  sliders: TI2('<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.5"/><circle cx="10.5" cy="11.5" r="1.5"/>'),
  social: TI2('<circle cx="5" cy="8" r="1.8"/><circle cx="11.5" cy="4" r="1.8"/><circle cx="11.5" cy="12" r="1.8"/><path d="m6.6 7.1 3.3-2.1M6.6 8.9l3.3 2.1"/>'),
  sites: TI2('<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M2 6h12M4.2 4.5h.01M5.8 4.5h.01M5 9h3M5 11h6"/>'),
  recommended: TI2('<path d="M8 2.2v2.2M8 11.6v2.2M2.2 8h2.2M11.6 8h2.2M4 4l1.5 1.5M10.5 10.5 12 12M4 12l1.5-1.5M10.5 5.5 12 4"/><circle cx="8" cy="8" r="1.6"/>'),
  projects: TI2('<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="m6.5 8.5-1.5 1.5 1.5 1.5M9.5 8.5l1.5 1.5-1.5 1.5"/>'),
  ext: TI2('<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5"/>'),
};
const CST = { ready: ["ok", "Ready"], "signed-out": ["warn", "Signed out"], installed: ["mid", "Installed only"], offline: ["mid", "Offline"], account: ["mid", "Has account"], off: ["off", "Not set up"] };
S.conn = { machine: null, data: new Map(), mcp: null, pick: new Set(), cat: load("connCat2", "home"), q: "", tab: load("connTab", "store"), recipes: new Map(), rcat: "all", ropen: null, rfor: null, open: null };

function openConnections(key, tab) {
  const r = key ? rowOf(key) : rowOf(S.sel);
  S.conn.target = r && !r.app && !r.hist && isAgent(r) ? r.key : null;
  if (r && r.machine && r.machine !== "codex-app") S.conn.machine = r.machine;
  S.conn.pick.clear();
  S.conn.rfor = null;
  if (tab) S.conn.tab = tab;
  setMode("connections");
}
async function loadConnections(refresh) {
  const m = S.conn.machine ?? S.self;
  S.conn.loading = true;
  if (S.mode === "connections") renderConnections();
  try {
    const [inv, mcp] = await Promise.all([api("/api/connections", { machine: m, refresh }), S.conn.mcp ? null : api("/api/mcp-info", {}).catch(() => null)]);
    S.conn.data.set(m, inv);
    if (mcp) { S.conn.mcp = mcp; S.audit = mcp.audit; }
    if (refresh || S.conn.tab === "recipes") loadRecipes(true);
  } catch (e) { toast(e.message, true); }
  S.conn.loading = false;
  if (S.mode === "connections") renderConnections();
  // The other machines load quietly, so each card can say which machines have it.
  for (const x of realMachines()) if (x.online && x.id !== m && !S.conn.data.has(x.id)) api("/api/connections", { machine: x.id }).then((inv) => { S.conn.data.set(x.id, inv); if (S.mode === "connections") renderConnections(); }).catch(() => {});
}
async function loadRecipes(force) {
  const m = S.conn.machine ?? S.self;
  if (S.conn.rloading || (!force && S.conn.recipes.has(m))) return;
  S.conn.rloading = true;
  try { S.conn.recipes.set(m, await api("/api/recipes", { op: "list", machine: m })); } catch (e) { toast(e.message, true); }
  S.conn.rloading = false;
  if (S.mode === "connections") renderConnections();
}

const hexLight = (hex) => { const h = String(hex).replace("#", ""); if (h.length !== 6) return false; const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6; };
function connHue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const KGLYPH = { key: "keys", skill: "skills", mcp: "mcp", background: "automation", ssh: "devices", device: "devices", browser: "browsers" };
function connBadge(i, big) {
  const style = i.color ? `--bg:${i.color};--fg:${hexLight(i.color) ? "#141414" : "#fff"}` : `--bg:oklch(0.8 0.09 ${connHue(i.name)});--fg:oklch(0.26 0.06 ${connHue(i.name)})`;
  const g = KGLYPH[i.kind] ? CICON[KGLYPH[i.kind]] : i.kind === "sites" ? CICON.sites : esc(i.glyph || initials(String(i.name).replace(/[^\p{L}\p{N}\s._-]/gu, " ").trim() || "?"));
  return `<span class="cbadge${big ? " big" : ""}${String(i.glyph ?? "").length >= 3 ? " g3" : ""}" style="${style}" aria-hidden="true">${g}</span>`;
}
function connWhere(id) {
  if (S.conn.data.size < 2) return null;
  const out = [];
  for (const [mid, inv] of S.conn.data) { const i = connItems(inv).find((x) => x.id === id); if (i && connState(i) !== "off") out.push(machineLabel(mid)); }
  return out;
}
const catLabel = (inv, id) => (id === "off" ? "Not set up" : id === "home" ? "Featured" : inv?.categories?.find((c) => c.id === id)?.label ?? id ?? "");
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "");
const handleText = (h) => { const t = String(h ?? "").trim(); return !t ? "" : /^https?:\/\//.test(t) || t.startsWith("@") || t.includes(".") || t.includes("/") ? t : `@${t}`; };
/** A service worth signing up for: why it fits, free tier, the official sign-up link, what it unlocks. */
function recCard(i, n, inv, showCat) {
  const r = i.rec ?? {}, open = S.conn.open === i.id, url = safeUrl(r.url ?? i.url);
  return `<article class="ccard crec${open ? " open" : ""}${i.hidden ? " hid" : ""}" data-cid="${esc(i.id)}" style="--i:${Math.min(n, 14)}">
    <div class="ctop" data-copen>${connBadge(i)}<span class="ctt"><span class="cname">${esc(i.name)}</span><span class="ccat">${esc(showCat ? "Recommended" : catLabel(inv, i.group))}</span></span></div>
    <div class="cwhat" data-copen>${esc(i.detail ?? "")}</div>
    <p class="rwhy" data-copen>${r.project ? `<b>${esc(r.project)}</b> · ${esc(String(r.why ?? "").replace(`${r.project}: `, ""))}` : esc(r.why ?? "")}</p>
    <div class="cfoot"><span class="cst ${/^free\b|free tier|free plan|free \(/i.test(r.free ?? "") ? "ok" : "mid"}" title="Free tier">${esc(r.free ?? "")}</span><span class="spacer"></span>${url ? `<a class="btn ghost csign" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Sign up${CICON.ext}</a>` : ""}</div>
    ${open ? `<div class="cmore">
      ${r.unlocks?.length ? `<label class="clab">Unlocks recipes</label><div class="cuses">${r.unlocks.map((u) => `<button class="chip" data-cgorecipe="${esc(u.id)}">${CICON.recipe}${esc(u.title)}</button>`).join("")}</div>` : `<div class="hint">Once it's set up, agents can use it in your own recipes.</div>`}
      <div class="hint">The deck never signs up for anything. After you sign up, put its key in an env file (or sign in to its CLI) and Rescan.</div>
      <div class="cacts"><button class="btn ghost" data-chide>${i.hidden ? "Show again" : "Not interested"}</button></div>
    </div>` : ""}
  </article>`;
}
/** Logins the catalog doesn't know: a count, and the site names behind a fold. They never leave this page. */
function sitesCard(i, n) {
  const list = i.sites ?? [], picked = S.conn.pick.has(i.id);
  return `<article class="ccard csites${picked ? " picked" : ""}${i.hidden ? " hid" : ""}" data-cid="${esc(i.id)}" style="--i:${Math.min(n, 14)}">
    <button class="cpick" data-cpick aria-pressed="${picked}" aria-label="Select ${esc(i.name)}">${ICON.check}</button>
    <div class="ctop">${connBadge(i)}<span class="ctt"><span class="cname">${esc(i.name)}</span><span class="ccat">${list.length} site${list.length === 1 ? "" : "s"}</span></span></div>
    <div class="cwhat">${esc(i.detail ?? "")}</div>
    <details class="csl"${S.conn.sitesOpen ? " open" : ""}><summary data-csitesopen>Show the ${list.length} site names</summary><div class="cvia">${list.map((d) => `<span>${esc(d)}</span>`).join("")}</div></details>
    <div class="cacts"><span class="hint">Names only, from saved logins. Banks, health and government sites are never listed.</span><span class="spacer"></span><button class="btn ghost" data-chide>${i.hidden ? "Show again" : "Hide"}</button></div>
  </article>`;
}
function connCard(i, n, inv, showCat) {
  if (i.kind === "rec") return recCard(i, n, inv, showCat);
  if (i.kind === "sites") return sitesCard(i, n);
  const st = connState(i);
  const [cls, label] = i.kind === "project" && st === "installed" ? ["mid", "Not running"] : CST[st] ?? CST.ready;
  const picked = S.conn.pick.has(i.id), open = S.conn.open === i.id;
  const where = connWhere(i.id);
  const fresh = i.since && Date.now() - i.since < 14 * 864e5;
  const via = i.via ?? [];
  const uses = open ? recipesFor(S.conn.recipes.get(S.conn.machine ?? S.self)?.recipes ?? [], new Set([i.id])).slice(0, 6) : [];
  return `<article class="ccard${picked ? " picked" : ""}${open ? " open" : ""}${i.hidden ? " hid" : ""}${st === "off" ? " isoff" : ""}" data-cid="${esc(i.id)}" style="--i:${Math.min(n, 14)}">
    <button class="cpick" data-cpick aria-pressed="${picked}" aria-label="Select ${esc(i.name)}" ${st === "off" ? "disabled" : ""}>${ICON.check}</button>
    <div class="ctop" data-copen>${connBadge(i)}<span class="ctt"><span class="cname">${esc(i.name)}</span>${showCat ? `<span class="ccat">${esc(catLabel(inv, i.cat))}</span>` : ""}</span></div>
    <div class="cwhat" data-copen>${esc(i.detail || i.note || " ")}</div>
    <div class="cfoot" data-copen><span class="cst ${cls}">${label}</span>${fresh ? '<span class="cnew">New</span>' : ""}${i.note && i.detail && !open && i.note !== "installed" ? `<span class="cnote2">${esc(i.note)}</span>` : ""}${where?.length ? `<span class="cmach" title="On ${esc(where.join(", "))}">${where.map((w) => `<i>${esc(w)}</i>`).join("")}</span>` : ""}</div>
    ${open ? `<div class="cmore">
      ${i.handle || i.url ? `<div class="chandle">${safeUrl(i.url) ? `<a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener noreferrer">${esc(handleText(i.handle) || i.url)}${CICON.ext}</a>` : esc(handleText(i.handle))}</div>` : ""}
      ${via.length ? `<div class="cvia">${via.map((v) => `<span>${esc(v)}</span>`).join("")}</div>` : ""}
      ${i.note ? `<div class="hint">${esc(i.note)}</div>` : ""}
      ${i.path ? `<div class="hint"><code>${esc(i.path)}</code></div>` : ""}
      ${i.tools?.length ? `<label class="clab">MCP tools</label><div class="cvia">${i.tools.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
      ${i.connect?.length ? `<label class="clab">How agents connect</label><ul class="cconn">${i.connect.map((c) => { const k = c.indexOf(": "); return `<li><b>${esc(c.slice(0, k))}</b> ${esc(c.slice(k + 2))}</li>`; }).join("")}</ul>` : ""}
      <label class="clab">How agents should use it</label>
      <textarea class="cuse" data-cnote rows="3" placeholder="e.g. Deploy with npx netlify-cli deploy --prod">${esc(i.use ?? "")}</textarea>
      ${uses.length ? `<label class="clab">Recipes that use it</label><div class="cuses">${uses.map((r) => `<button class="chip" data-cgorecipe="${esc(r.id)}">${CICON.recipe}${esc(r.title)}</button>`).join("")}</div>` : ""}
      <div class="cacts"><button class="btn ghost" data-chide>${i.hidden ? "Show again" : "Hide"}</button>${i.custom ? `<button class="btn ghost danger" data-cremove>Remove</button>` : ""}${i.site ? `<button class="btn ghost" data-cacct="${esc(i.site)}">${i.own ? "Edit account" : "Add your handle"}</button>` : ""}${i.own ? `<button class="btn ghost danger" data-cunacct="${esc(i.site)}">Forget handle</button>` : ""}<span class="spacer"></span>${st === "off" ? "" : `<button class="btn" data-cone>Add just this</button>`}</div>
    </div>` : ""}
  </article>`;
}
function connMini(i, inv) {
  const st = connState(i);
  return `<button class="cmini" data-cjump="${esc(i.id)}" data-cjcat="${esc(i.cat)}" title="${esc(i.detail ?? "")}">${connBadge(i, true)}<span class="cmn">${esc(i.name)}</span><span class="cms">${esc(catLabel(inv, i.cat))}</span>${st !== "ready" ? `<span class="cst ${CST[st]?.[0] ?? "off"}">${CST[st]?.[1] ?? ""}</span>` : ""}</button>`;
}
function recMini(i) {
  const r = i.rec ?? {};
  return `<button class="cmini rmini" data-cjump="${esc(i.id)}" data-cjcat="recommended" title="${esc(r.why ?? "")}">${connBadge(i, true)}<span class="cmn">${esc(i.name)}</span><span class="cms">${esc(r.project ?? i.detail ?? "")}</span></button>`;
}
function selBar(items, what) {
  const sel = items.filter(connSelectable);
  if (!sel.length) return "";
  const all = connAllPicked(S.conn.pick, items);
  return `<div class="csel"><span class="hint">${items.length} ${items.length === 1 ? "card" : "cards"}${sel.length < items.length ? ` · ${sel.length} selectable` : ""}</span><span class="spacer"></span>
    ${all ? `<button class="btn ghost" data-csnone>Unselect ${esc(what)}</button>` : `<button class="btn ghost" data-csall>${ICON.check}Select all ${sel.length} ${esc(what)}</button>`}</div>`;
}
