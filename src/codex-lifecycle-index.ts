// thread/list omits modern paginated tasks in some desktop versions. The owned index is read-only here.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-store";
import { CodexControlError } from "./codex-ipc";

export function archivedCodexTasks(cursor?: string, home = codexHome()) {
  let before: { updated: number; id: string } | undefined;
  if (cursor != null) try {
    if (typeof cursor !== "string" || cursor.length > 1000) throw new Error();
    before = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!before || !Number.isFinite(before.updated) || typeof before.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(before.id)) throw new Error();
  } catch { throw new CodexControlError("Invalid archive cursor", "CODEX_INVALID"); }
  let db: Database | undefined;
  try {
    const name = readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
    if (!name) return { tasks: [], nextCursor: null };
    db = new Database(join(home, name), { readonly: true });
    const columns = new Set((db.query("pragma table_info(threads)").all() as any[]).map((r) => r.name));
    const label = columns.has("name") ? "coalesce(nullif(name, ''), title)" : "title";
    const rows = db.query(`select id, cwd, ${label} as title, coalesce(updated_at, 0) as updated from threads
      where source = 'vscode' and archived = 1 ${before ? "and (coalesce(updated_at, 0) < ? or (coalesce(updated_at, 0) = ? and id < ?))" : ""}
      order by coalesce(updated_at, 0) desc, id desc limit 51`).all(...(before ? [before.updated, before.updated, before.id] : [])) as any[];
    const page = rows.slice(0, 50), last = page.at(-1);
    return { tasks: page.map((r) => ({ id: r.id, cwd: r.cwd, title: r.title?.trim() || "Codex task" })),
      nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ updated: last.updated, id: last.id })).toString("base64url") : null };
  } catch (e: any) {
    if (e.code === "ENOENT") return { tasks: [], nextCursor: null };
    throw new CodexControlError("Could not read the Codex task archive.");
  } finally { db?.close(); }
}
