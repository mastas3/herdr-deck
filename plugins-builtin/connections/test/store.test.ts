import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Inventory, Item } from "../connections";
import { categorize, enrich, stateOf } from "../store";
import { RECIPES, fillPrompt, rankRecipes, readiness, recipeIds, type Recipe } from "../recipes";

// The store's pure helpers live in the browser script between <conn-store> markers; run exactly that block.
const src = readFileSync(new URL("../conn-store.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("// <conn-store>"), src.indexOf("// </conn-store>"));
const B = new Function(`"use strict";${block};return { connState, connItems, connView, connSelectAll, connSelectNone, connAllPicked, recipesFor, connFeatured, connRecent, connMatch, connInCat, connLoginsElsewhere, connCatalogGroups };`)();

const it = (id: string, name: string, over: Partial<Item> = {}): Item => ({ id, name, kind: "service", status: "ready", ...over });

describe("categories", () => {
  test("new scans carry their category", () => {
    expect(categorize(it("svc:gumroad", "Gumroad", { cat: "commerce" }), "services")).toBe("commerce");
  });
  test("older nodes: groups, names and sections map onto store categories", () => {
    expect(categorize(it("svc:github", "GitHub", { group: "Code & deploy" }), "services")).toBe("code");
    expect(categorize(it("svc:netlify", "Netlify", { group: "Code & deploy" }), "services")).toBe("cloud");
    expect(categorize(it("svc:stripe", "Stripe", { group: "Payments" }), "services")).toBe("commerce");
    expect(categorize(it("svc:gmail", "Gmail", { group: "Messaging" }), "services")).toBe("comms");
    expect(categorize(it("svc:notion", "Notion", { group: "Messaging" }), "services")).toBe("knowledge");
    expect(categorize(it("svc:elevenlabs", "ElevenLabs", { group: "AI" }), "services")).toBe("media");
    expect(categorize(it("svc:tailscale", "Tailscale", { group: "Network" }), "services")).toBe("devices");
    expect(categorize(it("agent:claude", "Claude Code", { kind: "agent" }), "ai")).toBe("ai");
    expect(categorize(it("mcp:x", "x", { kind: "mcp" }), "mcp")).toBe("mcp");
    expect(categorize(it("ssh:box", "box", { kind: "ssh" }), "machines")).toBe("devices");
    expect(categorize(it("key:a", "A_KEY", { kind: "key" }), "keys")).toBe("keys");
    expect(categorize(it("dev:git", "Git", { kind: "cli" }), "dev")).toBe("code");
    expect(categorize(it("skill:x", "x", { kind: "skill" }), "skills")).toBe("skills");
    expect(categorize(it("custom:x", "x", { kind: "custom", custom: true }), "custom")).toBe("yours");
    expect(categorize(it("custom:y", "y", { kind: "custom", custom: true, cat: "data" }), "custom")).toBe("data");
  });
  test("states from old and new scans", () => {
    expect(stateOf(it("a", "a", { status: "off" }))).toBe("off");
    expect(stateOf(it("a", "a", { status: "partial" }))).toBe("signed-out");
    expect(stateOf(it("a", "a", { state: "installed" }))).toBe("installed");
    expect(stateOf(it("a", "a"))).toBe("ready");
  });
  test("enrich gives every item a category and state, and lists the categories", () => {
    const e = enrich({ machine: "m", at: 0, ms: 0, sections: [{ id: "services", title: "", hint: "", items: [it("svc:github", "GitHub", { group: "Code & deploy" })] }, { id: "missing", title: "", hint: "", items: [it("svc:aws", "AWS", { status: "off", group: "Cloud" })] }] });
    expect(e.categories.length).toBeGreaterThan(12);
    expect(e.sections[0].items[0]).toMatchObject({ cat: "code", state: "ready" });
    expect(e.sections[1].items[0]).toMatchObject({ cat: "cloud", state: "off" });
  });
});

const inv = (items: Item[]): Inventory => ({ machine: "test", at: 0, ms: 0, sections: [{ id: "services", title: "", hint: "", items }] });

describe("recipe readiness", () => {
  const r: Recipe = { id: "t", title: "T", pitch: "", cat: "cloud", steps: [], prompt: "Do it on {machine}.\n\n{connections}", needs: [{ label: "Deploy", any: ["svc:netlify", "svc:vercel"] }, { label: "SSH", any: ["ssh:*"] }], optional: [{ label: "Mail", any: ["svc:gmail"] }] };
  test("ready when every need has a ready connection; prefix ids match", () => {
    const rd = readiness(r, inv([it("svc:vercel", "Vercel", { state: "ready" }), it("ssh:box", "box", { kind: "ssh" })]));
    expect(rd.state).toBe("ready");
    expect(rd.needs.map((n) => n.id)).toEqual(["svc:vercel", "ssh:box"]);
    expect(rd.optional[0].state).toBe("missing");
  });
  test("almost when a need is only signed out or installed; missing when absent or off", () => {
    expect(readiness(r, inv([it("svc:netlify", "Netlify", { state: "signed-out", status: "partial" }), it("ssh:box", "box")])).state).toBe("almost");
    expect(readiness(r, inv([it("svc:netlify", "Netlify", { state: "installed" }), it("ssh:box", "box")])).state).toBe("almost");
    const miss = readiness(r, inv([it("svc:netlify", "Netlify", { status: "off", state: "off" })]));
    expect(miss.state).toBe("missing");
    expect(miss.missing).toBe(2);
    expect(readiness(r, undefined).state).toBe("missing");
  });
  test("a ready match beats a signed-out one", () => {
    const rd = readiness(r, inv([it("svc:netlify", "Netlify", { state: "signed-out" }), it("svc:vercel", "Vercel"), it("ssh:a", "a")]));
    expect(rd.needs[0]).toMatchObject({ state: "ready", id: "svc:vercel" });
  });
  test("ranking puts ready recipes first, then almost, then fewest missing", () => {
    const list: Recipe[] = [
      { ...r, id: "miss2", title: "A", needs: [{ label: "Y", any: ["svc:none1"] }, { label: "Z", any: ["svc:none2"] }] },
      { ...r, id: "ready", title: "B", needs: [{ label: "Git", any: ["dev:git"] }] },
      { ...r, id: "miss1", title: "C", needs: [{ label: "Git", any: ["dev:git"] }, { label: "X", any: ["svc:none"] }] },
      { ...r, id: "almost", title: "D", needs: [{ label: "N", any: ["svc:netlify"] }] },
    ];
    const ranked = rankRecipes(list, inv([it("dev:git", "Git", { kind: "cli" }), it("svc:netlify", "Netlify", { state: "signed-out" })]));
    expect(ranked.map((x) => x.id)).toEqual(["ready", "almost", "miss1", "miss2"]);
  });
  test("prompt gets the machine, the connections and the picks", () => {
    const p = fillPrompt(r, { connections: "# Connections on test\n- **Vercel**", machine: "test", selected: "- **Stripe**" });
    expect(p).toContain("Do it on test.");
    expect(p).toContain("**Vercel**");
    expect(p).toContain("Also use these connections I picked:\n- **Stripe**");
    expect(recipeIds(r, inv([it("svc:vercel", "Vercel"), it("ssh:box", "box"), it("svc:gmail", "Gmail")]))).toEqual(["svc:vercel", "ssh:box", "svc:gmail"]);
  });
  test("the built-in recipes are well formed", () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(RECIPES.map((x) => x.id)).size).toBe(RECIPES.length);
    for (const x of RECIPES) {
      expect(x.title && x.pitch && x.steps.length >= 3 && x.needs.length >= 1).toBeTruthy();
      expect(x.prompt).toContain("{connections}");
      for (const n of [...x.needs, ...(x.optional ?? [])]) for (const id of n.any) expect(id).toMatch(/^(svc|agent|sub|mcp|ssh|dev|bg|skill|key|device|acct|proj):/);
    }
  });
});

