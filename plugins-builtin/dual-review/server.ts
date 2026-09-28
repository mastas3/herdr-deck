// Dual review: Claude and Codex review the same diff in two sessions, each writes its findings to a file, and the
// Review view lines the two lists up (agree / only Claude / only Codex). Picked findings go back to the session that
// made the change as one message. Nothing starts or sends without the page's confirm dialog ("confirmed": true).
import type { Host } from "../../src/plugin-api";
import { composeMessage, matchFindings, parseRange, type Side } from "./review-match";
import { createReviewStore, diffStat, expandHome, SIDES, type Review } from "./review-store";

export function activate(host: Host) {
  const store = createReviewStore(host.env("DECK_DUAL_REVIEW_DIR") || `${host.dataDir}/dual-review`);
  const live = () => new Set(host.rows().map((r) => r.key));

  function summary(r: Review, keys = live()) {
    const sides = Object.fromEntries(SIDES.map((s) => [s, { status: store.sideStatus(r, s, keys), key: r.sides[s].key, model: r.sides[s].model, error: r.sides[s].error, n: store.findings(r, s)?.length }]));
    return { id: r.id, cwd: r.cwd, project: r.project, range: r.range, words: r.words, origin: r.origin, createdAt: r.createdAt, sent: r.sent ?? [], sides };
  }
  function full(r: Review) {
    const c = store.findings(r, "claude"), x = store.findings(r, "codex");
    return { ...summary(r), groups: c || x ? matchFindings(c ?? [], x ?? []) : [], ready: !!(c && x) };
  }
  const need = (id: unknown) => { const r = store.read(String(id ?? "")); if (!r) throw new Error("That review is gone"); return r; };
  const picked = (r: Review, picks: unknown) => {
    const groups = full(r).groups;
    const out = (Array.isArray(picks) ? picks : []).map(Number).filter((i) => Number.isInteger(i) && groups[i]).map((i) => groups[i]);
    if (!out.length) throw new Error("Pick at least one finding");
    return out;
  };

  // Tell open pages when a findings file lands, so the view fills in without polling.
  let last = "";
  host.every(10_000, () => {
    const keys = live();
    const sig = JSON.stringify(store.all().slice(0, 20).map((r) => [r.id, SIDES.map((s) => store.sideStatus(r, s, keys))]));
    if (sig !== last) { if (last) host.broadcast("dual-review", { changed: true }); last = sig; }
  });

  host.routes("dual-review", async ({ path, body }) => {
    if (path !== "/api/dual-review") return undefined;
    const op = String(body?.op ?? "list");
    try {
      if (op === "list") { const keys = live(); return { reviews: store.all().slice(0, 50).map((r) => summary(r, keys)) }; }
      if (op === "get") return full(need(body.id));
      if (op === "diffstat") {
        const rg = parseRange(body.range ?? "");
        if (!rg.ok) return { stat: "", files: 0, error: rg.error };
        return await diffStat(expandHome(body.cwd), rg.diff);
      }
      if (op === "plan") return store.plan(body);
      if (op === "start") {
        if (body.confirmed !== true) throw new Error("Starting reviewers needs your confirmation");
        const p = store.plan(body);
        const origin = body.origin?.key ? { key: String(body.origin.key), title: String(body.origin.title ?? "").slice(0, 120) } : undefined;
        const r = store.create(p, origin);
        for (const s of p.sessions) {
          try {
            const res = await host.sessions.start({ kind: s.kind, cwd: s.cwd, prompt: s.prompt, label: s.label, model: s.model, args: ["--add-dir", store.dirOf(r.id)] });
            r.sides[s.side as Side] = { ...r.sides[s.side as Side], key: res?.key, startedAt: Date.now() };
          } catch (e: any) { r.sides[s.side as Side].error = e?.message ?? String(e); }
        }
        store.save(r);
        return full(r);
      }
      if (op === "compose") { const r = need(body.id); return { text: composeMessage(picked(r, body.picks), r), to: body.key ?? r.origin?.key }; }
      if (op === "send") {
        if (body.confirmed !== true) throw new Error("Sending needs your confirmation");
        const r = need(body.id);
        const key = String(body.key ?? r.origin?.key ?? "");
        if (!key) throw new Error("Pick the session to send to");
        const groups = picked(r, body.picks);
        await host.sessions.send(key, composeMessage(groups, r));
        r.sent = [...(r.sent ?? []), { at: Date.now(), n: groups.length }];
        store.save(r);
        return { ok: true, n: groups.length };
      }
      if (op === "delete") { store.remove(String(body.id ?? "")); return { ok: true }; }
      return Response.json({ error: "Unknown op" }, { status: 400 });
    } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
}
