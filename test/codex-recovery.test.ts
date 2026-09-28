import { expect, test } from "bun:test";
import { createCodexRecovery } from "../src/codex-recovery";

test("connected recovery never opens or raises the desktop", async () => {
  let opens = 0;
  const recovery = createCodexRecovery({ platform: "darwin", control: { watch: async () => ({ ready: true, requests: [] }) }, open: async () => { opens++; } });
  expect(await recovery.connect("fixture-task")).toMatchObject({ ready: true });
  expect(opens).toBe(0);
});

test("explicit recovery coalesces opening and waits for the original task owner", async () => {
  let checks = 0;
  const urls: string[] = [];
  const recovery = createCodexRecovery({ platform: "darwin", sleep: async () => {},
    control: { watch: async () => ({ ready: ++checks >= 3, requests: [] }) }, open: async (url) => { urls.push(url); } });
  const results = await Promise.all([recovery.connect("fixture-task"), recovery.connect("fixture-task")]);
  expect(results.every((r: any) => r.ready)).toBe(true);
  expect(urls).toEqual(["codex://threads/fixture-task"]);
});

test("recovery validates task ids and keeps unavailable hosts honest", async () => {
  let opens = 0, checks = 0;
  const recovery = createCodexRecovery({ platform: "linux", control: { watch: async () => { checks++; return { ready: false, requests: [] }; } }, open: async () => { opens++; } });
  await expect(recovery.connect("../bad-url")).rejects.toMatchObject({ code: "CODEX_INVALID" });
  expect(checks).toBe(0);
  await expect(recovery.connect("fixture-task")).rejects.toThrow("host machine");
  expect(recovery.canOpen).toBe(false); expect(opens).toBe(0);
});

test("opening does not claim success unless a fresh desktop owner arrives", async () => {
  const recovery = createCodexRecovery({ platform: "darwin", attempts: 2, sleep: async () => {},
    control: { watch: async () => ({ ready: false, requests: [], error: "No owner" }) }, open: async () => {} });
  expect(await recovery.connect("fixture-task")).toMatchObject({ ready: false, error: "No owner" });
});