describe("select all", () => {
  const items = [
    it("svc:a", "Alpha", { cat: "ai" }), it("svc:b", "Beta", { cat: "ai", state: "signed-out" }), it("svc:c", "Gamma", { cat: "ai", status: "off", state: "off" }),
    it("svc:d", "Delta mail", { cat: "comms" }), it("svc:e", "Echo", { cat: "ai", hidden: true }),
  ];
  test("the view is one category, without hidden or not-set-up cards", () => {
    expect(B.connView(items, { cat: "ai" }).map((i: Item) => i.id)).toEqual(["svc:a", "svc:b"]);
    expect(B.connView(items, { cat: "ai", showHidden: true }).map((i: Item) => i.id)).toEqual(["svc:a", "svc:b", "svc:e"]);
    expect(B.connView(items, { cat: "off" }).map((i: Item) => i.id)).toEqual(["svc:c"]);
  });
  test("a search spans every category and matches category names too", () => {
    expect(B.connView(items, { q: "mail" }).map((i: Item) => i.id)).toEqual(["svc:d"]);
    expect(B.connView(items, { q: "comm", labels: { comms: "Communication" } }).map((i: Item) => i.id)).toEqual(["svc:d"]);
    expect(B.connView(items, { q: "a" }).map((i: Item) => i.id)).toEqual(["svc:a", "svc:b", "svc:c", "svc:d"]);
    expect(B.connView(items, { q: "echo" }).map((i: Item) => i.id)).toEqual(["svc:e"]); // a search finds hidden cards too
  });
  test("select all takes every selectable card in view, keeps earlier picks, skips not-set-up", () => {
    const view = B.connView(items, { q: "a" });
    const s = B.connSelectAll(new Set(["svc:zz"]), view);
    expect([...s].sort()).toEqual(["svc:a", "svc:b", "svc:d", "svc:zz"]);
    expect(B.connAllPicked(s, view)).toBe(true);
  });
  test("none unselects only the view, or everything", () => {
    const all = new Set(["svc:a", "svc:b", "svc:d"]);
    expect([...B.connSelectNone(all, B.connView(items, { cat: "ai" }))]).toEqual(["svc:d"]);
    expect(B.connSelectNone(all).size).toBe(0);
    expect(B.connAllPicked(new Set(["svc:a"]), B.connView(items, { cat: "ai" }))).toBe(false);
  });
  test("recipes for a selection rank by overlap", () => {
    const rs = [{ id: "x", ready: { needs: [{ id: "svc:a" }], optional: [] } }, { id: "y", ready: { needs: [{ id: "svc:a" }, { id: "svc:d" }], optional: [] } }, { id: "z", ready: { needs: [{ id: "svc:q" }], optional: [] } }];
    expect(B.recipesFor(rs, new Set(["svc:a", "svc:d"])).map((r: any) => r.id)).toEqual(["y", "x"]);
  });
  test("featured takes ready cards, at most two per category; recent takes new ones", () => {
    const many = ["a", "b", "c"].map((x) => it(`svc:${x}`, x, { cat: "ai" })).concat(it("svc:m", "m", { cat: "media" }), it("svc:o", "o", { cat: "media", state: "off", status: "off" }));
    expect(B.connFeatured(many, ["ai", "media"]).map((i: Item) => i.id)).toEqual(["svc:a", "svc:b", "svc:m"]);
    const now = Date.now();
    expect(B.connRecent([it("a", "a", { since: now - 1000 }), it("b", "b", { since: 0 }), it("c", "c", { since: now - 30 * 864e5 })], now).map((i: Item) => i.id)).toEqual(["a"]);
  });
});

