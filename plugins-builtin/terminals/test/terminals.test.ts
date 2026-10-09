import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShells, inputCommands, parseShells } from "../shells";
import { createTerminalRunner, terminalMachines, terminalSocket, terminalCommand } from "../transport";
import { createPluginHost } from "../../../src/plugin-host";

const scratch = mkdtempSync(join(tmpdir(), "deck-term-test-")), socket = terminalSocket(scratch);
const machine = { id: "test", label: "Test machine", local: true, online: true };
const id = () => "deck-" + crypto.randomUUID();
const env = { ...process.env, HOME: scratch, SHELL: "/bin/sh", HISTFILE: "/dev/null" };
const run = createTerminalRunner(socket, env), shells = createShells(run, socket);
const available = !!Bun.which("tmux");
afterAll(async () => { if (available) await run(machine, ["kill-server"]).catch(() => {}); rmSync(scratch, { recursive: true, force: true }); });

test("terminal input validates the whole batch and encodes shell text as bytes", () => {
  const name = id();
  expect(inputCommands(name, [{ text: ";" }])[0]).toEqual(["send-keys", "-t", `${name}:0.0`, "-H", "3b"]);
  expect(inputCommands(name, [{ text: "שלום" }])[0].slice(4).join("")).toBe(Buffer.from("שלום").toString("hex"));
  expect(inputCommands(name, [{ key: "ctrl+c" }])[0].at(-1)).toBe("C-c");
  expect(() => inputCommands(name, [{ text: "echo safe" }, { key: "; kill-server" }])).toThrow();
  expect(() => inputCommands(name, [{ text: "\0" }])).toThrow();
  expect(() => inputCommands(name, [{ text: "x".repeat(8193) }])).toThrow();
  expect(() => inputCommands(name, [])).toThrow();
});
test("shell metadata only accepts owned IDs and safely decodes titles", () => {
  const name = id();
  expect(parseShells(`other\t1\tsecret\t1\t3\t0\n${name}\t1\thello%20world\t5\t100\t1`)).toEqual([{ id: name, kept: true, title: "hello world", created: 5000, until: 100, exited: true }]);
});
test("SSH destinations come only from configured remotes; app connections are excluded", () => {
  const host: any = { machines: () => [machine, { id: "linux", local: false }, { id: "app", kind: "app" }], use: () => new Map([["linux", { conf: { ssh: "configured-host" } }]]) };
  expect(terminalMachines(host)).toHaveLength(2);
  expect(terminalMachines(host)[1].ssh).toBe("configured-host");
  expect(terminalCommand("safe", ["send-keys", "'$(touch nope); "])).toContain("'\\''$(touch nope); '");
});
test("invalid machine identifiers and unsupported operations never become shell commands", async () => {
  const calls: any[] = [], s = createShells(async (_m, a) => { calls.push(a); return ""; }, "test");
  await expect(s.action(machine, { op: "read", id: "; kill-server" })).rejects.toThrow("identifier");
  expect(calls).toEqual([]);
});

