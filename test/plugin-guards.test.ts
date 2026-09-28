// The line between the core and its plugins, kept by tests: the core never imports plugin code, a built-in plugin
// never reaches into another plugin's files (it asks for a service), and every plugin's tests run with `bun test`.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCodeManifest } from "../src/plugin-code-format";

const ROOT = new URL("..", import.meta.url).pathname;
const BUILTIN = join(ROOT, "plugins-builtin");
const files = (dir: string, re: RegExp): string[] =>
  readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p, re) : re.test(f) ? [p] : []; });
const imports = (src: string) => [...src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((m) => m[1]);
const plugins = readdirSync(BUILTIN).filter((d) => existsSync(join(BUILTIN, d, "plugin.json")));

describe("core and plugins", () => {
  test("no core file (src/, src/http/, …) imports anything from plugins-builtin/", () => {
    const bad = files(join(ROOT, "src"), /\.(ts|js)$/).flatMap((f) => imports(readFileSync(f, "utf8")).filter((i) => i.includes("plugins-builtin")).map((i) => `${f.slice(ROOT.length)} → ${i}`));
    expect(bad).toEqual([]);
  });
  test("no page file of the core names a plugin's folder", () => {
    const bad = files(join(ROOT, "public"), /\.(js|html|json)$/).filter((f) => readFileSync(f, "utf8").includes("plugins-builtin"));
    expect(bad).toEqual([]);
  });
  test("a built-in plugin imports the core or its own files, never another plugin's", () => {
    const bad: string[] = [];
    for (const id of plugins) for (const f of files(join(BUILTIN, id), /\.(ts|js)$/)) {
      for (const i of imports(readFileSync(f, "utf8"))) {
        if (!i.startsWith(".")) continue;
        const target = join(f, "..", i);
        if (target.startsWith(BUILTIN) && !target.startsWith(join(BUILTIN, id) + "/")) bad.push(`${f.slice(ROOT.length)} → ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });
  test("every built-in manifest is valid, named after its folder, and its files exist", () => {
    expect(plugins).toContain("covers");
    for (const id of plugins) {
      const r = parseCodeManifest(JSON.parse(readFileSync(join(BUILTIN, id, "plugin.json"), "utf8")));
      expect(r.ok ? r.manifest.id : r.problems).toBe(id);
      if (!r.ok) continue;
      for (const f of [r.manifest.server, ...r.manifest.client, ...r.manifest.styles].filter(Boolean) as string[]) expect(existsSync(join(BUILTIN, id, f)) ? f : `missing ${id}/${f}`).toBe(f);
    }
  });
  test("plugin tests run with plain `bun test`: no path filter, no test root that leaves plugins-builtin out", () => {
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test).toBe("bun test");
    const bunfig = existsSync(join(ROOT, "bunfig.toml")) ? readFileSync(join(ROOT, "bunfig.toml"), "utf8") : "";
    expect(bunfig).not.toMatch(/^\s*root\s*=/m);
    // Bun finds *.test.ts anywhere in the repo; each plugin keeps its tests in its own test/ folder.
    const tests = plugins.flatMap((id) => (existsSync(join(BUILTIN, id, "test")) ? readdirSync(join(BUILTIN, id, "test")).map((f) => `${id}/test/${f}`) : []));
    expect(tests).toContain("covers/test/covers.test.ts");
    for (const t of tests) if (t.endsWith(".ts") && !t.includes("fixture")) expect(t).toMatch(/\.test\.ts$/);
  });
});
