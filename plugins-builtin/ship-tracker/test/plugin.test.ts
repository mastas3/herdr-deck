// Ship tracker through the real plugin host: a scratch wiki and repo, stubbed history. Read-only.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-ship-`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DECK_WIKI_DIR; });
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("builds rows from the wiki, git and history, and offers a digest section", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data"), wiki = join(root, "wiki"), repo = join(root, "dialer");
  for (const d of [builtin, data, join(wiki, "projects"), repo]) mkdirSync(d, { recursive: true });
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "ship-tracker"));
  git(repo, "init", "-q"); writeFileSync(join(repo, "f"), "1"); git(repo, "add", "."); git(repo, "commit", "-qm", "one"); git(repo, "tag", "-a", "v1.0", "-m", "v1.0");
  writeFileSync(join(wiki, "projects/dialer.md"), `---\nstatus: active\n---\n\n- **Path:** \`${repo}\`\n`);
  writeFileSync(join(wiki, "projects/idea.md"), `---\nstatus: stale\n---\n\nNo path.\n`);
  process.env.DECK_WIKI_DIR = wiki;
  const asked: any[] = [];
  const now = Date.now();
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, checks: () => new Map(),
      history: async (q: any) => { asked.push(q); return q.project === "idea" ? [] : Array.from({ length: 8 }, (_, i) => ({ last: now - i * 86400_000 * 3 })); },
      sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  const r: any = await (await host.api(new Request("http://d/api/ship-tracker", { method: "POST" }), new URL("http://d/api/ship-tracker"), {}))!.json();
  const dialer = r.rows.find((x: any) => x.slug === "dialer");
  expect(dialer).toMatchObject({ tag: "v1.0", shippedBy: "tag", daysSince: 0, sessions14: 5, commits14: 1, busy: false });
  expect(r.rows.find((x: any) => x.slug === "idea")).toMatchObject({ status: "stale", sessions14: 0, busy: false });
  expect(asked.map((q) => q.project).sort()).toEqual(["dialer", "idea"]);
  expect(r.week).toBe("Shipped this week: dialer.");
  const digest = host.contributions("digest.lines") as any[];
  expect(digest[0].title).toBe("Shipping this week");
  expect(await digest[0].lines()).toEqual(new Date().getDay() === 1 ? [r.week] : []);
  await host.setEnabled("ship-tracker", false);
  expect(host.contributions("digest.lines")).toEqual([]);
});
