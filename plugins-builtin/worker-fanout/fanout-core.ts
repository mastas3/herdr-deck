// Worker fan-out, the pure part: checking what the user asked for, the footer every worker's brief gets (write
// REPORT.md, then a DONE marker), a worker's state from its files and session, and the merged summary.

export type WorkerSpec = { cwd: string; kind: string; model?: string; label?: string };
export type Worker = WorkerSpec & { n: number; dir: string; key?: string; error?: string; startedAt?: number };
export type Run = { id: string; title: string; brief: string; createdAt: number; workers: Worker[]; collected?: { at: number; key: string }[]; announced?: boolean };
export type WorkerState = "running" | "done" | "failed" | "stopped";
export type Files = { report?: string; done: boolean; failed: boolean };

export const KINDS = ["claude", "codex", "opencode"];
export const MAX_WORKERS = 12;

/** The user's form, cleaned: a title, a brief, 1–12 workers with a folder and a known agent. */
export function checkSpec(o: { title?: unknown; brief?: unknown; workers?: unknown }): { title: string; brief: string; workers: WorkerSpec[] } {
  const brief = String(o.brief ?? "").trim();
  if (brief.length < 10) throw new Error("Write the brief first (what every worker should do)");
  const list = Array.isArray(o.workers) ? o.workers : [];
  if (!list.length) throw new Error("Add at least one worker");
  if (list.length > MAX_WORKERS) throw new Error(`At most ${MAX_WORKERS} workers at once`);
  const workers = list.map((w: any, i) => {
    const cwd = String(w?.cwd ?? "").trim(), kind = String(w?.kind ?? "claude");
    if (!cwd) throw new Error(`Worker ${i + 1} needs a folder`);
    if (!KINDS.includes(kind)) throw new Error(`Worker ${i + 1}: unknown agent “${kind}”`);
    const model = String(w?.model ?? "").trim() || undefined;
    if (model && !/^[\w.:\/\[\]-]{1,80}$/.test(model)) throw new Error(`Worker ${i + 1}: “${model}” isn’t a model name`);
    return { cwd, kind, model, label: String(w?.label ?? "").trim().slice(0, 40) || undefined };
  });
  const first = brief.split("\n")[0].trim();
  const title = String(o.title ?? "").trim().slice(0, 80) || (first.length > 60 ? first.slice(0, 60).replace(/\s+\S*$/, "") + "…" : first);
  return { title, brief, workers };
}

/** What a worker is told after the brief: where to report and how to say it's finished. */
export function workerPrompt(run: Pick<Run, "title" | "brief">, w: Pick<Worker, "n" | "cwd" | "dir">, total: number) {
  return `${run.brief.trim()}

---
You are worker ${w.n} of ${total} on “${run.title}”. Work in ${w.cwd}.
When you are finished:
1. Write your report to ${w.dir}/REPORT.md: what you did, what changed (files, commits, branch), what is left, and anything you are unsure about.
2. Then create the empty file ${w.dir}/DONE.
If you can't finish, still write REPORT.md saying why, and create ${w.dir}/FAILED instead of DONE.
Nobody will ask you for status: the report is how you report back.`;
}

/** done/failed come from the marker files; a session that closed without either has stopped. */
export function workerState(w: Worker, f: Files, alive: boolean, now = Date.now()): WorkerState {
  if (f.done) return "done";
  if (f.failed || w.error) return "failed";
  if (alive || now - (w.startedAt ?? 0) < 90_000) return "running";
  return "stopped";
}

const WORD: Record<WorkerState, string> = { running: "still running", done: "done", failed: "failed", stopped: "stopped without a report" };
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (cut here; the full report is in the file)" : s);

/** One message with every report, for the session that coordinates. */
export function mergeReports(run: Run, states: { w: Worker; state: WorkerState; report?: string }[], perReport = 6000) {
  const count = (s: WorkerState) => states.filter((x) => x.state === s).length;
  const tally = (["done", "failed", "stopped", "running"] as WorkerState[]).filter(count).map((s) => `${count(s)} ${WORD[s]}`).join(", ");
  const parts = states.map(({ w, state, report }) => {
    const head = `## Worker ${w.n}: ${w.label || w.cwd.split("/").pop()} (${w.kind}${w.model ? ` ${w.model}` : ""}, ${w.cwd}), ${WORD[state]}`;
    return `${head}\n\n${report?.trim() ? cap(report.trim(), perReport) : "(no report written)"}`;
  });
  return [`Reports from the ${states.length} worker${states.length === 1 ? "" : "s"} on “${run.title}” (${tally}).`, ...parts, "Read them together: say what is finished, what conflicts between workers, and what should happen next."].join("\n\n");
}
