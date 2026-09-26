import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { interestsFrom, mergeAccounts, owned, recommend, upsertAccount, type Account } from "../src/accounts";
import { RECS, SITES_CATALOG, hostOf, registrable, sensitive, siteFor } from "../src/catalog";
import type { Inventory, Item } from "../src/connections";
import { inventoryText } from "../src/connections";
import { type LoginProfile, browserRoots, profileLabel, readLoginFile, readLogins } from "../src/logins";
import { RECIPES, readiness } from "../src/recipes";
import { CATEGORIES, enrich, stateOf } from "../src/store";

// Values that must never come out of the reader, the scan or CONNECTIONS.md.
const USERS = ["FAKEUSER_alice@example.org", "FAKEUSER_bob", "FAKEUSER_bank_login", "FAKEUSER_health"];
const PASSWORDS = ["FAKEPASS_hunter2_ZZ", "FAKEPASS_s3cr3t_QQ", "FAKEPASS_bankpin_77", "FAKEPASS_clinic_88"];
// Chrome's real `logins` table (the columns that matter, plus the secret ones filled with fakes).
const SCHEMA = `CREATE TABLE logins (origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR, username_value VARCHAR, password_element VARCHAR, password_value BLOB,
  submit_element VARCHAR, signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL DEFAULT 0, blacklisted_by_user INTEGER NOT NULL DEFAULT 0, scheme INTEGER NOT NULL DEFAULT 0,
  password_type INTEGER, times_used INTEGER, form_data BLOB, display_name VARCHAR, icon_url VARCHAR, federation_url VARCHAR, skip_zero_click INTEGER, generation_upload_status INTEGER,
  possible_username_pairs BLOB, id INTEGER PRIMARY KEY AUTOINCREMENT, date_last_used INTEGER NOT NULL DEFAULT 0, moving_blocked_for BLOB, date_password_modified INTEGER NOT NULL DEFAULT 0)`;
type Row = [origin: string, realm: string, blocked?: number];
function makeLoginDb(path: string, rows: Row[]) {
  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const ins = db.prepare("INSERT INTO logins (origin_url, action_url, username_element, username_value, password_element, password_value, signon_realm, blacklisted_by_user) VALUES (?, ?, 'email', ?, 'pass', ?, ?, ?)");
  rows.forEach(([o, r, b], n) => ins.run(o, `${o}login?next=${USERS[n % USERS.length]}`, USERS[n % USERS.length], Buffer.from(PASSWORDS[n % PASSWORDS.length]), r, b ?? 0));
  db.close();
}
const ROWS: Row[] = [
  ["https://x.com/", "https://x.com/"],
  ["https://www.instagram.com/accounts/login/", "https://www.instagram.com/"],
  ["", "android://Zm9vYmFy@com.instagram.android/"], // an Android app login
  ["https://github.com/session", "https://github.com/"],
  ["https://news.ycombinator.com/login", "https://news.ycombinator.com/"],
  ["https://app.netlify.com/", "https://app.netlify.com/"],
  ["https://obscure-forum.example-site.net/", "https://obscure-forum.example-site.net/"],
  ["https://me.netlify.app/", "https://me.netlify.app/"],
  // never shown: finance, health, government, dating, local
  ["https://secure.chase.com/", "https://secure.chase.com/"],
  ["https://login.bankhapoalim.co.il/", "https://login.bankhapoalim.co.il/"],
  ["https://e-services.clalit.co.il/", "https://e-services.clalit.co.il/"],
  ["https://www.gov.il/", "https://www.gov.il/"],
  ["https://sa.www4.irs.gov/", "https://sa.www4.irs.gov/"],
  ["https://www.mymedicalportal.com/", "https://www.mymedicalportal.com/"],
  ["https://tinder.com/", "https://tinder.com/"],
  ["http://localhost:3000/", "http://localhost:3000/"],
  ["http://192.168.1.10/", "http://192.168.1.10/"],
  // "never save for this site" isn't an account
  ["https://www.tiktok.com/", "https://www.tiktok.com/", 1],
];

