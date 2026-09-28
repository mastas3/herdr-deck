// Where the Files plugin may look. The rules are the file viewer's (src/http/files.ts resolveSafe: only your home or
// /tmp, never keys, .env files or other secrets); on top of them every path is followed through symlinks and must stay
// inside the session's folder, so a link can't lead the tree out of it.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSafe } from "../../src/http/files";

/** True when the file viewer would show this absolute path as it is (not a secret, not outside home or /tmp). */
export function viewable(abs: string): boolean {
  try { return resolveSafe(undefined, abs) === abs; } catch { return false; }
}

let home: string | undefined;
const realHome = () => (home ??= (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })());

/** A session folder's real path, when the deck may show it. Your home itself is allowed (a session can run there). */
export function safeRoot(dir: string | undefined): string | undefined {
  if (!dir || !dir.startsWith("/")) return;
  let real: string;
  try { real = realpathSync(dir); } catch { return; }
  if (real === realHome()) return real;
  return viewable(real) ? real : undefined;
}

/**
 * The absolute path of `rel` inside `root` ("" is the root), or undefined when it isn't one the plugin will touch:
 * absolute paths, "..", NUL bytes, secrets, or a real location (after symlinks) outside the root. A path that doesn't
 * exist (a deleted file) is checked through its nearest existing parent.
 */
export function inside(root: string, rel: unknown): string | undefined {
  if (typeof rel !== "string" || rel.includes("\0") || rel.length > 4096) return;
  const clean = rel.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (clean.startsWith("/") || clean.split("/").some((s) => s === ".." || s === ".")) return;
  if (!clean) return root;
  const abs = `${root}/${clean}`;
  if (!viewable(abs)) return;
  return realInside(root, abs) ? abs : undefined;
}

/** Follows symlinks from the nearest existing ancestor: is the real location inside `root`, and still viewable? */
export function realInside(root: string, abs: string): boolean {
  let probe = abs, tail = "";
  for (let guard = 0; guard < 256; guard++) {
    let real: string | undefined;
    try { real = realpathSync(probe); } catch {}
    if (real !== undefined) {
      const full = real + tail;
      if (full === root) return true;
      return full.startsWith(root + "/") && viewable(full);
    }
    const i = probe.lastIndexOf("/");
    if (i <= 0 || probe.length <= root.length) return false;
    tail = probe.slice(i) + tail;
    probe = probe.slice(0, i);
  }
  return false;
}

/** `abs` relative to `root` (either spelling: the session's cwd may be /tmp/x where the real path is /private/tmp/x). */
export function relTo(roots: string[], abs: string): string | undefined {
  for (const r of roots) if (r && abs.startsWith(r + "/")) return abs.slice(r.length + 1);
  // Through symlinks: the nearest existing parent's real path.
  let probe = abs, tail = "";
  for (let guard = 0; guard < 64 && probe.length > 1; guard++) {
    try {
      const real = realpathSync(probe) + tail;
      for (const r of roots) if (r && real.startsWith(r + "/")) return real.slice(r.length + 1);
      return;
    } catch {}
    const i = probe.lastIndexOf("/");
    if (i <= 0) return;
    tail = probe.slice(i) + tail;
    probe = probe.slice(0, i);
  }
}
