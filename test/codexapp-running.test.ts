import { expect, test } from "bun:test";
import { _setRunningProbe, codexAppRunning } from "../src/codexapp";

// The deck reads this on every patch; a slow pgrep on a loaded machine used to freeze the whole server.
test("codexAppRunning never waits on the process check", async () => {
  let release!: (up: boolean) => void;
  let calls = 0;
  _setRunningProbe(() => { calls++; return new Promise<boolean>((r) => (release = r)); });

  const t = performance.now();
  expect(codexAppRunning()).toBe(false); // nothing known yet
  expect(codexAppRunning()).toBe(false); // still checking: no second probe
  expect(performance.now() - t).toBeLessThan(5);
  expect(calls).toBe(1);

  release(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(codexAppRunning()).toBe(true); // fresh answer, cached for a while
  expect(calls).toBe(1);
});

test("a failed check keeps the last answer", async () => {
  _setRunningProbe(() => Promise.reject(new Error("pgrep missing")));
  const before = codexAppRunning();
  await new Promise((r) => setTimeout(r, 0));
  expect(codexAppRunning()).toBe(before);
});