describe("accounts and recommendations in the store", () => {
  const items = [
    it("svc:x-twitter", "X (Twitter)", { cat: "social" }), it("acct:instagram", "Instagram", { cat: "social", state: "account", status: "partial" }),
    it("sites:other", "Other sites", { kind: "sites", cat: "sites" }), it("svc:github", "GitHub", { cat: "code", logins: ["Chrome · Default profile"] }),
    it("rec:resend", "Resend", { kind: "rec", cat: "recommended", state: "off", status: "off" }), it("svc:aws", "AWS", { cat: "cloud", state: "off", status: "off" }),
  ];
  test("recommendations have their own category and never count as Not set up", () => {
    expect(B.connView(items, { cat: "recommended" }).map((i: Item) => i.id)).toEqual(["rec:resend"]);
    expect(B.connView(items, { cat: "off" }).map((i: Item) => i.id)).toEqual(["svc:aws"]);
    expect(B.connView(items, { cat: "social" }).map((i: Item) => i.id)).toEqual(["svc:x-twitter", "acct:instagram"]); // "Has account" shows in its category
    expect(B.connInCat(items[4], "recommended")).toBe(true);
    expect(B.connView(items, { q: "resend" }).map((i: Item) => i.id)).toEqual(["rec:resend"]);
  });
  test("recommendations can't be selected; an account-only card can", () => {
    expect([...B.connSelectAll(new Set(), items)].sort()).toEqual(["acct:instagram", "sites:other", "svc:github", "svc:x-twitter"]);
  });
  test("logins that merged into other categories are listed for Sites & accounts", () => {
    expect(B.connLoginsElsewhere(items).map((i: Item) => i.id)).toEqual(["svc:github"]);
  });
  test("the Add account picker puts Social media, then Sites & accounts, first", () => {
    const g = B.connCatalogGroups([{ id: "vercel", name: "Vercel", cat: "cloud" }, { id: "x", name: "X", cat: "social" }, { id: "amazon", name: "Amazon", cat: "sites" }, { id: "bsky", name: "Bluesky", cat: "social" }], { social: "Social media", sites: "Sites & accounts", cloud: "Cloud & deploy" });
    expect(g.map((x: any) => x.cat)).toEqual(["social", "sites", "cloud"]);
    expect(g[0].items.map((x: any) => x.name)).toEqual(["Bluesky", "X"]);
  });
});