test.skipIf(!available)("real PTY: open once, input, keep, reconstruct manager, reconnect, release and end", async () => {
  const name = id();
  const [a, b]: any[] = await Promise.all([shells.action(machine, { op: "open", id: name }), shells.action(machine, { op: "open", id: name })]);
  expect(a.terminal.id).toBe(b.terminal.id);
  expect((await shells.list(machine)).filter(s => s.id === name)).toHaveLength(1);
  await shells.action(machine, { op: "input", id: name, ops: [{ text: "export DECK_TERMINAL_TEST=retained; printf '\\nPTY_OK:%s\\n' \"$PWD\"" }, { key: "enter" }] });
  let text = "";
  for (let n = 0; n < 40; n++) {
    text = (await shells.action(machine, { op: "read", id: name }) as any).text;
    if (text.includes("PTY_OK:" + scratch)) break;
    await Bun.sleep(50);
  }
  expect(text).toContain("PTY_OK:" + scratch);
  const title = "'; $(echo not-executed) שלום";
  await shells.action(machine, { op: "keep", id: name, kept: true, title });
  await shells.action(machine, { op: "release", id: name });
  const restarted = createShells(run, socket);
  expect((await restarted.list(machine)).find(s => s.id === name)).toMatchObject({ kept: true, title });
  await restarted.action(machine, { op: "input", id: name, ops: [{ text: "printf '\\nSTATE:%s\\n' \"$DECK_TERMINAL_TEST\"" }, { key: "enter" }] });
  await Bun.sleep(100);
  expect((await restarted.action(machine, { op: "read", id: name }) as any).text).toContain("STATE:retained");
  await restarted.action(machine, { op: "close", id: name });
  await restarted.action(machine, { op: "close", id: name });
  expect((await restarted.list(machine)).some(s => s.id === name)).toBe(false);
});
test.skipIf(!available)("temporary shells are released and abandoned shells expire without a deck timer", async () => {
  const name = id(), expired = id(), short = createShells(run, socket, { lease: 700, reapSeconds: 1 });
  await shells.action(machine, { op: "open", id: name });
  await shells.action(machine, { op: "release", id: name });
  expect((await shells.list(machine)).some(s => s.id === name)).toBe(false);
  await short.action(machine, { op: "open", id: expired });
  await Bun.sleep(2500);
  expect((await shells.list(machine)).some(s => s.id === expired)).toBe(false);
});
test.skipIf(!available)("keep survives expiry; Undo re-arms the temporary lease", async () => {
  const name = id(), short = createShells(run, socket, { lease: 800, reapSeconds: 1 });
  await short.action(machine, { op: "open", id: name });
  await short.action(machine, { op: "keep", id: name, kept: true });
  await Bun.sleep(2100);
  expect((await short.list(machine)).find(s => s.id === name)?.kept).toBe(true);
  await short.action(machine, { op: "keep", id: name, kept: false });
  await Bun.sleep(2100);
  expect((await short.list(machine)).some(s => s.id === name)).toBe(false);
});
test.skipIf(!available)("plugin cleanup ends disposable shells while preserving kept ones", async () => {
  const temp = id(), kept = id();
  await shells.action(machine, { op: "open", id: temp });
  await shells.action(machine, { op: "open", id: kept });
  await shells.action(machine, { op: "keep", id: kept, kept: true });
  await shells.cleanup(machine);
  expect((await shells.list(machine)).map(s => s.id)).toEqual([kept]);
  await shells.action(machine, { op: "close", id: kept });
});
test("plugin routes, machine validation and switch-off work through the real host", async () => {
  const dir = join(scratch, "plugin"), builtin = join(dir, "builtin"), data = join(dir, "data");
  mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "terminals"));
  const core: any = { rows: () => [], machines: () => [machine], push: {}, decisions: () => [], isNode: () => false, sessions: {} };
  const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, core, log: () => {} });
  await host.start();
  const post = (body: unknown) => host.api(new Request("http://deck/api/terminals", { method: "POST" }), new URL("http://deck/api/terminals"), body);
  expect(host.active()).toEqual(["terminals"]);
  expect(host.isPage("/terminals")).toBe(true);
  expect((await (await post({ op: "machines" }))!.json()).machines).toHaveLength(1);
  expect((await post({ op: "open", machine: "unconfigured", id: id() }))!.status).toBe(400);
  await host.setEnabled("terminals", false);
  expect(host.assets()).toEqual([]);
  expect(host.isPage("/terminals")).toBe(false);
  expect(await post({ op: "machines" })).toBeUndefined();
});

test("folder terminals validate paths and neutralize tmux format expansion", async () => {
  const { terminalCwd } = await import("../shells");
  expect(terminalCwd("~")).toBe("#{HOME}");
  expect(terminalCwd("~/Projects/A B")).toBe("#{HOME}/Projects/A B");
  expect(terminalCwd("/tmp/#{HOME}/#(touch nope)")).toBe("/tmp/##{HOME}/##(touch nope)");
  expect(() => terminalCwd("relative")).toThrow();
  expect(() => terminalCwd("/tmp/\n")).toThrow();
  expect(() => terminalCwd({ path: "/tmp" })).toThrow();
});
test.skipIf(!available)("a terminal starts in the exact selected folder, including spaces, quotes and literal tmux formats", async () => {
  const cwd = join(scratch, "Project 'one' #{HOME}"); mkdirSync(cwd, { recursive: true });
  const name = id();
  try {
    await shells.action(machine, { op: "open", id: name, cwd });
    const actual = (await run(machine, ["display-message", "-p", "-t", `${name}:0.0`, "#{pane_current_path}"])).trim();
    expect(actual).toBe(await import("node:fs/promises").then(fs => fs.realpath(cwd)));
  } finally { await shells.action(machine, { op: "close", id: name }); }
});
test.skipIf(!available)("a missing directory never silently opens a shell in the home folder", async () => {
  const name = id();
  await expect(shells.action(machine, { op: "open", id: name, cwd: join(scratch, "missing") })).rejects.toThrow("selected folder");
  expect((await shells.action(machine, { op: "list" }) as any).terminals.some((s: any) => s.id === name)).toBe(false);
});
