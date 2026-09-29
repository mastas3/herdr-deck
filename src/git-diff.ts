// Parsing git's diff output, for the Files plugin's Changes tab and the worktree actions: which files changed
// (--name-status), by how much (--numstat), and one file's unified diff as numbered lines the page draws as is.
/** A file's badge: M changed, A added, D deleted, R renamed, ? new (untracked), U conflict. */
export type Badge = "M" | "A" | "D" | "R" | "?" | "U";

export type FileStat = { add?: number; del?: number; bin?: boolean };

/** `git diff --numstat -z`: "add\tdel\tpath\0", or for a rename "add\tdel\t\0old\0new\0"; "-\t-" is a binary file. */
export function parseNumstat(out: string): Map<string, FileStat> {
  const m = new Map<string, FileStat>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!t) continue;
    let path = t[3];
    if (!path) { i++; path = parts[++i] ?? ""; } // rename: skip the old name, keep the new
    if (!path) continue;
    const bin = t[1] === "-" && t[2] === "-";
    m.set(path, bin ? { bin: true } : { add: Number(t[1]), del: Number(t[2]) });
  }
  return m;
}

export type NameStatus = { path: string; st: Badge; old?: string };
/** `git diff --name-status -z`: "M\0path\0", "R100\0old\0new\0". */
export function parseNameStatus(out: string): NameStatus[] {
  const parts = out.split("\0");
  const list: NameStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!/^[ACDMRTUX]\d*$/.test(code)) continue;
    const c = code[0];
    if (c === "R" || c === "C") { const old = parts[++i], path = parts[++i]; if (path) list.push({ path, old: c === "R" ? old : undefined, st: c === "R" ? "R" : "A" }); continue; }
    const path = parts[++i];
    if (!path) continue;
    list.push({ path, st: c === "A" ? "A" : c === "D" ? "D" : c === "U" ? "U" : "M" });
  }
  return list;
}

/** One line of a diff: [kind, text, old line no., new line no.]. Kinds: "@" a hunk header, "+" added, "-" removed,
 *  " " context, "!" a note (binary, mode change, rename). */
export type DiffLine = [string, string, number?, number?];
const LINE_CAP = 2000;

export function parseDiff(out: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let a = 0, b = 0, inHunk = false;
  const cut = (s: string) => (s.length > LINE_CAP ? s.slice(0, LINE_CAP) + " …" : s);
  for (const raw of out.split("\n")) {
    if (raw.startsWith("diff --git ")) { inHunk = false; continue; }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { a = Number(h[1]); b = Number(h[2]); inHunk = true; lines.push(["@", cut(raw)]); continue; }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(raw)) lines.push(["!", "Binary file changed"]);
      else if (/^(new|deleted) file mode /.test(raw)) lines.push(["!", raw.startsWith("new") ? "New file" : "Deleted file"]);
      else if (raw.startsWith("old mode ")) lines.push(["!", `Mode ${raw.slice(9)}`]);
      else if (raw.startsWith("new mode ")) lines[lines.length - 1]![1] += ` → ${raw.slice(9)}`;
      else if (raw.startsWith("rename from ")) lines.push(["!", `Renamed from ${raw.slice(12)}`]);
      continue;
    }
    const k = raw[0];
    if (k === "+") lines.push(["+", cut(raw.slice(1)), undefined, b++]);
    else if (k === "-") lines.push(["-", cut(raw.slice(1)), a++]);
    else if (k === " ") lines.push([" ", cut(raw.slice(1)), a++, b++]);
    else if (k === "\\") lines.push(["!", raw.slice(2)]);
    else if (raw === "") continue; // the trailing newline
  }
  return lines;
}

/** A new file that git doesn't track yet, drawn as a diff that adds every line. */
export function addedDiff(text: string): DiffLine[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const ls = body ? body.split("\n") : [];
  return [["@", `@@ -0,0 +1,${ls.length} @@`], ...ls.map((l, i): DiffLine => ["+", l.length > LINE_CAP ? l.slice(0, LINE_CAP) + " …" : l, undefined, i + 1])];
}