describe("the scanner never records secret values", () => {
  test("planted secrets in a fake HOME stay out of the scan and CONNECTIONS.md", async () => {
    const home = mkdtempSync(`${tmpdir()}/deck-secrets-`);
    const SECRETS = ["sk-FAKE0SECRET0shellrc", "FAKEPROJECTSECRETVALUE", "ghp_FAKEGITHUBTOKEN123", "xoxb-FAKESLACK", "FAKEAGENTENVVALUE", "FAKENPMTOKEN999", "FAKEMCPHEADERTOKEN", "FAKECODEXENVSECRET", "FAKEFILECONTENTKEY", "FAKEPEMLINEZZZ", "FAKEPROCESSENVSECRET", "FAKEOPENCODEKEY"];
    const w = (p: string, s: string) => { mkdirSync(`${home}/${p.split("/").slice(0, -1).join("/")}`, { recursive: true }); writeFileSync(`${home}/${p}`, s); };
    try {
      w(".zshrc", `export OPENAI_API_KEY=${SECRETS[0]}\nexport STRIPE_SECRET_KEY="${SECRETS[3]}"\n`);
      w("Documents/Projects/shop/.env", `GUMROAD_ACCESS_TOKEN=${SECRETS[1]}\nPRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nABCDEF_KEY=${SECRETS[9]}\n-----END PRIVATE KEY-----"\nRESEND_API_KEY=${SECRETS[1]}x\n`);
      w(".hermes/.env", `OPENROUTER_API_KEY=${SECRETS[4]}\n`);
      w(".config/gh/hosts.yml", `github.com:\n  oauth_token: ${SECRETS[2]}\n  user: someone\n`);
      w(".npmrc", `//registry.npmjs.org/:_authToken=${SECRETS[5]}\n`);
      w(".claude.json", JSON.stringify({ mcpServers: { secretive: { type: "http", url: "https://x.example/mcp", headers: { Authorization: `Bearer ${SECRETS[6]}` }, env: { API_KEY: SECRETS[6] } } } }));
      w(".codex/config.toml", `[mcp_servers.thing]\ncommand = "npx"\n\n[mcp_servers.thing.env]\nTOKEN = "${SECRETS[7]}"\n`);
      w(".config/higgsfield/credentials.json", JSON.stringify({ key: SECRETS[8] }));
      w(".config/opencode/opencode.jsonc", `{\n // comment\n "mcp": { "oc": { "type": "remote", "url": "https://x", "headers": { "k": "${SECRETS[11]}" } } },\n}`);
      w(".ssh/config", "Host box\n  IdentityFile ~/.ssh/id_x\n");
      const p = Bun.spawn([process.execPath, new URL("../connections.ts", import.meta.url).pathname, "--scan"], { env: { ...process.env, HOME: home, DECK_TEST_SECRET: SECRETS[10] }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const invj = JSON.parse(out) as Inventory;
      const md = readFileSync(`${home}/.config/herdr-deck/CONNECTIONS.md`, "utf8");
      for (const s of SECRETS) { expect(out).not.toContain(s); expect(md).not.toContain(s); }
      // …while the names are found.
      const names = invj.sections.flatMap((s) => s.items.map((i) => `${i.id} ${i.name} ${(i.via ?? []).join(" ")}`)).join("\n");
      expect(names).toContain("OPENAI_API_KEY");
      expect(names).toContain("GUMROAD_ACCESS_TOKEN");
      expect(names).toContain("OPENROUTER_API_KEY");
      expect(names).toContain("mcp:secretive");
      expect(names).toContain("mcp:thing");
      expect(names).toContain("mcp:oc");
      expect(names).toContain("ssh:box");
      expect(names).not.toContain("ABCDEF_KEY"); // a line inside a multi-line quoted value is skipped
      expect(invj.sections.find((s) => s.id === "services")!.items.find((i) => i.name === "Resend")?.note).toBe("API key in project .env");
      expect(existsSync(`${home}/.config/herdr-deck/connections-seen.json`)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});
