import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../terminals-launch.js", import.meta.url), "utf8");
const machines = [{ id: "mac", label: "Mac", local: true, online: true }, { id: "linux", label: "Linux", online: false }, { id: "codex-app", kind: "app", local: true }];
function setup(scope: string) {
  const context: any = { S: { machine: scope, self: "mac", sel: "linux-session", summary: { machines } }, qt: {}, opened: [], picked: 0 };
  runInNewContext(source + "\nqtOpenDock = id => opened.push(id); qtPickMachine = () => picked++;", context);
  return context;
}
test("All machines always asks, even if a session on one machine is selected", () => {
  const c = setup("all"); c.qtQuickTerminal();
  expect(c.picked).toBe(1); expect(c.opened).toEqual([]);
  expect(c.qt.machines.map((m: any) => m.id)).toEqual(["mac", "linux"]);
});
test("a specific machine opens directly, including a connection which must be retried", () => {
  for (const id of ["mac", "linux"]) {
    const c = setup(id); c.qtQuickTerminal(); expect(c.opened).toEqual([id]); expect(c.picked).toBe(0);
  }
});
test("Codex app scope uses its real local machine; a removed machine asks again", () => {
  const c = setup("codex-app"); c.qtQuickTerminal(); expect(c.opened).toEqual(["mac"]);
  const missing = setup("removed"); missing.qtQuickTerminal(); expect(missing.opened).toEqual([]); expect(missing.picked).toBe(1);
});
