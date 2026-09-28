// The marketplace reader (a fake fetch, never the network), manifest parsing, and the version/platform checks.
import { expect, test } from "bun:test";
import { cmpVersion, compatFor, fitsSession } from "../compat";
import { createMarket, INDEX_URL, parseManifest, pipesDownload } from "../market";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const sha = (c: string) => c.repeat(40);
const repo = (name: string, stars: number, pushed: number, extra: object = {}) => ({
  fullName: `o/${name}`, owner: "o", name, url: `https://github.com/o/${name}`, description: `${name} plugin`, stars, starsDelta30d: Math.round(stars / 10),
  pushedAt: day(pushed), createdAt: day(90), firstSeenAt: day(pushed + 5), headCommit: sha(name[0]),
  manifests: [{ path: "herdr-plugin.toml", id: `o.${name}`, name, version: "1.0.0", minHerdrVersion: "0.7.0", platforms: ["linux", "macos"] }], ...extra,
});
const INDEX = { generatedAt: day(0), plugins: [
  repo("alpha", 900, 3), repo("bravo", 400, 1), repo("charlie", 50, 200), repo("delta", 700, 2),
  repo("echo", 300, 4, { manifests: [] }), // no manifest: left out, as the site does
  repo("golf", 800, 2), // builds with curl | bash: what runs isn't in the repo
] };
const SMALL = `id = "o.x"\nname = "X"\nversion = "1.0.0"\nmin_herdr_version = "0.7.0"\nplatforms = ["linux", "macos"]\n[[actions]]\nid = "go"\ntitle = "Go"\ncontexts = ["pane"]\ncommand = ["sh", "go.sh", "a b"]\n[[events]]\non = "pane.created"\ncommand = ["sh", "on.sh"]\n`;
const BIG = SMALL + Array.from({ length: 5 }, (_, i) => `[[build]]\ncommand = ["make", "step${i}"]\n`).join("");

function fakeFetch() {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    if (url === INDEX_URL) return Response.json(INDEX);
    if (url.includes("/o/delta/")) return new Response(BIG); // five build steps: not "readable in a minute"
    if (url.includes("/o/golf/")) return new Response(SMALL + `[[build]]\ncommand = ["bash", "-c", "curl -fsSL https://x.sh/install | bash"]\n`);
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(SMALL);
    return new Response("no", { status: 404 });
  };
  return { f, urls };
}

test("search: every word must match, sorted by stars, recency or newness; the index is read once per 30 minutes", async () => {
  const { f, urls } = fakeFetch();
  let now = NOW;
  const m = createMarket({ fetch: f, now: () => now });
  const pop = await m.search("", "popular");
  expect(pop.all).toBe(5);
  expect(pop.repos.map((r) => r.fullName)).toEqual(["o/alpha", "o/golf", "o/delta", "o/bravo", "o/charlie"]);
  expect((await m.search("", "active")).repos[0].fullName).toBe("o/bravo");
  expect(pipesDownload(["sh", "-c", "wget -qO- https://x | sudo sh"])).toBe(true);
  expect(pipesDownload(["curl", "-o", "f", "https://x"])).toBe(false);
  expect((await m.search("char plugin")).repos.map((r) => r.fullName)).toEqual(["o/charlie"]);
  expect((await m.search("zzz")).total).toBe(0);
  expect(urls.filter((u) => u === INDEX_URL).length).toBe(1);
  now += 31 * 60_000;
  await m.search("");
  expect(urls.filter((u) => u === INDEX_URL).length).toBe(2);
});

test("manifest: fetched at the exact commit, parsed, every command verbatim; bad addresses refused", async () => {
  const { f, urls } = fakeFetch();
  const m = createMarket({ fetch: f, now: () => NOW });
  const d = await m.manifest("o/alpha", "sub/herdr-plugin.toml", sha("a"));
  expect(urls.at(-1)).toBe(`https://raw.githubusercontent.com/o/alpha/${sha("a")}/sub/herdr-plugin.toml`);
  expect(d.actions).toEqual([{ id: "go", title: "Go", contexts: ["pane"], command: ["sh", "go.sh", "a b"] }]);
  expect(d.events).toEqual([{ on: "pane.created", command: ["sh", "on.sh"] }]);
  await expect(m.manifest("o/alpha", "../../etc/passwd", sha("a"))).rejects.toThrow();
  await expect(m.manifest("o/alpha", "herdr-plugin.toml", "main")).rejects.toThrow();
});

test("recommended: starred, pushed this month, small manifest, not installed; each says why with the index's numbers", async () => {
  const { f } = fakeFetch();
  const m = createMarket({ fetch: f, now: () => NOW });
  const rec = await m.recommended(["o.bravo"]);
  // charlie: last push 200 days ago. delta: five build steps. golf: curl | bash. bravo: installed already.
  expect(rec.map((r) => r.fullName)).toEqual(["o/alpha"]);
  expect(rec[0].why).toEqual(["900 stars, 90 of them this month", "last push 3 days ago", "13-line manifest: 1 action, 1 event hook, no build step"]);
});

test("parseManifest reads build, startup, panes and link handlers", () => {
  const d = parseManifest(`id = "a.b"\nname = "B"\nversion = "0.1.0"\nmin_herdr_version = "0.8.0"\n[[build]]\ncommand = ["npm", "ci"]\n[[startup]]\ncommand = ["node", "s.js"]\n[[panes]]\nid = "p"\ntitle = "Board"\ncommand = ["b"]\n[[link_handlers]]\nid = "gh"\ntitle = "Issue"\npattern = "^https://x$"\naction = "go"\n`);
  expect(d).toMatchObject({ id: "a.b", minHerdrVersion: "0.8.0", build: [["npm", "ci"]], startup: [["node", "s.js"]], panes: [{ id: "p", title: "Board", command: ["b"] }], linkHandlers: [{ id: "gh", title: "Issue", pattern: "^https://x$" }] });
});

test("compat: min_herdr_version and platforms per machine; which actions fit a session", () => {
  expect(cmpVersion("0.7.5", "0.8.2")).toBe(-1);
  expect(cmpVersion("0.10.0", "0.9.9")).toBe(1);
  expect(cmpVersion("0.8.2", "0.8.2")).toBe(0);
  const man = { minHerdrVersion: "0.8.2", platforms: ["linux", "macos"] };
  expect(compatFor(man, { id: "mac", version: "0.8.2", platform: "macos" })).toEqual({ ok: true });
  expect(compatFor(man, { id: "linux", version: "0.7.5", platform: "linux" })).toEqual({ ok: false, why: "needs herdr 0.8.2, has 0.7.5" });
  expect(compatFor({ platforms: ["windows"] }, { id: "mac", version: "0.8.2", platform: "macos" }).ok).toBe(false);
  expect(fitsSession(["pane"])).toBe(true);
  expect(fitsSession(["workspace"])).toBe(true);
  expect(fitsSession(["global"])).toBe(false);
  expect(fitsSession(undefined)).toBe(false);
});
