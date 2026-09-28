// Report back: when a session on this machine finishes a turn (working → idle/done, or found finished), build its
// report card from the transcript (report.ts), git (git.ts), a REPORT.md it wrote and the deck's proof of done, and
// send it to the pages. The hub also gathers the other machines' cards, keeps what you dismissed, and adds a
// "Finished in the last day" section to the morning digest. The "Ask for a report" tool is the Conductor pattern:
// the agent writes REPORT.md and a DONE marker, only when you click it.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Row } from "../../src/deck";
import type { Host } from "../../src/plugin-api";
import { detailFor } from "../../src/insight";
import { gitDelta } from "./git";
import { chipText, lastTurn, readTurn, summaryLine, verdict, type Report } from "./report";

type CoreRemotes = { all(): { online: boolean; conf: { id: string }; post(path: string, body: unknown): Promise<{ status: number; data: any }> }[] };
const AGENTS = new Set(["claude", "codex", "opencode"]);
const DAY = 86400_000;

export const REPORT_PROMPT = "Write a short report of this session's work to REPORT.md in the project root (replace any old one). Start with a one-line heading that says what you did. Then: what changed (files, commits), what you ran to check it and the result, what's left or unsure, and what you need from me (or \"nothing\"). Under 30 lines, facts only. Then create an empty file named DONE next to it. Reply with just the heading line.";

