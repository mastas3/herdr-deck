"use strict";
// AI accounts and their limits: the part of the status line that says which account a session spends and how much of it
// is left, and the Usage view listing every account on every machine. The server sends `usage` as
// { self, machines, accounts: [{ id, provider, name, label, email, plan, kind, at, windows, balance, error, note, machines, from }] }.
ICON.gauge = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.6-3.4"/><path d="M4.2 11.5h.01M11.8 11.5h.01"/></svg>';

// ── usage logic (pure: test/usage-page.test.ts evaluates this block on its own) ──
const USAGE_STALE_MS = 30 * 60_000;
/** The machine a row runs on, as `usage` names it (Codex app threads are this machine's). */
function usageMachine(r, selfId) { return !r?.machine || r.machine === "codex-app" ? selfId : r.machine; }
/** The provider a session spends: Claude and Codex are their own; OpenCode says which provider its model is from. */
function usageProvider(r) { return r?.agent === "opencode" ? r.provider : r?.agent; }
/** The account a session spends: that machine's login for its provider. */
function accountFor(r, u, selfId) {
  const provider = usageProvider(r);
  if (!provider || !Array.isArray(u?.accounts)) return undefined;
  const m = usageMachine(r, selfId);
  return u.accounts.find((a) => a.provider === provider && a.machines?.includes(m));
}
/** fresh, stale (older than 30 minutes), unknown (nothing read yet) or error (the provider refused, nothing older to show). */
function usageState(a, now) {
  if (!a) return "unknown";
  if (a.error && !a.balance) return "error";
  if (!a.at || (!a.windows?.length && !a.balance)) return "unknown";
  return now - a.at > USAGE_STALE_MS ? "stale" : "fresh";
}
/** A window as it stands now: its percent, or null when it was never read or has reset since the reading. */
function windowNow(w, now) {
  if (w?.pct == null) return { ...w, pct: null, why: "unknown" };
  if (w.resets && w.resets <= now) return { ...w, pct: null, why: "reset" };
  return { ...w, why: "" };
}
const usd = (n) => (n == null ? "" : `$${Number(n).toFixed(2)}`);
// ── end usage logic

function acctTip(a) {
  const st = usageState(a, Date.now());
  const where = (a.machines ?? []).map(machineLabel).join(", ");
  return [
    `${a.name}${a.email ? ` · ${a.email}` : a.label ? ` · ${a.label}` : ""}${a.plan ? ` · ${a.plan}` : ""}`,
    a.at ? `${st === "stale" ? "stale: " : ""}as of ${agoText(a.at)}${a.from ? `, from ${machineLabel(a.from)}` : ""}` : a.error || a.note || "no reading yet",
    where && `signed in on ${where}`,
  ].filter(Boolean).join("\n");
}

/** The status line's account chip and limit meters for a session (meter() is detail.js's). */
function usageParts(r) {
  const a = accountFor(r, S.usage, S.self);
  const now = Date.now();
  if (!a) {
    if (r.agent !== "claude" && r.agent !== "codex") return [];
    return [`<button class="sl-acct unknown" data-usage title="${esc(`No ${r.agent === "claude" ? "Claude" : "Codex"} account reading from ${machineLabel(usageMachine(r, S.self))} yet`)}">${r.agent} ?</button>`];
  }
  const st = usageState(a, now);
  const out = [`<button class="sl-acct ${st}" data-usage title="${esc(acctTip(a))}">${esc(a.kind === "credits" ? a.name : a.label || a.name)}${st === "stale" ? ` · ${esc(ago(a.at))} old` : ""}</button>`];
  if (a.windows?.length) {
    for (const w0 of a.windows) {
      const w = windowNow(w0, now);
      const what = `${a.name} ${w.label} limit`;
      if (w.pct == null) out.push(`<span class="meter u unknown" title="${esc(w.why === "reset" ? `${what} has reset since the last reading` : `${what}: not reported`)}"><span class="ml">${esc(w.label)}</span><b>?</b></span>`);
      else out.push(meter(w.pct, w.label, `${what}${st === "stale" ? ` (stale: as of ${agoText(a.at)})` : ""}`, w.resets, undefined, `u ${st === "stale" ? "stale" : ""}`));
    }
  } else if (a.balance?.left != null) out.push(`<span class="meter u ${st === "stale" ? "stale" : ""}" title="${esc(acctTip(a))}"><span class="ml">credits</span><b>${esc(usd(a.balance.left))}</b><span class="mx">left</span></span>`);
  else if (a.kind !== "signin") out.push(`<span class="meter u unknown" title="${esc(a.error || a.note || "no reading yet")}"><span class="ml">limits</span><b>?</b></span>`);
  return out;
}

