// code-plugins.json (beside plugins.json, in the deck's data folder): which code plugins are on (built-ins are on
// unless turned off), each installed plugin's origin and the approved sha256 of every one of its files, and settings.
// Plus the file hashing both the trust screen and the startup check use.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CodeFrom = { folder?: string; git?: string; commit?: string };
export type CodeRecord = { id: string; name: string; version: string; from: CodeFrom; files: Record<string, string>; hash: string; approvedAt: number };
export type CodeState = { enabled: Record<string, boolean>; installed: CodeRecord[]; settings: Record<string, Record<string, boolean | number | string>> };

const FILE = "code-plugins.json";
export const MAX_FILES = 2000, MAX_BYTES = 50 * 1024 * 1024;

export function loadCodeState(root: string): CodeState {
  try {
    const j = JSON.parse(readFileSync(join(root, FILE), "utf8"));
    return {
      enabled: j?.enabled && typeof j.enabled === "object" ? Object.fromEntries(Object.entries(j.enabled).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean> : {},
      installed: Array.isArray(j?.installed) ? j.installed.filter((r: any) => typeof r?.id === "string" && r.files && typeof r.files === "object") : [],
      settings: j?.settings && typeof j.settings === "object" ? j.settings : {},
    };
  } catch { return { enabled: {}, installed: [], settings: {} }; }
}
export function saveCodeState(root: string, st: CodeState) {
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(st, null, 1));
  renameSync(tmp, join(root, FILE));
}

/** sha256 of every file under dir (relative paths, "/" separated), skipping .git. Symlinks count as changes: they
 *  could point anywhere, so a folder with one can't be approved. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0, bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (name === ".git") continue;
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) throw new Error(`${r} is a symbolic link; a plugin's files must be real files in its folder`);
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) continue;
      if (++n > MAX_FILES || (bytes += st.size) > MAX_BYTES) throw new Error(`the folder is too big (over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB)`);
      out[r] = createHash("sha256").update(readFileSync(join(dir, r))).digest("hex");
    }
  };
  walk("");
  return out;
}
/** One hash for a whole approved file set. */
export function hashOf(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest("hex");
}
/** Anything added, removed or edited since approval (or unreadable) counts as changed. */
export function treeChanged(dir: string, approved: Record<string, string>): boolean {
  try { return hashOf(hashTree(dir)) !== hashOf(approved); } catch { return true; }
}
