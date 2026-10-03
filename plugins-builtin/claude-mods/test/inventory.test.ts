import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inventory, declaredCommands, commandsFor } from "../inventory";
const home = mkdtempSync("/tmp/deck-mod-inventory-");
afterAll(() => rmSync(home, { recursive: true, force: true }));
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
const profile = join(home, ".claude"), alt = join(home, ".claude-max"), mod = join(home, "my-mod");
write(join(mod, ".claude-plugin/plugin.json"), { name: "my-mod", description: "Test mod", version: "1.2.0" });
write(join(mod, "hooks/hooks.json"), { modules: ["./register.ts", "../../outside.ts"] });
write(join(mod, "hooks/register.ts"), "const COMMAND = 'next'; $.command.register({ name: COMMAND }); $.command.register({ name: 'progress' });");
write(join(home, "outside.ts"), "$.command.register({ name: 'escaped' });");
write(join(profile, "settings.json"), { enabledPlugins: { "my-mod@local": true, "off@local": false }, env: { API_KEY: "TEST_SECRET", CLAUDE_CODE_PLUGIN_DIRS: mod } });
write(join(profile, "plugins/installed_plugins.json"), { plugins: { "my-mod@local": [{ scope: "user", installPath: mod }], "off@local": [{ scope: "user", installPath: mod }] } });
mkdirSync(join(alt, "projects"), { recursive: true });
write(join(alt, "settings.json"), { disableAllHooks: true, env: { CLAUDE_CODE_PLUGIN_DIRS: mod } });
test("inventories marketplace installs and local dirs per profile, without settings secrets", () => {
  const ps = inventory(home, {}), p = ps.find(p => p.dir === profile)!;
  expect(ps).toHaveLength(2);
  expect(p.plugins).toHaveLength(3);
  expect(p.plugins[0]).toMatchObject({ mod: true, enabled: true, commands: ["/next", "/progress"] });
  expect(p.plugins[1].enabled).toBe(false);
  expect(JSON.stringify(ps)).not.toContain("TEST_SECRET");
  expect(JSON.stringify(ps)).not.toContain("escaped");
  expect(commandsFor(p, "/work")).toEqual(["/next", "/progress"]);
  expect(commandsFor(ps.find(p => p.dir === alt), "/work")).toEqual([]);
});
test("project installs do not offer commands in another project", () => {
  const p = inventory(home, {})[0];
  p.plugins = [{ ...p.plugins[0], projectPath: "/work/app" }];
  expect(commandsFor(p, "/work/app/src")).toHaveLength(2);
  expect(commandsFor(p, "/work/application")).toEqual([]);
});
test("malformed settings report unknown rather than enabling mods", () => {
  mkdirSync(join(home, ".claude-broken/projects"), { recursive: true });
  write(join(home, ".claude-broken/settings.json"), "{");
  const p = inventory(home, {}).find(p => p.label === ".claude-broken")!;
  expect(p.error).toContain("unknown");
  expect(p.plugins).toEqual([]);
});
test("command extraction accepts literal/constant registrations, never evaluates code", () => {
  expect(declaredCommands("$.command.register({ name: dangerous() }); $.command.register({ name: 'next\nrm' }); $.registerCommand({ name: 'links' });")).toEqual(["/links"]);
});
