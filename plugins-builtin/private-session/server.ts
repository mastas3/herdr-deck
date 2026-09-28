// Private session: "New private session" starts in a throwaway folder (<data>/private/deck-private-<id>), which the
// core keeps out of the history index and deep search (src/private-folder.ts). When the session closes, the page
// offers to delete what it left behind, listing exactly those files first; nothing is deleted without that confirm.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "../../src/plugin-api";
import { isPrivatePath, PRIVATE_PREFIX } from "../../src/private-folder";
import { deletePlan, planFiles } from "./private-files";

type Entry = { cwd: string; key?: string; agent?: string; title?: string; seenAt: number; closedAt?: number; deletedAt?: number };

export function activate(host: Host) {
  const home = host.env("DECK_PRIVATE_HOME") || homedir();
  const root = host.env("DECK_PRIVATE_DIR") || `${host.dataDir}/private`;
  const stateFile = `${host.dataDir}/private-sessions.json`;
  const read = (): Entry[] => { try { return JSON.parse(readFileSync(stateFile, "utf8")).sessions ?? []; } catch { return []; } };
  const write = (l: Entry[]) => writeFileSync(stateFile, JSON.stringify({ sessions: l.slice(-100) }, null, 1));
  const since = (e: Entry) => e.seenAt - 86400_000; // Codex rollouts older than the session can't be it
  const local = (cwd: string) => cwd.startsWith(root + "/") && isPrivatePath(cwd);

  /** Follow private sessions in the list; one that has gone is "closed", and open pages are told. */
  function tick() {
    const rows = host.rows().filter((r) => isPrivatePath(r.cwd) && local(r.cwd));
    const list = read();
    let changed = false;
    for (const r of rows) {
      const e = list.find((x) => x.key === r.key) ?? list.find((x) => x.cwd === r.cwd && !x.closedAt);
      if (!e) { list.push({ cwd: r.cwd, key: r.key, agent: r.agent, title: r.title, seenAt: Date.now() }); changed = true; }
      else if (e.key !== r.key || e.closedAt || (r.title && e.title !== r.title)) { Object.assign(e, { key: r.key, agent: r.agent, title: r.title || e.title }); delete e.closedAt; changed = true; }
    }
    const live = new Set(rows.map((r) => r.key));
    for (const e of list) {
      if (e.closedAt || e.deletedAt || !e.key || live.has(e.key)) continue;
      e.closedAt = Date.now(); changed = true;
      host.broadcast("private-session", { closed: e.cwd });
    }
    // Folders made for a dialog you cancelled: empty and never used after an hour, they go.
    for (const n of (() => { try { return readdirSync(root); } catch { return []; } })()) {
      const p = join(root, n);
      if (!n.startsWith(PRIVATE_PREFIX) || list.some((e) => e.cwd === p)) continue;
      try { if (Date.now() - statSync(p).mtimeMs > 3600_000 && !readdirSync(p).length) rmdirSync(p); } catch {}
    }
    if (changed) write(list);
  }
  host.every(5_000, tick);

  host.routes("private-session", ({ path, body }) => {
    if (path !== "/api/private-session") return undefined;
    const op = String(body?.op ?? "list");
    try {
      if (op === "prepare") {
        mkdirSync(root, { recursive: true });
        const cwd = join(root, `${PRIVATE_PREFIX}${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`);
        mkdirSync(cwd, { mode: 0o700 });
        return { cwd };
      }
      if (op === "list") {
        tick();
        return { root, sessions: read().slice().reverse().map((e) => ({ ...e, live: !!e.key && host.rows().some((r) => r.key === e.key), exists: existsSync(e.cwd) })) };
      }
      const e = read().find((x) => x.cwd === body.cwd);
      if (!e || !local(String(body.cwd))) throw new Error("That isn’t one of the private sessions");
      if (op === "files") return planFiles({ home, cwd: e.cwd, since: since(e) });
      if (op === "delete") {
        if (body.confirmed !== true) throw new Error("Deleting needs your confirmation");
        if (e.key && host.rows().some((r) => r.key === e.key)) throw new Error("Close the session first");
        const r = deletePlan({ home, cwd: e.cwd, root, since: since(e), files: Array.isArray(body.files) ? body.files.map(String) : [], lines: body.lines === true });
        const list = read();
        const x = list.find((y) => y.cwd === e.cwd);
        if (x) { x.deletedAt = Date.now(); x.title = undefined; write(list); }
        return r;
      }
      if (op === "forget") { write(read().filter((x) => x.cwd !== e.cwd)); return { ok: true }; }
      return Response.json({ error: "Unknown op" }, { status: 400 });
    } catch (err: any) { return Response.json({ error: err?.message ?? String(err) }, { status: 400 }); }
  });
}