export function activate(host: Host) {
  const file = host.env("DECK_REPORT_BACK_FILE") || `${host.dataDir}/report-back.json`;
  const saved = (() => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } })();
  const reports = new Map<string, Report>((saved.reports ?? []).map((r: Report) => [r.key, r]));
  const dismissed = new Map<string, number>(Object.entries(saved.dismissed ?? {}));
  const remote = new Map<string, Report[]>();
  const status = new Map<string, string>();
  const selfId = () => host.machines().find((m) => m.local && m.kind !== "app")?.id ?? "local";
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keep = [...reports.values()].filter((r) => Date.now() - r.at < 3 * DAY).sort((a, b) => b.at - a.at).slice(0, 300);
      const dis = Object.fromEntries([...dismissed].filter(([, at]) => Date.now() - at < 3 * DAY));
      try { writeFileSync(file, JSON.stringify({ reports: keep, dismissed: dis })); } catch {}
    }, 500);
  };
  host.onStop(() => clearTimeout(saveTimer));

  const withDismissed = (r: Report): Report => ({ ...r, dismissed: (dismissed.get(r.key) ?? 0) >= r.at });
  /** Cards for the page: local ones, then the other machines' (keys as the hub knows them), for sessions still there. */
  function cards() {
    const live = new Set(host.rows().map((r) => r.key));
    return [...reports.values(), ...[...remote.values()].flat()].filter((r) => live.has(r.key)).map(withDismissed);
  }
  const send = (r: Report) => host.broadcast("report-back", { upsert: [withDismissed(r)] });

  /** The report file the agent wrote this turn (REPORT.md, and DONE beside it), in its folder or project root. */
  function reportFile(row: Row, since: number) {
    for (const dir of [...new Set([row.cwd, row.projectRoot].filter(Boolean) as string[])]) {
      const f = join(dir, "REPORT.md");
      try {
        if (statSync(f).mtimeMs < since - 1000) continue;
        const text = readFileSync(f, "utf8").slice(0, 20_000);
        return { path: f, text, done: existsSync(join(dir, "DONE")) && statSync(join(dir, "DONE")).mtimeMs >= since - 1000 };
      } catch {}
    }
  }

  async function build(row: Row): Promise<Report | undefined> {
    const d = await detailFor({ agent: row.agent, sessionId: row.sessionId, cwd: row.cwd }).catch(() => undefined);
    if (!d?.messages.length) return;
    const turn = lastTurn(d.messages);
    const { files, checks, final } = readTurn(turn);
    const since = turn[0]?.at ?? d.turnStartedAt ?? row.turnStartedAt;
    const rf = since ? reportFile(row, since) : undefined;
    const fromFile = rf && summaryLine(rf.text);
    const proofRaw = row.projectRoot ? host.checks().get(row.projectRoot) : undefined;
    const proof = proofRaw && (!since || (proofRaw.at ?? 0) >= since) && ["pass", "fail", "error"].includes(proofRaw.state) ? { state: proofRaw.state, cmd: proofRaw.cmd } : undefined;
    return {
      key: row.key, machine: row.machine, agent: row.agent, sessionId: row.sessionId!, project: row.project, title: row.title,
      at: row.lastActiveAt ?? Date.now(), since, sig: `${row.sessionId}:${row.lastActiveAt ?? 0}`,
      summary: fromFile || summaryLine(final) || (final ? "Finished (no summary in its last message)" : "Finished"), source: fromFile ? "report-file" : "message",
      files: files.slice(0, 12), fileCount: files.length,
      git: await gitDelta(row.projectRoot ?? row.cwd, since).catch(() => undefined),
      checks: checks.slice(-6), proof,
      ...(rf ? { reportFile: rf.path, doneMarker: rf.done } : {}),
    };
  }

  // One at a time, so a burst of finishing sessions never piles up transcript reads and git calls.
  const queue: Row[] = [];
  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      for (let row; (row = queue.shift()); ) {
        const r = await build(row).catch((e) => { host.log(`report-back: ${row!.key}: ${e?.message ?? e}`); return undefined; });
        if (!r) continue;
        reports.set(r.key, r);
        persist();
        send(r);
      }
    } finally { busy = false; }
  }

  /** Sessions on this machine (herdr panes and Codex app tasks) that just finished a turn, or were found finished. */
  function scan() {
    const self = selfId();
    for (const row of host.rows()) {
      if (row.hist || !row.sessionId || !AGENTS.has(row.agent) || (row.machine && row.machine !== self && row.machine !== "codex-app")) continue;
      const was = status.get(row.key);
      status.set(row.key, row.status);
      if (row.status === "working" || row.status === "blocked") continue;
      if (row.status !== "done" && was !== "working") continue;
      if (row.lastActiveAt && Date.now() - row.lastActiveAt > DAY) continue;
      const sig = `${row.sessionId}:${row.lastActiveAt ?? 0}`;
      if (reports.get(row.key)?.sig === sig || queue.some((q) => q.key === row.key)) continue;
      queue.push(row);
    }
    drain();
  }

  async function pollRemotes() {
    if (host.isNode()) return;
    const all = host.use<CoreRemotes>("remotes")?.all() ?? [];
    for (const r of all) {
      if (!r.online) continue;
      try {
        const res = await r.post("/api/report-back", { op: "list" });
        if (res.status >= 300) { remote.delete(r.conf.id); continue; }
        const next: Report[] = (res.data.reports ?? []).map((x: Report) => ({ ...x, key: `${r.conf.id}|${x.key}`, machine: r.conf.id }));
        const prev = new Map((remote.get(r.conf.id) ?? []).map((x) => [x.key, x.sig]));
        remote.set(r.conf.id, next);
        const fresh = next.filter((x) => prev.get(x.key) !== x.sig);
        if (fresh.length) host.broadcast("report-back", { upsert: fresh.map(withDismissed) });
      } catch {}
    }
  }

  /** The morning digest: what finished in the last day, everywhere. */
  async function digestLines() {
    const day = [...reports.values(), ...[...remote.values()].flat()].filter((r) => Date.now() - r.at < DAY).sort((a, b) => b.at - a.at);
    if (!day.length) return [];
    const files = day.reduce((n, r) => n + Math.max(r.fileCount, r.git?.files ?? 0), 0);
    const pass = day.filter((r) => verdict(r.checks, r.proof) === "pass").length, fail = day.filter((r) => verdict(r.checks, r.proof) === "fail").length;
    const head = [`${day.length} session${day.length === 1 ? "" : "s"} finished`, files ? `${files} files changed` : "", pass ? `checks passed in ${pass}` : "", fail ? `failed in ${fail}` : ""].filter(Boolean).join(" · ");
    return [head, ...day.slice(0, 5).map((r) => `${r.project}: ${r.summary} (${chipText(r).replace(/^Done · /, "")})`)];
  }

  host.routes("report-back", async ({ path, body }) => {
    if (path !== "/api/report-back") return undefined;
    switch (body.op) {
      case "list": return { reports: [...reports.values()].filter((r) => Date.now() - r.at < DAY) };
      case "cards": return { reports: cards() };
      case "dismiss": {
        const key = String(body.key ?? "");
        dismissed.set(key, Number(body.at) || Date.now());
        persist();
        const r = [...reports.values(), ...[...remote.values()].flat()].find((x) => x.key === key);
        if (r) send(r);
        return { ok: true };
      }
      case "refresh": {
        const row = host.rows().find((r) => r.key === body.key);
        if (!row || row.machine !== selfId() && row.machine !== "codex-app") return Response.json({ error: "Not a session on this machine" }, { status: 400 });
        const r = await build(row);
        if (r) { reports.set(r.key, r); persist(); send(r); }
        return { report: r };
      }
      case "dev-report": {
        // DECK_DEV only: a card for any row (the UI snapshot harness's fake sessions have no transcript).
        if (!host.env("DECK_DEV")) return Response.json({ error: "dev only" }, { status: 403 });
        const r: Report = { checks: [], files: [], fileCount: 0, source: "message", sig: "dev", at: Date.now(), agent: "claude", sessionId: "dev", project: "", title: "", summary: "", ...body.report };
        reports.set(r.key, r);
        send(r);
        return { ok: true };
      }
    }
    return Response.json({ error: `unknown op ${body.op}` }, { status: 400 });
  });
  host.extend("fullState", { key: "reports", get: cards });
  host.extend("digest.lines", { title: "Finished in the last day", lines: digestLines });
  host.extend("tools.entries", {
    id: "report-back", label: "Ask for a report", group: "session", icon: "note", kind: "prompt", builtin: true, agents: ["claude", "codex", "opencode"],
    hint: "The agent writes REPORT.md (what changed, checks and results, what's left, what it needs from you) and a DONE marker",
    prompt: REPORT_PROMPT,
  });
  host.every(3_000, scan);
  host.after(2_000, () => pollRemotes());
  host.every(15_000, () => pollRemotes());
}
