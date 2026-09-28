"use strict";
// The page's plugin registry. A plugin's scripts load after the deck's own (src/assets.ts), only while it's on, and
// say what they add with deckPlugins.register(id, { views, tabs, palette, keys, settings, events, state, links }).
// The core reads this instead of naming the extras: setMode/renderMode (views), the view tab bar (tabs), ⌘K (palette),
// the keyboard (keys), the Settings menu (settings), the SSE stream (events), each full state (state) and deep links
// (links). Any plugin can open its own extension point too: others extend("discover.tabs", …), it reads contributions().
// Two more the core reads: "project.link" { icon, open(name) } (where a project's name leads) and "notify.prefs"
// { title, prefs: [{ key, label, hint, default }] } (a section of the Notifications dialog; the hub keeps it by key).
const deckPlugins = (() => {
  /** Keys and views the core owns: a plugin can't take them. */
  const CORE_KEYS = new Set([..."/jkr.ihtg`\\lnfyxsbe[]c?123456789", "Escape", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  const CORE_VIEWS = new Set(["inbox", "history", "tools", "plugins"]);
  const points = new Map(), views = new Map(), keys = new Map(), ids = new Set();
  const warn = (id, msg) => console.warn(`deckPlugins: ${id}: ${msg}`);
  function extend(id, point, c) {
    if (typeof point !== "string" || !point) return warn(id, "extend needs a point name");
    points.set(point, [...(points.get(point) ?? []), { id, c }]);
  }
  /**
   * @param {string} id the plugin's id (plugin.json)
   * @param {object} spec
   *   views:    { [mode]: { render(), load?(), leave?(), path?() } }   setMode(mode) shows it; path() is its URL
   *   tabs:     [{ view, label, icon, key?, order }]                    the view tab bar (core: inbox 10, history 20, plugins 90)
   *   palette:  (q, cur) => [{ t, run, k?, echo?, slot?: "views"|"more", order? } | { section, html, run }]
   *   keys:     { [key]: (event) => void }                              single keys the core doesn't use
   *   settings: [{ html, run }]                                         Settings menu items (before Keyboard shortcuts)
   *   events:   { [sseEvent]: (data) => void }                          the plugin's server broadcasts
   *   state:    (fullState) => void                                     every full state (page load, reconnect)
   *   links:    (url: URL) => boolean                                   a deep link it handles (true: handled)
   * @returns {{ extend(point: string, c: any): void }}
   */
  function register(id, spec = {}) {
    ids.add(id);
    for (const [mode, v] of Object.entries(spec.views ?? {})) {
      if (CORE_VIEWS.has(mode) || views.has(mode)) warn(id, `the view ${mode} is taken`);
      else if (typeof v?.render !== "function") warn(id, `the view ${mode} has no render()`);
      else views.set(mode, { ...v, id });
    }
    for (const t of spec.tabs ?? []) extend(id, "view.tabs", t);
    if (spec.palette) extend(id, "palette.entries", spec.palette);
    for (const [k, run] of Object.entries(spec.keys ?? {})) {
      if (CORE_KEYS.has(k) || keys.has(k)) warn(id, `the key ${k} is taken`);
      else keys.set(k, { id, run });
    }
    for (const s of spec.settings ?? []) extend(id, "settings.entries", s);
    for (const [event, fn] of Object.entries(spec.events ?? {})) extend(id, "sse.events", { event, fn });
    if (spec.state) extend(id, "state", spec.state);
    if (spec.links) extend(id, "links", spec.links);
    return { extend: (point, c) => extend(id, point, c) };
  }
  /** Calls each contribution to a point that is a function, and keeps going when one throws. */
  function each(point, ...args) {
    const out = [];
    for (const c of contributions(point)) { try { out.push(c(...args)); } catch (e) { console.error(`deckPlugins: ${point}:`, e); } }
    return out;
  }
  const contributions = (point) => (points.get(point) ?? []).map((x) => x.c);
  return {
    register, contributions, each,
    view: (mode) => (mode ? views.get(mode) : undefined),
    key: (k) => keys.get(k)?.run,
    /** Registered in this page (its scripts loaded). */
    has: (id) => ids.has(id),
    /** Running on the deck (its server side is on), from the page's state. */
    on: (id) => (S.plugins?.active ?? []).includes(id),
  };
})();
