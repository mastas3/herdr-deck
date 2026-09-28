import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The folder window's listing helpers live in the browser script (no build step); evaluate just their marked block.
const src = readFileSync(new URL("../public/js/folder-items.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:folder-begin"), src.indexOf("/* @pure:folder-end */"));
const F = new Function(`${block}; return { fvKind, fvSize, fvWhen, fvShown, fvCrumbs, fvClamp };`)();

const f = (name: string, o: any = {}) => ({ name, kind: "file", hidden: name.startsWith("."), ...o });
const NOW = 1_800_000_000_000, MIN = 60_000, DAY = 24 * 60 * MIN;

describe("folder window listing", () => {
  test("kinds by extension, by well-known name, and for dotfiles", () => {
    const k = (n: string, o?: any) => F.fvKind(f(n, o));
    expect([k("src", { kind: "dir" }), k("link", { kind: "link", to: "dir" }), k("link2", { kind: "link", to: "file" })]).toEqual(["dir", "dir", "file"]);
    expect([k("server.ts"), k("App.TSX"), k("main.go"), k("styles.css")]).toEqual(["code", "code", "code", "code"]);
    expect([k("README.md"), k("notes.mdx"), k("README")]).toEqual(["md", "md", "md"]);
    expect([k("package.json"), k("data.jsonl")]).toEqual(["json", "json"]);
    expect([k("bun.lock"), k("package-lock.json"), k("yarn.lock"), k("Cargo.lock"), k("go.sum")]).toEqual(["lock", "lock", "lock", "lock", "lock"]);
    expect([k("tsconfig.yaml"), k(".gitignore"), k(".env.local"), k("Dockerfile"), k(".DS_Store")]).toEqual(["config", "config", "config", "config", "config"]);
    expect([k("logo.PNG"), k("icon.svg"), k("clip.mp4"), k("x.tar.gz"), k("a.pdf"), k("f.woff2"), k("blob")]).toEqual(["image", "image", "media", "archive", "doc", "font", "file"]);
  });
  test("human-readable sizes", () => {
    expect([F.fvSize(0), F.fvSize(812), F.fvSize(1024), F.fvSize(4300), F.fvSize(18 * 1024), F.fvSize(3.14 * 1024 ** 2), F.fvSize(5 * 1024 ** 4)]).toEqual(["0 B", "812 B", "1 KB", "4.2 KB", "18 KB", "3.1 MB", "5 TB"]);
    expect(F.fvSize(undefined)).toBe("");
  });
  test("relative change times for a week, then the date", () => {
    expect([F.fvWhen(NOW - 10_000, NOW), F.fvWhen(NOW - 5 * MIN, NOW), F.fvWhen(NOW - 3 * 60 * MIN, NOW), F.fvWhen(NOW - 2 * DAY, NOW)]).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
    expect(F.fvWhen(NOW - 30 * DAY, NOW)).not.toContain("ago");
    expect(F.fvWhen(0, NOW)).toBe("");
  });
  test("the filter and the hidden switch", () => {
    const es = [f(".cache", { kind: "dir" }), f("src", { kind: "dir" }), f(".env"), f("Server.ts"), f("serve.md")];
    expect(F.fvShown(es, "", true).map((e: any) => e.name)).toEqual([".cache", "src", ".env", "Server.ts", "serve.md"]);
    expect(F.fvShown(es, "", false).map((e: any) => e.name)).toEqual(["src", "Server.ts", "serve.md"]);
    expect(F.fvShown(es, " SERV ", true).map((e: any) => e.name)).toEqual(["Server.ts", "serve.md"]);
  });
  test("breadcrumbs open each level", () => {
    expect(F.fvCrumbs("app", "")).toEqual([{ label: "app", path: "" }]);
    expect(F.fvCrumbs("app", "src/lib/")).toEqual([{ label: "app", path: "" }, { label: "src", path: "src" }, { label: "lib", path: "src/lib" }]);
  });
  test("the window stays on screen and keeps a usable size", () => {
    expect(F.fvClamp({ left: 100, top: 80, width: 600, height: 500 }, 1400, 900)).toEqual({ left: 100, top: 80, width: 600, height: 500 });
    expect(F.fvClamp({ left: 1200, top: -40, width: 600, height: 500 }, 1400, 900)).toEqual({ left: 792, top: 8, width: 600, height: 500 });
    expect(F.fvClamp({ left: 10, top: 10, width: 100, height: 50 }, 1400, 900)).toMatchObject({ width: 320, height: 240 });
    expect(F.fvClamp({ left: 0, top: 0, width: 3000, height: 3000 }, 1400, 900)).toEqual({ left: 8, top: 8, width: 1384, height: 884 });
  });
});
