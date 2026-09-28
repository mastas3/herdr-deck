// Can a plugin run on a machine: its min_herdr_version against that machine's herdr, and its platforms against the OS.
// herdr itself refuses to install or link a plugin that needs a newer herdr, so the deck says so before anyone tries.

/** -1, 0 or 1, comparing "0.7.5" style versions numerically (missing parts count as 0; pre-release tags are ignored). */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

export type MachineInfo = { id: string; label?: string; version?: string; platform?: string };
export type Compat = { ok: boolean; why?: string };

/** Whether a plugin (its manifest's min_herdr_version and platforms) fits a machine, and why not in plain words. */
export function compatFor(m: { minHerdrVersion?: string; platforms?: string[] }, machine: MachineInfo): Compat {
  if (!machine.version) return { ok: false, why: "herdr not found" };
  if (m.platforms?.length && machine.platform && !m.platforms.includes(machine.platform)) return { ok: false, why: `not for ${machine.platform}` };
  if (m.minHerdrVersion && cmpVersion(machine.version, m.minHerdrVersion) < 0) return { ok: false, why: `needs herdr ${m.minHerdrVersion}, has ${machine.version}` };
  return { ok: true };
}

/** herdr's action contexts: global, workspace, tab, pane, selection. None listed means it runs anywhere (global).
 *  A session (a pane) fits an action that works on a pane, its tab or its workspace. */
export function fitsSession(contexts: string[] | undefined): boolean {
  return !!contexts?.some((c) => c === "pane" || c === "tab" || c === "workspace");
}
