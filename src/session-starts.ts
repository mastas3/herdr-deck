// A first message is durable before any worktree or pane is created. Never replay an uncertain delivery.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Row } from "./deck";

export type StartState = "creating" | "starting" | "sending" | "ready" | "failed" | "unknown" | "dismissed";
export type StartRecord = {
  id: string; signature: string; body: any; title: string; state: StartState; createdAt: number; updatedAt: number;
  key?: string; sessionId?: string; error?: string; result?: any;
};
export type StartSummary = Omit<StartRecord, "signature" | "body" | "result"> & { hasPrompt: boolean };
const FIELDS = ["kind", "cwd", "prompt", "label", "model", "effort", "mode", "args", "herdr", "workspaceId", "claudeProfile", "worktree", "focus"];
const unfinished = (s: StartState) => !["ready", "dismissed"].includes(s);
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export function createStartStore(file?: string) {
  let records = new Map<string, StartRecord>(), loadError = "";
  const summary = (r: StartRecord): StartSummary => {
    const { signature, body, result, ...s } = r;
    return { ...s, hasPrompt: !!body.prompt };
  };
  function save(next: Map<string, StartRecord>) {
    if (loadError) throw new Error(loadError);
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify([...next.values()]), { mode: 0o600 });
      renameSync(tmp, file);
    }
    records = next;
  }
  function update(id: string, patch: Partial<StartRecord>) {
    const old = records.get(id);
    if (!old) throw new Error("Saved start not found");
    const r = { ...old, ...patch, id, updatedAt: Date.now() };
    save(new Map(records).set(id, r)); return r;
  }
  return {
    load() {
      if (!file) return;
      try {
        const list = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(list) || list.some(r => !r?.id || !r.body || !r.state)) throw new Error("invalid start records");
        records = new Map(list.map(r => [r.id, r]));
        for (const r of records.values()) if (["creating", "starting", "sending"].includes(r.state)) {
          update(r.id, { state: "unknown", error: "The deck restarted during startup. Check the session before sending the saved message again." });
        }
      } catch (e: any) { if (e.code !== "ENOENT") loadError = "Cannot read saved starts. New sessions are paused to protect their messages."; }
    },
    begin(input: any) {
      if (loadError) throw new Error(loadError);
      const id = input.requestId ?? crypto.randomUUID();
      if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid start request ID");
      const body = canonical(Object.fromEntries(FIELDS.filter(k => input[k] !== undefined).map(k => [k, input[k]])));
      if (Buffer.byteLength(String(body.prompt ?? "")) > 64 * 1024) throw new Error("First message is too large; attach the text after starting the session.");
      const signature = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const old = records.get(id);
      if (old) {
        if (old.signature !== signature) throw new Error("This start request already belongs to different session options.");
        return { record: old, fresh: false };
      }
      const title = String(body.label || body.prompt || basename(body.cwd || "") || body.kind || "Session").replace(/\s+/g, " ").slice(0, 100);
      const now = Date.now(), record: StartRecord = { id, signature, body, title, state: "creating", createdAt: now, updatedAt: now };
      // Keep unresolved messages until explicitly dismissed; compact only old completed receipts.
      const completed = [...records.values()].filter(r => r.state === "ready").sort((a, b) => b.createdAt - a.createdAt);
      const keep = new Set(completed.slice(0, 200).map(r => r.id));
      const next = new Map([...records].filter(([k, r]) => r.state !== "ready" || keep.has(k)));
      save(next.set(id, record));
      return { record, fresh: true };
    },
    update,
    get: (id: string) => records.get(id),
    list: () => [...records.values()].filter(r => unfinished(r.state)).sort((a, b) => b.createdAt - a.createdAt).map(summary),
    forRow(row: Pick<Row, "key" | "sessionId">) {
      const r = [...records.values()].reverse().find(r => r.key === row.key && unfinished(r.state) && (!r.sessionId || r.sessionId === row.sessionId));
      return r ? summary(r) : undefined;
    },
    error: () => loadError,
  };
}
export type StartStore = ReturnType<typeof createStartStore>;

export function showStart(row: Row, start?: StartSummary): Row {
  if (!start) return row;
  return { ...row, startup: start, empty: false, stale: false, ...(row.empty ? { title: start.title } : {}) };
}
