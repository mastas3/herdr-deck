// What the idea tools build from: your projects, found repos, connections, tools and interests as "ingredients", and the
// compact catalog of them a model sees. Privacy: names and one-liners only, secret-looking strings redacted.
// Discover's Mixer, Studio and feed and Opportunities' "use my advantages" all send this catalog.
export type IngKind = "project" | "repo" | "conn" | "tool" | "interest";
export type Ingredient = { id: string; kind: IngKind; name: string; desc: string; group?: string; ready: boolean };
export const KIND_LABEL: Record<IngKind, string> = { project: "Your projects", repo: "Gems & trending", conn: "Connections & services", tool: "Tools & skills", interest: "Interests" };

// ── privacy: what may reach a model ─────────────────────────────────────────────────
/** Secret-looking strings out, home paths shortened. Belt and braces: the inventory holds names, not values. */
export function redact(s: unknown): string {
  return String(s ?? "")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[abprs]-|AKIA|AIza|ya29\.|glpat-|hf_)[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS))\s*[=:]\s*\S+/g, "$1")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}
const clip = (s: unknown, n: number) => { const t = redact(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
/** Store entries that say nothing a build could use: launchd jobs, browser profiles, SSH aliases, plan details. */
const NOISE_DESC = /^(background service|homebrew service|ssh host|chrome profile|brave profile)|subscription|\bplan$|sign-in$/i;
const BLANK_DESC = /^(>-?|\|)?$|^(local|remote) mcp server$/i;
const descOf = (x: Ingredient, n: number) => (BLANK_DESC.test(x.desc.trim()) ? "" : clip(x.desc, n));

// ── the catalog: the whole inventory, compact ───────────────────────────────────────────
/** Names and one-liners, grouped by kind and category. Only ready things (you can't build on what isn't set up). */
export function buildCatalog(ings: Ingredient[], maxChars = 18_000): string {
  const ready = ings.filter((x) => x.ready && x.name && !NOISE_DESC.test(x.desc.trim()));
  const of = (k: IngKind) => ready.filter((x) => x.kind === k);
  const render = (d: { p: number; r: number; c: number; t: number }) => {
    const out: string[] = ["# His inventory (use these exact names)"];
    const projects = of("project").filter((x) => !["legacy", "note"].includes(x.group ?? "")).slice(0, 70);
    if (projects.length) out.push("", `## ${KIND_LABEL.project} (name [status]: what it is)`, ...projects.map((x) => `- ${clip(x.name, 60)} [${x.group ?? "?"}]${descOf(x, d.p) ? `: ${descOf(x, d.p)}` : ""}`));
    const repos = of("repo").slice(0, 30);
    if (repos.length) out.push("", "## Open-source repos he found (gems & trending on GitHub)", ...repos.map((x) => `- ${clip(x.name, 70)}${descOf(x, d.r) ? `: ${descOf(x, d.r)}` : ""}`));
    for (const [k, title, n] of [["conn", "Services & connections he has, by category", d.c], ["tool", "Agent tools, models, MCP servers & skills", d.t]] as const) {
      const xs = of(k);
      if (!xs.length) continue;
      const groups = new Map<string, Ingredient[]>();
      for (const x of xs) groups.set(x.group ?? "Other", [...(groups.get(x.group ?? "Other") ?? []), x]);
      out.push("", `## ${title}`);
      for (const [g, ys] of groups) out.push(`- ${clip(g, 40)}: ${ys.slice(0, 45).map((x) => { const dd = descOf(x, n); return dd ? `${clip(x.name, 50)} (${dd})` : clip(x.name, 50); }).join("; ")}`);
    }
    const ints = of("interest");
    if (ints.length) out.push("", "## His interests", `- ${ints.map((x) => clip(x.name, 40)).join("; ")}`);
    return out.join("\n");
  };
  // Shorter descriptions until it fits: the names always stay.
  for (const d of [{ p: 110, r: 80, c: 40, t: 50 }, { p: 80, r: 60, c: 28, t: 32 }, { p: 50, r: 40, c: 0, t: 0 }, { p: 0, r: 0, c: 0, t: 0 }]) {
    const s = render(d);
    if (s.length <= maxChars) return s;
  }
  return render({ p: 0, r: 0, c: 0, t: 0 }).slice(0, maxChars);
}
