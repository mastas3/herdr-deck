"use strict";
// Notifications (Web Push) and the hub's automations.
// ── push notifications (Web Push through the service worker) ───────────
// The hub sends them (Settings → Automations decides what), so they arrive with the app closed.
// The old page-only alerts (toggleAlerts) stay as the fallback where push isn't available.
const PUSH = {
  supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && isSecureContext,
  ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
  standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
  on: false, me: null, devices: [],
  id: load("pushDevice", "") || (() => { const id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, ""); store("pushDevice", id); return id; })(),
};
const b64uBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const bytesB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : PUSH.ios ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Browser";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return PUSH.ios || /Android/.test(ua) ? kind : `${kind}${br ? " · " + br : ""}`;
}
/** Why this device can't get push, in words; null when it can. */
function pushBlocker() {
  if (S.push?.node) return "This machine is a node: its sessions reach you through the hub. Turn notifications on in the hub’s deck.";
  if (PUSH.ios && !PUSH.standalone) return "On iPhone and iPad, notifications only work in the installed app. In Safari tap Share → Add to Home Screen, open herdr deck from your Home Screen, then turn them on there.";
  if (!isSecureContext) return "Notifications need a secure address: open the deck over https (your tailnet link) or on localhost.";
  if (!PUSH.supported) return "This browser can’t receive push notifications.";
  if (Notification.permission === "denied") return PUSH.ios ? "Notifications are turned off for herdr deck. Turn them on in iOS Settings → Notifications → herdr deck." : /Android/i.test(navigator.userAgent) ? "Notifications are blocked for herdr deck. Long-press the herdr deck icon → App info → Notifications → Allow (or in Chrome: ⋮ → Settings → Site settings → Notifications), then reopen the deck." : "Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.";
  return null;
}
/** Keep the hub's copy of this device's subscription current (it can change under us). */
async function pushSync() {
  if (!PUSH.supported || !load("pushOn", false) || Notification.permission !== "granted" || !S.token) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && S.push?.key && bytesB64u(sub.options.applicationServerKey) !== S.push.key) { await sub.unsubscribe(); sub = null; }
    if (!sub && S.push?.key) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(S.push.key) });
    if (!sub) return;
    const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON() });
    PUSH.on = true; PUSH.me = r.device; PUSH.devices = r.devices;
  } catch (e) { console.warn("push sync:", e); }
}
async function enablePush(prefs, label) {
  const why = pushBlocker();
  if (why) throw new Error(why);
  // First thing in the tap: iOS only asks for permission from a user gesture.
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? pushBlocker() ?? "Notifications are blocked" : "Permission wasn’t granted");
  const reg = await navigator.serviceWorker.ready;
  const key = S.push?.key || (await api("/api/push/key", {})).key;
  let sub = await reg.pushManager.getSubscription();
  if (sub && bytesB64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
  const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON(), label, prefs });
  PUSH.on = true; PUSH.me = r.device; PUSH.devices = r.devices;
  store("pushOn", true);
  S.notify = false; store("notify", false); // push replaces the page-only alerts
}
async function disablePush() {
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); await sub?.unsubscribe(); } catch {}
  const r = await api("/api/push/unsubscribe", { id: PUSH.id });
  PUSH.on = false; PUSH.me = null; PUSH.devices = r.devices; store("pushOn", false);
}
const PREFS0 = { needs: true, done: true, digest: true, questDigest: true, quests: false, quiet: { on: false, from: "22:00", to: "07:30" } };
async function openNotifications() {
  let info = { devices: [] };
  try { info = await api("/api/push/key", {}); S.push = { ...S.push, key: info.key, node: info.node }; } catch (e) { toast(e.message, true); }
  PUSH.devices = info.devices ?? [];
  PUSH.me = PUSH.devices.find((d) => d.id === PUSH.id) ?? null;
  if (PUSH.supported && Notification.permission === "granted" && load("pushOn", false) && !PUSH.me) await pushSync();
  PUSH.on = !!PUSH.me && load("pushOn", false);
  const d = document.createElement("dialog");
  d.className = "ask wide notif";
  let busy = false;
  const draw = () => {
    const why = pushBlocker();
    const me = PUSH.me;
    const p = me?.prefs ?? load("pushPrefs", PREFS0);
    const others = PUSH.devices.filter((x) => x.id !== PUSH.id);
    const chk = (k, label, hint) => `<label class="nchk"><input type="checkbox" data-pref="${k}" ${(p[k] ?? PREFS0[k]) ? "checked" : ""}><span><b>${label}</b><small>${hint}</small></span></label>`;
    const state = PUSH.on && me
      ? `<div class="nstate on"><span class="dot" style="--c:var(--idle)"></span><span><b>On for this device</b><small>Through ${esc(me.service)}${me.lastOkAt ? ` · last delivered ${esc(agoText(me.lastOkAt))}` : ""}${me.lastError ? ` · <span class="warn">last try failed: ${esc(me.lastError.slice(0, 120))}</span>` : ""}</small></span></div>`
      : `<div class="nstate"><span class="dot" style="--c:var(--empty)"></span><span><b>Off for this device</b><small>${why ? "" : "Turn on to get alerts even when the deck is closed."}</small></span></div>`;
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Notifications on this device</h3>
      ${state}
      ${why ? `<p class="nwarn">${esc(why)}</p>` : ""}
      ${why && !PUSH.supported && "Notification" in window ? `<p class="hint">While the deck is open in this browser it can still alert you: <button type="button" class="btn sm" data-n="page">${S.notify ? "Turn page alerts off" : "Turn page alerts on"}</button></p>` : ""}
      <div class="nprefs"${why && !PUSH.on ? " hidden" : ""}>
      <label class="nname"><span>Name</span><input class="inp" data-n="label" value="${esc(me?.label ?? load("pushLabel", deviceLabel()))}" maxlength="40"></label>
      <h4>Send me</h4>
      ${chk("needs", "When a session needs me", "It’s waiting for an answer or a permission, on any machine")}
      ${chk("done", "When a session finishes", "It finished a turn you haven’t looked at")}
      ${chk("digest", "The morning digest", `At ${esc(S.auto?.rules?.digest?.time ?? "08:30")}: what finished overnight, what’s waiting, what’s idle (Automations sets the time)`)}
      <h4>Quests</h4>
      ${chk("questDigest", "Today’s quests in the morning digest", "Your main quest, its boss and today’s three quests")}
      ${chk("quests", "Quest wins", "A quest completed, a boss hit or defeated, an achievement, the Sunday review")}
      <label class="nchk"><input type="checkbox" data-pref="quiet" ${p.quiet?.on ? "checked" : ""}><span><b>Quiet hours</b><small>No needs-you or finished alerts from <input type="time" class="inp tm" data-n="from" value="${esc(p.quiet?.from ?? "22:00")}"> to <input type="time" class="inp tm" data-n="to" value="${esc(p.quiet?.to ?? "07:30")}"></small></span></label>
      </div>
      ${others.length ? `<h4>Other devices</h4>${others.map((x) => `<div class="mrow"><span class="dot" style="--c:var(--${x.lastError ? "blocked" : "idle"})"></span><b>${esc(x.label)}</b><span class="hint">${esc(x.service)}${x.lastOkAt ? ` · last delivered ${esc(agoText(x.lastOkAt))}` : ""}</span><span class="spacer"></span><button type="button" class="btn ghost danger" data-ndel="${esc(x.id)}">Remove</button></div>`).join("")}` : ""}
      <p class="nlog hint" aria-live="polite"></p></div>
      <div class="dlg-f">${PUSH.on && me ? `<button type="button" class="btn ghost" data-n="off">Turn off</button><span class="spacer"></span><button type="button" class="btn" data-n="test">Send a test</button>` : `<span class="spacer"></span><button type="button" class="btn primary" data-n="on" ${why ? "disabled" : ""}>Turn on</button>`}<button class="btn" value="ok" autofocus>Done</button></div></form>`;
  };
  const prefsNow = () => {
    const get = (k) => d.querySelector(`[data-pref="${k}"]`)?.checked;
    return { needs: get("needs"), done: get("done"), digest: get("digest"), questDigest: get("questDigest"), quests: get("quests"), quiet: { on: get("quiet"), from: d.querySelector('[data-n="from"]').value || "22:00", to: d.querySelector('[data-n="to"]').value || "07:30" } };
  };
  const labelNow = () => d.querySelector('[data-n="label"]').value.trim() || deviceLabel();
  let saveT;
  const saveSoon = () => {
    store("pushPrefs", prefsNow()); store("pushLabel", labelNow());
    if (!PUSH.on) return;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (!sub) return;
        const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON(), label: labelNow(), prefs: prefsNow() });
        PUSH.me = r.device; PUSH.devices = r.devices;
        d.querySelector(".nlog").textContent = "Saved";
      } catch (e) { d.querySelector(".nlog").textContent = e.message; }
    }, 350);
  };
  d.addEventListener("change", (e) => { if (e.target.closest("[data-pref], [data-n]")) saveSoon(); });
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-n], [data-ndel]");
    if (!b || b.tagName === "INPUT" || busy) return;
    const log = d.querySelector(".nlog");
    const act = b.dataset.n;
    try {
      busy = true;
      if (act === "on") {
        b.disabled = true; b.innerHTML = '<span class="spin"></span> Turning on…';
        await enablePush(prefsNow(), labelNow());
        toast("Notifications on for this device");
        draw();
        d.querySelector(".nlog").textContent = "On. Send a test to check it arrives.";
      } else if (act === "off") {
        await disablePush();
        toast("Notifications off for this device");
        draw();
      } else if (act === "test") {
        b.disabled = true; b.textContent = "Sending…";
        const r = await api("/api/push/test", { id: PUSH.id });
        PUSH.devices = r.devices; PUSH.me = r.devices.find((x) => x.id === PUSH.id) ?? PUSH.me;
        draw();
        d.querySelector(".nlog").textContent = "Sent. It should show up in a few seconds" + (document.hidden ? "." : " (on a Mac it may land in Notification Centre while the deck is in front).");
      } else if (act === "page") {
        await toggleAlerts();
        draw();
      } else if (b.dataset.ndel) {
        const x = PUSH.devices.find((v) => v.id === b.dataset.ndel);
        if (!(await askDialog({ title: `Stop notifications on ${x?.label ?? "that device"}?`, text: "It stops getting pushes. If that device still has notifications turned on, it signs up again the next time it opens the deck.", ok: "Remove", danger: true }))) return;
        const r = await api("/api/push/unsubscribe", { id: b.dataset.ndel });
        PUSH.devices = r.devices;
        draw();
      }
    } catch (x) {
      draw();
      d.querySelector(".nlog").textContent = x.message;
      toast(x.message, true);
    } finally { busy = false; }
  });
  draw();
  document.body.append(d);
  d.addEventListener("close", () => { clearTimeout(saveT); d.remove(); });
  d.showModal();
  d.scrollTop = 0; // focus sits on Done (no keyboard popping up on a phone); keep the top in view
}
// What this page is showing, so the hub doesn't push about a session you're looking at.
const PAGE_ID = Math.random().toString(36).slice(2, 12);
let presSig = "", presAt = 0;
function reportPresence() {
  if (!S.token) return;
  const shown = !document.hidden && S.sel && !S.board && !S.mode && (!isPhone() || app.dataset.mview === "detail") ? S.sel : null;
  const sig = `${shown}|${document.hidden}`;
  if (sig === presSig && Date.now() - presAt < 30_000) return;
  if (document.hidden && presSig.endsWith("|true")) return;
  presSig = sig; presAt = Date.now();
  api("/api/push/presence", { page: PAGE_ID, key: shown, visible: !document.hidden }).catch(() => {});
}
setInterval(reportPresence, 20_000);
document.addEventListener("visibilitychange", reportPresence);
/** A notification was tapped while the deck was open: go to its session (or home for the digest). */
function openFromPush(url) {
  let u;
  try { u = new URL(url, location.origin); } catch { return goHome(); }
  if (u.searchParams.get("quests")) return setMode("quests");
  if (u.pathname.startsWith("/s/")) {
    const hit = resolveLink(u.pathname);
    if (hit?.key) { S.machine = "all"; lastOrder = ""; return select(hit.key, { scroll: true, open: true }); }
    return toast(hit?.grave ? `“${hit.grave.title}” was closed. Reopen it from Closed.` : "That session isn’t open anymore.", true);
  }
  goHome();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
  const m = e.data ?? {};
  if (m.type === "open") openFromPush(m.url);
  if (m.type === "push") {
    (window.__pushes ??= []).push(m.data);
    if (m.data?.kind === "test") toast("Test notification arrived ✓");
  }
});

// ── automations (hub rules) and their cards on the live board ────────────
const hm = (mins) => (mins % 60 ? `${mins} minutes` : mins === 60 ? "an hour" : `${mins / 60} hours`);
function autoCards() {
  const A = S.auto;
  if (!A) return "";
  let out = "";
  const dg = A.digest;
  if (dg) {
    const it = (x, cls = "") => { const r = rowOf(x.key); return `<button class="dgi ${cls}" data-open="${esc(x.key)}" ${r ? "" : "disabled"} title="${esc(x.title)}"><span class="dot" style="--c:${statusVar(r?.status ?? x.status)}"></span><span class="t">${esc(shortTitle(x.title))}</span><span class="p">${esc(x.project)}${multiMachine() && x.machine ? " · " + esc(machineLabel(x.machine)) : ""}</span></button>`; };
    const cap = isPhone() ? 4 : 8;
    const sec = (label, all, n, extra = "", max = cap) => { const list = all.slice(0, max); return n ? `<div class="dgs"><h5>${label} <span class="n">${n}</span>${extra}</h5>${list.length ? `<div class="dgl">${list.map((x) => it(x)).join("")}${n > list.length ? `<span class="hint">+${n - list.length} more</span>` : ""}</div>` : ""}</div>` : ""; };
    const idleLive = (dg.idle ?? []).filter((x) => rowOf(x.key));
    out += `<div class="acard digest" data-acard="digest"><div class="ah"><span class="ai">${ICON.sun}</span><b>Morning digest</b><span class="hint">${esc(new Date(dg.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}<span class="desk"> · since yesterday 18:00</span></span><span class="spacer"></span><button class="ib" data-auto="dismissDigest" aria-label="Dismiss the digest" title="Dismiss">${ICON.x}</button></div>
      ${dg.counts.waiting + dg.counts.finished + dg.counts.running + dg.counts.idle === 0 ? `<p class="hint">Quiet night: nothing finished, nothing waiting.</p>` : ""}
      ${sec("Waiting on you", dg.waiting, dg.counts.waiting)}${sec("Finished since last evening", dg.finished, dg.counts.finished)}${sec("Still running", dg.running, dg.counts.running)}
      ${sec("Idle for 3+ days", dg.idle, dg.counts.idle, idleLive.length ? `<button class="btn sm" data-auto="closeIdle">Close these…</button>` : "", isPhone() ? 0 : 6)}</div>`;
  }
  const snoozed = new Set(load("emptySnooze", []));
  const keys = (A.empty?.keys ?? []).filter((k) => { const r = rowOf(k); return r && inScope(r) && r.empty; });
  if (keys.length && keys.some((k) => !snoozed.has(k))) {
    out += `<div class="acard emptyc" data-acard="empty"><span class="dot" style="--c:var(--empty)"></span><span class="et"><b>${keys.length} empty session${keys.length === 1 ? "" : "s"} for over ${hm(A.empty.minutes)}</b><small>${esc(keys.slice(0, 4).map((k) => shortTitle(rowOf(k).title || rowOf(k).agent)).join(", "))}${keys.length > 4 ? ` +${keys.length - 4}` : ""}</small></span><span class="spacer"></span><button class="btn ghost" data-auto="snoozeEmpty">Not now</button><button class="btn" data-auto="closeEmpty">Close all…</button></div>`;
  }
  return out;
}
$("dbody").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-auto], [data-open]");
  if (!a || !a.closest(".acard")) return;
  e.stopPropagation();
  if (a.dataset.open) return select(a.dataset.open, { scroll: true, open: true });
  const act = a.dataset.auto;
  const emptyKeys = () => (S.auto?.empty?.keys ?? []).filter((k) => { const r = rowOf(k); return r && inScope(r) && r.empty; });
  try {
    if (act === "dismissDigest") { S.auto = await api("/api/automations", { op: "dismiss-digest" }); render(); }
    else if (act === "closeEmpty") askClose(emptyKeys());
    else if (act === "snoozeEmpty") { store("emptySnooze", emptyKeys()); bodySig = ""; render(); }
    else if (act === "closeIdle") askClose((S.auto?.digest?.idle ?? []).map((x) => x.key).filter((k) => rowOf(k)));
  } catch (x) { toast(x.message, true); }
}, true);
const RULES = [
  { id: "alerts", title: "Needs you and finished alerts", text: "Push to your devices when a session starts waiting for an answer or finishes a turn you haven’t seen, on any machine. One push per session per change; three or more at once become one; nothing for a session that’s open on a screen." },
  { id: "digest", title: "Morning digest", text: "Once a day: what finished since yesterday evening, what’s waiting on you, what’s still running, and sessions idle for more than three days. Pushed to devices that want it, and shown at the top of the Live board until you dismiss it." },
  { id: "empty", title: "Empty sessions", text: "A card on the Live board when shells or agents have had no conversation for a while, with one Close all… (you confirm). Nothing is ever closed automatically." },
  { id: "proof", title: "Proof of done", text: "When an agent says it’s done, re-run the project’s own check (the command you approved once per project) and show pass or fail on the session." },
];
async function openAutomations() {
  let A;
  try { A = await api("/api/automations", { op: "get" }); } catch (e) { return toast(e.message, true); }
  const d = document.createElement("dialog");
  d.className = "ask wide autodlg";
  const draw = () => {
    const R = A.rules, st = A.status ?? {};
    const devs = A.devices ?? [];
    const cfg = {
      alerts: `<label class="nchk in"><input type="checkbox" data-r="alerts.needs" ${R.alerts.needs ? "checked" : ""}> needs you</label><label class="nchk in"><input type="checkbox" data-r="alerts.done" ${R.alerts.done ? "checked" : ""}> finished</label><span class="hint">· ${devs.length ? `${devs.length} device${devs.length === 1 ? "" : "s"}: ${esc(devs.map((x) => x.label).join(", "))}` : "no devices yet"} · <button type="button" class="link" data-a="notif">Notifications on this device…</button></span>`,
      digest: `<label class="nchk in">at <input type="time" class="inp tm" data-r="digest.time" value="${esc(R.digest.time)}"></label><button type="button" class="btn sm" data-a="digestShow">Show digest now</button><button type="button" class="btn sm" data-a="digestPush" ${devs.length ? "" : "disabled"}>Push it now</button>`,
      empty: `<label class="nchk in">after <input type="number" min="5" step="5" class="inp num" data-r="empty.minutes" value="${R.empty.minutes}"> minutes</label>${A.empty?.keys?.length ? `<span class="hint">· ${A.empty.keys.length} right now</span>` : ""}`,
      proof: "",
    };
    const last = (s) => (s?.lastRunAt ? `<span class="${s.ok === false ? "warn" : ""}">${esc(agoText(s.lastRunAt))}: ${esc(s.lastResult ?? "")}</span>` : "Hasn’t run yet");
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Automations</h3><p class="hint">Rules the hub runs for every machine it watches${A.node ? ". <b>This machine is a node</b>, so it doesn’t send pushes; the hub does" : ""}.</p>
      ${RULES.map((x) => `<div class="arule${R[x.id].on ? "" : " off"}"><label class="sw"><input type="checkbox" data-r="${x.id}.on" ${R[x.id].on ? "checked" : ""} aria-label="${esc(x.title)}"><span></span></label><div class="ab"><b>${x.title}</b><p>${x.text}</p>${cfg[x.id] ? `<div class="acfg">${cfg[x.id]}</div>` : ""}<div class="alast">Last: ${last(st[x.id])}</div></div></div>`).join("")}
      <p class="alog hint" aria-live="polite"></p></div><div class="dlg-f"><button class="btn" value="ok" autofocus>Done</button></div></form>`;
  };
  d.addEventListener("change", async (e) => {
    const f = e.target.closest("[data-r]");
    if (!f) return;
    const [rule, k] = f.dataset.r.split(".");
    const v = f.type === "checkbox" ? f.checked : f.type === "number" ? Number(f.value) : f.value;
    try { A = await api("/api/automations", { op: "set", rules: { [rule]: { [k]: v } } }); S.auto = A; draw(); render(); }
    catch (x) { d.querySelector(".alog").textContent = x.message; }
  });
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    try {
      if (b.dataset.a === "notif") { d.close(); return openNotifications(); }
      b.disabled = true;
      A = await api("/api/automations", { op: "digest", push: b.dataset.a === "digestPush" });
      S.auto = A; draw(); goHome(); render();
      d.querySelector(".alog").textContent = b.dataset.a === "digestPush" ? "Digest pushed and shown on the Live board." : "The digest is at the top of the Live board.";
    } catch (x) { d.querySelector(".alog").textContent = x.message; b.disabled = false; }
  });
  draw();
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
  d.scrollTop = 0;
}