// Usage view ───────────────────────────────────────────────────────────────
function usageCard(a) {
  const now = Date.now(), st = usageState(a, now);
  const badge = { fresh: "current", stale: `stale · ${agoText(a.at)}`, unknown: a.kind === "signin" ? "signed in" : "no reading", error: "error" }[st];
  const bars = (a.windows ?? []).map((w0) => {
    const w = windowNow(w0, now);
    const p = w.pct == null ? 0 : Math.max(0, Math.min(100, Math.round(w.pct)));
    return `<div class="uwin ${w.pct == null ? "unknown" : p >= 85 ? "hot" : p >= 60 ? "warm" : ""}"><span class="ml">${esc(w.label)}</span><span class="mb"><i style="width:${p}%"></i></span><b>${w.pct == null ? "?" : p + "%"}</b><span class="ur">${esc(w.why === "reset" ? "reset since" : w.resets ? "resets " + inText(w.resets) : "")}</span></div>`;
  }).join("");
  const b = a.balance;
  const bal = b ? `<div class="ubal"><b>${esc(usd(b.left))}</b> left${b.total != null ? ` of ${esc(usd(b.total))}` : ""}${b.used != null ? ` · ${esc(usd(b.used))} used` : ""}</div>` : "";
  const foot = [a.at ? `as of ${agoText(a.at)}${a.from ? `, from ${machineLabel(a.from)}` : ""}` : "", a.error, !a.at && !a.error ? a.note : ""].filter(Boolean).join(" · ");
  return `<div class="ucard ${st}">
    <div class="uh"><b>${esc(a.name)}</b>${a.label ? `<span class="ulabel">${esc(a.label)}</span>` : ""}<span class="ust">${esc(badge)}</span></div>
    <div class="um">${esc([a.email, a.plan, (a.machines ?? []).map(machineLabel).join(", ")].filter(Boolean).join(" · "))}</div>
    ${bars}${bal}${foot ? `<div class="uf">${esc(foot)}</div>` : ""}</div>`;
}
function renderUsage() {
  const all = S.usage?.accounts ?? [];
  const group = (title, list) => (list.length ? `<section class="tgroup"><h3>${esc(title)}</h3><div class="ugrid">${list.map(usageCard).join("")}</div></section>` : "");
  modeHTML(`<header class="vh"><h2>${ICON.gauge}Usage</h2><p>Every AI account signed in on your machines, with the limits and balances the tools and providers report. Readings older than 30 minutes are marked stale; nothing read is shown as unknown, never 0%.</p></header>
    ${all.length ? "" : `<p class="hint">No accounts found yet.</p>`}
    ${group("Plans", all.filter((a) => a.kind === "plan"))}${group("Credits", all.filter((a) => a.kind === "credits"))}${group("Signed in, no usage data", all.filter((a) => a.kind === "signin"))}`);
  motion.bars($("dbody").querySelector(":scope > .view"), true); // bars fill in when the view opens, then glide on updates
}
$("statusline").addEventListener("click", (e) => { if (e.target.closest("[data-usage], .meter.u")) setMode("usage"); });
