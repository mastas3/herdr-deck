import { join } from "node:path";

export async function checkTerminalShortcuts(page, out, viewport) {
  const launches = [], checks = [];
  let delay = false, opened;
  // The second-machine fixture uses the same isolated PTY backend; record the requested target before mapping it.
  await page.route("**/api/terminals", async route => {
    const b = route.request().postDataJSON();
    if (b.op === "open") launches.push(b.machine);
    if (b.machine === "remote" || b.op === "open" && delay) {
      const response = await route.fetch({ postData: JSON.stringify({ ...b, machine: b.machine === "remote" ? "test" : b.machine }) });
      if (b.op === "open" && delay) { opened?.(); await new Promise(r => setTimeout(r, 700)); }
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.evaluate(() => {
    S.summary.machines = [{ id: "test", label: "Test Mac", local: true, online: true }, { id: "remote", label: "Linux work", local: false, online: true }, { id: "codex-app", label: "Codex app", kind: "app", local: true, online: true }];
    setMachine("all"); setMode("history");
  });
  async function launch() {
    await page.keyboard.press("Meta+k"); await page.waitForSelector("#palette[open]");
    if (!await page.getByRole("option", { name: "Open terminal", exact: true }).count()) throw Error("Open terminal is missing from everyday commands");
    await page.locator("#palQ").fill("open terminal"); await page.keyboard.press("Enter");
  }
  const location = page.url();
  await launch(); await page.waitForSelector("#qtPicker[open]");
  if (launches.length) throw Error("All machines launched before choosing a machine");
  if (await page.locator("#qtPicker [data-qt-pick]").count() !== 2) throw Error("Picker must contain only real machines");
  await page.screenshot({ path: join(out, `${viewport}-machine-picker.png`), animations: "disabled" });
  await page.getByRole("textbox", { name: "Find a machine" }).fill("Linux"); await page.keyboard.press("Enter");
  await page.waitForSelector("#qtDock #qtScreen");
  if (launches.join() !== "remote" || await page.evaluate(() => qt.active.machine) !== "remote") throw Error("Wrong chosen machine");
  if (page.url() !== location || await page.evaluate(() => S.mode !== "history" || S.machine !== "all")) throw Error("Terminal replaced the current view or filter");
  checks.push("Cmd+K command", "All machines asks", "searchable real-machine picker", "chosen machine routing", "current view/filter preserved");
  await page.screenshot({ path: join(out, `${viewport}-terminal-panel.png`), animations: "disabled" });
  await page.evaluate(() => setMode("usage"));
  if (!await page.locator("#qtDock #qtScreen").count() || !await page.evaluate(() => qt.active)) throw Error("Navigation closed the terminal panel");
  await page.locator("#qtDock [data-qt-close]").click(); await page.waitForFunction(() => !qt.active && !document.querySelector("#qtDock"));
  checks.push("panel survives navigation", "panel close disposes shell");
  await page.evaluate(() => setMachine("test")); await launch(); await page.waitForSelector("#qtDock #qtScreen");
  await page.waitForFunction(() => !qt.busy);
  if (await page.locator("#qtPicker[open]").count() || launches.at(-1) !== "test") throw Error("Specific machine did not launch directly");
  checks.push("specific machine launches directly");
  await page.locator("#qtDock [data-qt-keep]").click(); await page.waitForFunction(() => qt.active?.kept);
  const kept = await page.evaluate(() => qt.active.id);
  await page.locator("#qtDock [data-qt-close]").click(); await page.waitForFunction(() => !qt.active);
  const saved = await page.evaluate(() => qtCall("list", "test"));
  if (!saved.terminals.some(t => t.id === kept && t.kept)) throw Error("Kept panel terminal did not survive detach");
  await page.evaluate(id => qtCall("close", "test", { id }), kept); checks.push("keep and detach in panel");
  for (let n = 0; n < 3; n++) {
    await launch(); await page.waitForFunction(() => !qt.busy && qt.active?.machine === "test");
    if (await page.locator("#qtPicker[open]").count() || launches.at(-1) !== "test") throw Error("Repeated direct launch changed machines");
    await page.locator("#qtDock [data-qt-close]").click(); await page.waitForFunction(() => !qt.active && !document.querySelector("#qtDock"));
  }
  checks.push("repeated close and direct launch");
  await page.evaluate(() => setMachine("all")); const count = launches.length; await launch(); await page.waitForSelector("#qtPicker[open]");
  await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector("#qtPicker"));
  if (launches.length !== count) throw Error("Cancel launched a shell"); checks.push("picker Escape cancels");
  await page.evaluate(() => setMachine("test")); delay = true;
  const pending = new Promise(r => { opened = r; }); await launch(); await pending;
  await page.locator("#qtDock [data-qt-close]").click(); await page.waitForFunction(() => !qt.busy && !qt.active && !document.querySelector("#qtDock"));
  if ((await page.evaluate(() => qtCall("list", "test"))).terminals.length) throw Error("Cancelled launch leaked a terminal");
  checks.push("cancel slow panel launch");
  await page.unroute("**/api/terminals");
  return checks;
}