let home = "", tmp = "", oldTmp: string | undefined;
const MAC = process.platform === "darwin";
const chromeRoot = () => (MAC ? `${home}/Library/Application Support/Google/Chrome` : `${home}/.config/google-chrome`);
const braveRoot = () => (MAC ? `${home}/Library/Application Support/BraveSoftware/Brave-Browser` : `${home}/.config/BraveSoftware/Brave-Browser`);
beforeAll(() => {
  home = mkdtempSync(`${tmpdir()}/deck-accounts-`);
  tmp = mkdtempSync(`${tmpdir()}/deck-accounts-tmp-`);
  oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp; // the reader's temp copies land here, so the test can see they're gone
  makeLoginDb(`${chromeRoot()}/Default/Login Data`, ROWS);
  makeLoginDb(`${chromeRoot()}/Profile 2/Login Data For Account`, [["https://www.reddit.com/login", "https://www.reddit.com/"]]);
  writeFileSync(`${chromeRoot()}/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" }, "Profile 2": { name: "Work" } } } }));
  makeLoginDb(`${braveRoot()}/Default/Login Data`, [["https://www.tiktok.com/login", "https://www.tiktok.com/"], ["https://bsky.app/", "https://bsky.app/"]]);
});
afterAll(() => {
  if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("site names from saved logins", () => {
  test("one file: only hosts come out; secrets, sensitive, local and never-saved sites don't", () => {
    const file = `${chromeRoot()}/Default/Login Data`;
    const before = statSync(file).mtimeMs, bytes = readFileSync(file);
    const hosts = readLoginFile(file);
    expect(hosts).toEqual(["github.com", "instagram.com", "me.netlify.app", "news.ycombinator.com", "obscure-forum.example-site.net", "x.com", "app.netlify.com"].sort());
    const out = JSON.stringify(hosts);
    for (const v of [...USERS, ...PASSWORDS]) expect(out).not.toContain(v);
    for (const d of ["chase", "hapoalim", "clalit", "gov", "medical", "tinder", "localhost", "192.168", "tiktok"]) expect(out).not.toContain(d);
    // The browser's own file is untouched, and the private copy is deleted.
    expect(statSync(file).mtimeMs).toBe(before);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readdirSync(tmp).filter((f) => f.startsWith("deck-logins-"))).toEqual([]);
  });
  test("every profile of every Chromium browser, with readable labels; nothing left behind", () => {
    const res = readLogins(home, MAC);
    expect(res.files).toBe(3);
    expect(res.profiles.map((p) => p.label).sort()).toEqual(["Brave · Default profile", "Chrome · Default profile", "Chrome · Work"]);
    expect(res.profiles.find((p) => p.label === "Chrome · Work")!.hosts).toEqual(["reddit.com"]);
    const out = JSON.stringify(res);
    for (const v of [...USERS, ...PASSWORDS]) expect(out).not.toContain(v);
    expect(readdirSync(tmp).filter((f) => f.startsWith("deck-logins-"))).toEqual([]);
  });
  test("the Linux layout is read too, and a machine without browsers is fine", () => {
    const lin = mkdtempSync(`${tmpdir()}/deck-accounts-linux-`);
    try {
      makeLoginDb(`${lin}/.config/BraveSoftware/Brave-Browser/Default/Login Data`, [["https://x.com/", "https://x.com/"]]);
      makeLoginDb(`${lin}/.config/chromium/Profile 1/Login Data`, [["https://github.com/", "https://github.com/"]]);
      expect(browserRoots(lin, false).map(([b]) => b)).toEqual(["Chromium", "Brave"]);
      const res = readLogins(lin, false);
      expect(res.profiles.flatMap((p) => p.hosts).sort()).toEqual(["github.com", "x.com"]);
      expect(readLogins(`${lin}/nothing-here`, false)).toMatchObject({ profiles: [], files: 0 });
    } finally { rmSync(lin, { recursive: true, force: true }); }
  });
  test("a corrupt or locked file contributes nothing and doesn't throw", () => {
    const bad = `${home}/bad/Login Data`;
    mkdirSync(`${home}/bad`, { recursive: true });
    writeFileSync(bad, "not a database");
    expect(readLoginFile(bad)).toEqual([]);
    expect(readdirSync(tmp).filter((f) => f.startsWith("deck-logins-"))).toEqual([]);
  });
  test("profile labels", () => {
    expect(profileLabel("Chrome", "Default", "Person 1")).toBe("Chrome · Default profile");
    expect(profileLabel("Chrome", "Default", "Stas")).toBe("Chrome · Default profile (Stas)");
    expect(profileLabel("Brave", "Profile 3", "Work")).toBe("Brave · Work");
  });
});

describe("hosts, domains and the catalog", () => {
  test("hosts from origins and realms", () => {
    expect(hostOf("https://www.Instagram.com/accounts/", "")).toBe("instagram.com");
    expect(hostOf("", "https://news.ycombinator.com/")).toBe("news.ycombinator.com");
    expect(hostOf("", "android://abc@com.twitter.android/")).toBe("x.com");
    expect(hostOf("", "android://abc@com.unknown.app/")).toBeUndefined();
    for (const u of ["http://localhost:8080/", "http://10.0.0.2/", "https://mac.tail1234.ts.net/", "chrome-extension://abc/", "https://[::1]/", "https://printer.local/"]) expect(hostOf(u, "")).toBeUndefined();
  });
  test("registrable domains", () => {
    expect(registrable("news.ycombinator.com")).toBe("ycombinator.com");
    expect(registrable("shop.example.co.il")).toBe("example.co.il");
    expect(registrable("a.b.example.com.au")).toBe("example.com.au");
    expect(registrable("me.netlify.app")).toBe("me.netlify.app");
    expect(registrable("deep.me.github.io")).toBe("me.github.io");
    expect(registrable("t.me")).toBe("t.me");
  });
  test("banks, finance, health, government, dating and adult are sensitive; ordinary sites aren't", () => {
    for (const h of ["secure.chase.com", "login.bankhapoalim.co.il", "www.leumi.co.il", "online.isracard.co.il", "paypal.com", "www.coinbase.com", "e-services.clalit.co.il", "maccabi4u.co.il", "www.gov.il", "btl.gov.il", "sa.www4.irs.gov", "www.gov.uk", "www.nhs.uk", "portal.go.jp", "army.mil", "tinder.com", "www.mymedicalportal.com", "myhealthapp.io", "etoro.com"]) expect([h, sensitive(h)]).toEqual([h, true]);
    for (const h of ["github.com", "syntax.fm", "medium.com", "x.com", "instagram.com", "news.ycombinator.com", "shutterstock.com", "government-jobs-blog.example", "gumroad.com"]) expect([h, sensitive(h)]).toEqual([h, false]);
  });
  test("catalog matching: the longest domain wins", () => {
    expect(siteFor("signin.aws.amazon.com")?.id).toBe("aws");
    expect(siteFor("www.amazon.com")?.id ?? siteFor("amazon.com")?.id).toBe("amazon");
    expect(siteFor("drive.google.com")?.id).toBe("gdrive");
    expect(siteFor("accounts.google.com")?.id).toBe("google");
    expect(siteFor("news.ycombinator.com")?.id).toBe("hacker-news");
    expect(siteFor("ycombinator.com")).toBeUndefined();
    expect(siteFor("studio.youtube.com")?.id).toBe("youtube");
  });
  test("the catalog is well formed", () => {
    const ids = SITES_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set<string>(CATEGORIES.map((c) => c.id));
    for (const s of SITES_CATALOG) {
      expect(cats.has(s.cat)).toBe(true);
      expect(s.domains.length).toBeGreaterThan(0);
      if (s.cat === "social" || s.cat === "sites") expect(s.what && s.agents && s.connect.length > 0).toBeTruthy();
      for (const d of s.domains) expect(sensitive(d)).toBe(false); // nothing in the catalog is a sensitive site
    }
    const social = SITES_CATALOG.filter((s) => s.cat === "social").map((s) => s.name);
    for (const n of ["X (Twitter)", "Instagram", "TikTok", "YouTube", "Facebook", "LinkedIn", "Reddit", "Threads", "Bluesky", "Mastodon", "Telegram", "WhatsApp", "Discord", "Pinterest", "Medium", "Substack", "Product Hunt", "Hacker News", "DEV"]) expect(social).toContain(n);
  });
});

const svcItem = (id: string, name: string, over: Partial<Item> = {}): Item => ({ id, name, kind: "service", status: "ready", state: "ready", ...over });
const P = (browser: string, label: string, hosts: string[]): LoginProfile => ({ browser, profile: "Default", label, hosts });

describe("one card per account, merging every piece of evidence", () => {
  const svc: Item[] = [
    svcItem("svc:telegram", "Telegram", { cat: "comms", note: "API key set", via: ["key TELEGRAM_BOT_TOKEN"], use: "Bot API with the TELEGRAM token in the environment." }),
    svcItem("svc:github", "GitHub", { cat: "code", note: "signed in", via: ["gh 2.60"] }),
    svcItem("svc:vercel", "Vercel", { cat: "cloud", status: "off", state: "off", note: "not set up" }),
    svcItem("svc:gumroad", "Gumroad", { cat: "commerce" }),
  ];
  const logins = [
    P("Chrome", "Chrome · Default profile", ["x.com", "github.com", "vercel.com", "web.telegram.org", "news.ycombinator.com", "unknown-one.com", "a.unknown-two.co.il", "secure.chase.com"]),
    P("Brave", "Brave · Work", ["instagram.com", "unknown-one.com"]),
  ];
  const accounts: Account[] = [{ id: "bluesky", handle: "stas.bsky.social", notes: "Post drafts only" }, { id: "x", handle: "stas" }];
  const evidence = (s: any) => (s.id === "telegram" ? { via: ["Telegram app"], strong: false, app: true } : { via: [], strong: false, app: false });
  const m = mergeAccounts({ svc, logins, accounts, evidence });
  const card = (id: string) => [...m.accounts, ...m.svc].find((i) => i.id === id)!;

  test("X: login in Chrome + your handle → one ready social card with the scanner's id", () => {
    const x = card("svc:x-twitter");
    expect(m.accounts.filter((i) => i.id === "svc:x-twitter").length).toBe(1);
    expect(x).toMatchObject({ cat: "social", state: "ready", handle: "stas", url: "https://x.com/stas" });
    expect(x.note).toContain("signed in (saved login in Chrome · Default profile)");
    expect(x.note).toContain("@stas");
    expect(x.connect!.some((c) => c.startsWith("Claude in Chrome:"))).toBe(true);
  });
  test("Telegram: the key, the app and the login merge into one card that moves to Social media", () => {
    const t = card("svc:telegram");
    expect(t.cat).toBe("social");
    expect(t.via).toEqual(expect.arrayContaining(["key TELEGRAM_BOT_TOKEN", "Telegram app", "saved login (Chrome · Default profile)"]));
    expect(t.state).toBe("ready");
    expect(t.use).toContain("TELEGRAM token");
    expect(m.svc.some((i) => i.id === "svc:telegram")).toBe(false); // moved, not duplicated
  });
  test("a login only in Brave: you have the account, but Claude in Chrome can't use it yet", () => {
    const ig = card("acct:instagram");
    expect(ig.state).toBe("account");
    expect(stateOf(ig)).toBe("account");
    expect(ig.use).toContain("sign in there first");
  });
  test("service cards keep their category; a login alone doesn't set up a CLI", () => {
    expect(card("svc:github")).toMatchObject({ cat: "code", state: "ready" });
    expect(card("svc:github").via).toContain("saved login (Chrome · Default profile)");
    expect(card("svc:vercel")).toMatchObject({ cat: "cloud", state: "account", status: "partial" });
    expect(card("svc:vercel").use).toContain("isn't set up for agents");
    expect(card("svc:gumroad").logins).toBeUndefined();
  });
  test("an account you added with no other evidence, with a derived profile link and your notes", () => {
    const b = card("acct:bluesky");
    expect(b).toMatchObject({ state: "account", handle: "stas.bsky.social", url: "https://bsky.app/profile/stas.bsky.social", use: "Post drafts only" });
    expect(b.note).toContain("added by you");
  });
  test("unknown sites become one Other sites card; sensitive ones appear nowhere", () => {
    expect(m.other).toMatchObject({ id: "sites:other", cat: "sites", sites: ["unknown-one.com", "unknown-two.co.il"] });
    expect(JSON.stringify(m)).not.toContain("chase");
  });
  test("nothing you don't have gets a card", () => {
    expect(card("acct:tiktok")).toBeUndefined();
    expect(card("acct:reddit")).toBeUndefined();
  });
});

describe("adding an account by hand", () => {
  test("validates and replaces", () => {
    let l = upsertAccount([], { id: "x", handle: " @stas ", notes: "drafts only" }, 1);
    expect(l).toEqual([{ id: "x", handle: "@stas", notes: "drafts only", at: 1 }]);
    l = upsertAccount(l, { id: "x", url: "https://x.com/stas" }, 2);
    expect(l).toEqual([{ id: "x", url: "https://x.com/stas", at: 2 }]);
    expect(() => upsertAccount([], { id: "not-a-service" })).toThrow("Pick a service");
    expect(() => upsertAccount([], { id: "x", handle: "two words" })).toThrow("no spaces");
    expect(() => upsertAccount([], { id: "x", url: "javascript:alert(1)" })).toThrow("https://");
    expect(upsertAccount([], { id: "x", notes: "a\nb\u0000c".repeat(400) })[0].notes!.length).toBeLessThanOrEqual(1000);
  });
});

describe("recommended for you", () => {
  const wiki = "Human Design bodygraph HD Chat astra. 2027 prophecy funnel gumroad 2027 2027. hyperframes story-reel shorts video. phaser game godot falafel.";
  const items: Item[] = [svcItem("svc:resend", "Resend"), svcItem("svc:fal", "fal", { state: "off", status: "off" }), svcItem("acct:posthog", "PostHog", { state: "account", status: "partial" })];
  const logins = [P("Chrome", "Chrome · Default profile", ["app.beehiiv.com"])];
  const accts: Account[] = [{ id: "tiktok", handle: "me" }];
  const recs = recommend(items, logins, accts, wiki);
  const ids = recs.map((r) => r.id);
  test("services you already have are left out: set up, signed up (login), or added by you", () => {
    expect(ids).not.toContain("rec:resend"); // ready card
    expect(ids).not.toContain("rec:posthog"); // has an account
    expect(ids).not.toContain("rec:beehiiv"); // saved login on a subdomain
    expect(ids).not.toContain("rec:buttondown"); // beehiiv covers newsletters
    expect(ids).not.toContain("rec:tiktok"); // you added it
    expect(ids).toContain("rec:fal"); // its card is off: not set up
    expect(owned(RECS.find((r) => r.id === "fal")!, items, logins, accts)).toBe(false);
  });
  test("ranked by fit, with a reason that names the project, a free-tier note, an official link and the recipes it unlocks", () => {
    const top = recs.slice(0, 8);
    expect(top.every((r) => r.rec!.project)).toBe(true);
    for (const r of recs) {
      expect(r).toMatchObject({ kind: "rec", cat: "recommended", state: "off" });
      expect(r.rec!.url).toMatch(/^https:\/\//);
      expect(r.rec!.free.length).toBeGreaterThan(2);
    }
    for (let k = 1; k < recs.length; k++) expect(recs[k - 1].rec!.score).toBeGreaterThanOrEqual(recs[k].rec!.score);
    const fal = recs.find((r) => r.id === "rec:fal")!;
    expect(fal.rec!.why).toMatch(/^(AI video|Browser games)/);
    const stripe = recs.find((r) => r.id === "rec:stripe")!;
    expect(stripe.rec!.unlocks.map((u) => u.title)).toContain("Morning revenue brief");
  });
  test("with no wiki, it still recommends, with the generic reasons", () => {
    const bare = recommend([], [], [], "");
    expect(bare.length).toBe(RECS.length);
    expect(bare.every((r) => !r.rec!.project && r.rec!.why.length > 10)).toBe(true);
    expect(interestsFrom("").size).toBe(0);
  });
});

describe("recipes that use accounts", () => {
  const inv = (items: Item[]): Inventory => ({ machine: "t", at: 0, ms: 0, sections: [{ id: "accounts", title: "", hint: "", items }] });
  const r = (id: string) => RECIPES.find((x) => x.id === id)!;
  test("new social recipes exist and reflect readiness", () => {
    for (const id of ["cross-post-short", "prophecy-mentions", "weekly-x-thread", "profile-consistency", "launch-kit", "newsletter-from-wiki"]) expect(r(id)).toBeTruthy();
    const chrome = svcItem("svc:chrome", "Chrome");
    expect(readiness(r("cross-post-short"), inv([chrome, svcItem("acct:tiktok", "TikTok")])).state).toBe("ready");
    expect(readiness(r("cross-post-short"), inv([chrome, svcItem("acct:tiktok", "TikTok", { state: "account", status: "partial" })])).state).toBe("almost");
    expect(readiness(r("cross-post-short"), inv([svcItem("acct:tiktok", "TikTok")])).state).toBe("missing");
    expect(readiness(r("weekly-x-thread"), inv([svcItem("svc:llm-wiki", "LLM Wiki"), svcItem("svc:x-twitter", "X")])).state).toBe("ready");
    expect(readiness(r("prophecy-mentions"), inv([svcItem("skill:last30days", "last30days", { kind: "skill" })])).state).toBe("ready");
  });
});

describe("CONNECTIONS.md: an Accounts section, never secrets or other-site names", () => {
  test("handles and usage are listed; other sites are only counted; recommendations stay out", () => {
    const m = mergeAccounts({ svc: [], logins: [P("Chrome", "Chrome · Default profile", ["x.com", "zzz-private-site.org"])], accounts: [{ id: "x", handle: "stas", notes: "Drafts only" }] });
    const inv: Inventory = { machine: "t", at: 0, ms: 0, sections: [
      { id: "accounts", title: "Accounts", hint: "", items: [...m.accounts, m.other!] },
      { id: "recommended", title: "Recommended", hint: "", items: recommend([], [], [], "") },
    ] };
    const md = inventoryText(inv);
    expect(md).toContain("## Accounts");
    expect(md).toContain("**X (Twitter)** @stas (https://x.com/stas)");
    expect(md).toContain("How agents may use it: Drafts only");
    expect(md).toContain("Signed in: saved login in Chrome · Default profile");
    expect(md).toContain("**Other sites**: 1 more site");
    expect(md).not.toContain("zzz-private-site");
    expect(md).not.toContain("Recommended");
  });
  test("the store knows the new categories and the Add account catalog", () => {
    const e = enrich({ machine: "m", at: 0, ms: 0, sections: [] });
    expect(e.categories.map((c) => c.id)).toEqual(expect.arrayContaining(["social", "sites", "recommended"]));
    expect(e.accountCatalog.find((c) => c.id === "instagram")).toMatchObject({ name: "Instagram", cat: "social" });
  });
});

describe("the whole scan in a fake HOME", () => {
  test("accounts, other sites and recommendations come out; usernames, passwords and sensitive sites never do", async () => {
    mkdirSync(`${home}/.config/herdr-deck`, { recursive: true });
    writeFileSync(`${home}/.config/herdr-deck/connections.json`, JSON.stringify({ accounts: [{ id: "youtube", handle: "stasmaksin", notes: "Upload as private only" }] }));
    mkdirSync(`${home}/wiki`, { recursive: true });
    writeFileSync(`${home}/wiki/index.md`, "- [[astra-apple]] Human Design 2027 prophecy funnel gumroad; story-reel HyperFrames shorts video; falafel-rush phaser game");
    const p = Bun.spawn([process.execPath, new URL("../src/connections.ts", import.meta.url).pathname, "--scan"], { env: { ...process.env, HOME: home, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const inv = JSON.parse(out) as Inventory;
    const md = readFileSync(`${home}/.config/herdr-deck/CONNECTIONS.md`, "utf8");
    for (const v of [...USERS, ...PASSWORDS, "chase", "hapoalim", "clalit", "irs.gov", "tinder", "mymedical"]) { expect(out).not.toContain(v); expect(md).not.toContain(v); }
    const acc = inv.sections.find((s) => s.id === "accounts")!.items;
    const names = acc.map((i) => i.name);
    for (const n of ["X (Twitter)", "Instagram", "Hacker News", "Reddit", "TikTok", "Bluesky", "YouTube"]) expect(names).toContain(n);
    expect(acc.find((i) => i.name === "TikTok")!.state).toBe("account"); // Brave only; the Chrome one was "never save"
    expect(acc.find((i) => i.name === "YouTube")).toMatchObject({ handle: "stasmaksin", use: "Upload as private only" });
    expect(acc.find((i) => i.id === "sites:other")!.sites).toEqual(["example-site.net", "me.netlify.app"]);
    expect(md).toContain("## Accounts");
    expect(md).toContain("@stasmaksin");
    expect(md).not.toContain("example-site.net");
    const recs = inv.sections.find((s) => s.id === "recommended")!.items;
    expect(recs.length).toBeGreaterThan(10);
    expect(recs.map((r) => r.id)).not.toContain("rec:youtube"); // you have it
    expect(recs[0].rec!.project).toBeTruthy();
    expect(readdirSync(tmp).filter((f) => f.startsWith("deck-logins-"))).toEqual([]);
  }, 60_000);
  test("DECK_NO_LOGINS turns the login read off", async () => {
    const p = Bun.spawn([process.execPath, new URL("../src/connections.ts", import.meta.url).pathname, "--scan"], { env: { ...process.env, HOME: home, TMPDIR: tmp, DECK_NO_LOGINS: "1", DECK_SCAN_DRY: "1" }, stdout: "pipe", stderr: "pipe" });
    const inv = JSON.parse(await new Response(p.stdout).text()) as Inventory;
    await p.exited;
    const acc = inv.sections.find((s) => s.id === "accounts")!.items;
    expect(acc.map((i) => i.name)).toContain("YouTube"); // the one you added (desktop apps on this machine may add more)
    expect(acc.some((i) => i.logins?.length || i.id === "sites:other")).toBe(false);
  }, 60_000);
});

describe("New badges after an upgrade", () => {
  test("the first scan of this version is a baseline; later additions are new", async () => {
    const h = mkdtempSync(`${tmpdir()}/deck-seen-`);
    try {
      mkdirSync(`${h}/.config/herdr-deck`, { recursive: true });
      writeFileSync(`${h}/.config/herdr-deck/connections-seen.json`, JSON.stringify({ ids: { "svc:old": 0 } })); // an older deck's file
      writeFileSync(`${h}/.config/herdr-deck/connections.json`, JSON.stringify({ accounts: [{ id: "instagram", handle: "a" }] }));
      const scan = async () => { const p = Bun.spawn([process.execPath, new URL("../src/connections.ts", import.meta.url).pathname, "--scan"], { env: { ...process.env, HOME: h, DECK_NO_LOGINS: "1" }, stdout: "pipe", stderr: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return JSON.parse(o) as Inventory; };
      const card = (inv: Inventory, id: string) => inv.sections.flatMap((s) => s.items).find((i) => i.id === id);
      const a = await scan();
      expect(card(a, "acct:instagram")?.since).toBeUndefined();
      expect(JSON.parse(readFileSync(`${h}/.config/herdr-deck/connections-seen.json`, "utf8")).v).toBe(2);
      writeFileSync(`${h}/.config/herdr-deck/connections.json`, JSON.stringify({ accounts: [{ id: "instagram", handle: "a" }, { id: "bluesky", handle: "b" }] }));
      const b = await scan();
      expect(card(b, "acct:instagram")?.since).toBeUndefined();
      expect(card(b, "acct:bluesky")?.since).toBeGreaterThan(0);
    } finally { rmSync(h, { recursive: true, force: true }); }
  }, 90_000);
});
