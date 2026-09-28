// Release train, the pure part: the per-project config (stages QA → staging → production, each with a branch or tag,
// a health URL or check command, and a deploy command), git's answers read into stages, and the deploy brief an agent
// session gets on "promote". The deck itself never runs a deploy command.

export type Stage = { name: string; ref: string; health?: string; check?: string; deploy?: string };
export type Project = { id: string; name: string; repo: string; agent: string; model?: string; stages: Stage[] };
export type Commit = { sha: string; short: string; subject: string; author: string; at: number };

const REF = /^(?!-)[\w.\/@^~{}*-]{1,120}$/;
const AGENTS = ["codex", "claude", "opencode"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** A project as the user typed it, checked: 2–6 stages, safe refs, http(s) health URLs. */
export function checkProject(o: any): Project {
  const name = String(o?.name ?? "").trim().slice(0, 60);
  const repo = String(o?.repo ?? "").trim();
  if (!name) throw new Error("Give the project a name");
  if (!repo) throw new Error("Which folder is the repo?");
  const list = Array.isArray(o?.stages) ? o.stages : [];
  const stages: Stage[] = list.filter((s: any) => String(s?.name ?? "").trim() || String(s?.ref ?? "").trim()).map((s: any, i: number) => {
    const st: Stage = { name: String(s.name ?? "").trim().slice(0, 30) || `Stage ${i + 1}`, ref: String(s.ref ?? "").trim() };
    if (!REF.test(st.ref)) throw new Error(`${st.name}: “${st.ref}” isn’t a branch or tag I can read`);
    const health = String(s.health ?? "").trim(), check = String(s.check ?? "").trim(), deploy = String(s.deploy ?? "").trim();
    if (health && !/^https?:\/\/\S+$/.test(health)) throw new Error(`${st.name}: the health check must be an http(s) URL`);
    if (health) st.health = health;
    if (check) st.check = check.slice(0, 500);
    if (deploy) st.deploy = deploy.slice(0, 500);
    return st;
  });
  if (stages.length < 2 || stages.length > 6) throw new Error("A train needs 2 to 6 stages");
  const agent = AGENTS.includes(o?.agent) ? o.agent : "codex";
  const model = String(o?.model ?? "").trim();
  if (model && !/^[\w.:\/\[\]-]{1,80}$/.test(model)) throw new Error(`“${model}” isn’t a model name`);
  return { id: slug(String(o?.id ?? "")) || slug(name) || "project", name, repo, agent, model: model || undefined, stages };
}

export const DEFAULT_STAGES: Stage[] = [{ name: "QA", ref: "qa" }, { name: "Staging", ref: "staging" }, { name: "Production", ref: "main" }];

/** A ref with * is a tag pattern (the newest matching tag is the stage); anything else is a branch, tag or commit. */
export const isPattern = (ref: string) => ref.includes("*");

const SEP = "\x1f";
export const LOG_FORMAT = ["%H", "%h", "%s", "%an", "%ct"].join(SEP);
export function parseLog(out: string): Commit[] {
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, short, subject, author, at] = l.split(SEP);
    return { sha, short, subject: subject ?? "", author: author ?? "", at: Number(at) * 1000 || 0 };
  }).filter((c) => /^[0-9a-f]{7,64}$/.test(c.sha));
}

/** What an agent session is told to do on promote. It deploys; the deck only starts it. */
export function promoteBrief(o: { project: Project; from: Stage; to: Stage; fromHead?: Commit; toHead?: Commit; commits: Commit[]; more: number }) {
  const { project: p, from, to } = o;
  const head = (s: Stage, c?: Commit) => `${s.name} (${s.ref}) is at ${c ? `${c.short} “${c.subject}”` : "an unknown commit"}`;
  const list = o.commits.slice(0, 40).map((c) => `- ${c.short} ${c.subject} (${c.author})`).join("\n");
  return [
    `Promote ${p.name} from ${from.name} to ${to.name}.`,
    `Repo: ${p.repo}\n${head(from, o.fromHead)}; ${head(to, o.toHead)}.`,
    o.commits.length ? `${o.commits.length + o.more} commit${o.commits.length + o.more === 1 ? "" : "s"} go out:\n${list}${o.more ? `\n…and ${o.more} more` : ""}` : `No commits are waiting between ${from.name} and ${to.name}: check with me before deploying anything.`,
    to.deploy ? `The deploy step for ${to.name} (from the release-train settings): \`${to.deploy}\`` : `There is no deploy command set for ${to.name}. Work out how this repo deploys to ${to.name} and tell me the exact commands before you run them.`,
    `Before you deploy, read the commits above and stop to ask me if anything looks risky: migrations, env or config changes, breaking API changes. Move ${to.ref} only the way this repo usually does it.`,
    `After: ${to.health ? `check ${to.health} answers` : to.check ? `run \`${to.check}\`` : "check the service is healthy"}, then report what you did, what is now on ${to.name}, and anything odd.`,
  ].join("\n\n");
}
