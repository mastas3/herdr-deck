#!/usr/bin/env node
// Real shell/browser checks in a scratch HOME. Never attaches to an existing session or starts an agent.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkTerminalShortcuts } from "./ui-terminal-shortcuts.mjs";

const repo = resolve(new URL("..", import.meta.url).pathname), scratch = mkdtempSync(join(tmpdir(), "deck-term-ui-"));
const out = resolve(process.argv[2] || "/tmp/deck-terminal-ui"); mkdirSync(out, { recursive: true });
const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, data = join(scratch, ".config/herdr-deck"); mkdirSync(data, { recursive: true });
writeFileSync(join(data, "code-plugins.json"), JSON.stringify({ enabled: { terminals: true }, installed: [], settings: {} }));
writeFileSync(join(data, "hosts.json"), JSON.stringify({ self: { id: "test", label: "Test Mac" } }));
const env = { PATH: process.env.PATH, HOME: scratch, SHELL: "/bin/sh", HISTFILE: "/dev/null", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", DECK_PORT: String(port), DECK_DEV: "1", DECK_ROLE: "hub", DECK_PLUGINS_DEFAULT: "off", DECK_NO_JEV: "1", DECK_CLAUDE_BIN: "/usr/bin/false", DECK_CODEX_BIN: "/usr/bin/false", DECK_JEV_BIN: "/usr/bin/false", DECK_NO_LIBRARY: "1", DECK_NO_LOGINS: "1", OLLAMA_HOST: "http://127.0.0.1:9", DECK_PROJECTS_DIR: join(scratch, "Projects"), DECK_WIKI_DIR: join(scratch, "wiki") };
let child, browser;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function start() {
  child = spawn(process.env.BUN || "bun", ["src/server.ts"], { cwd: repo, env, stdio: "ignore" });
  for (let n = 0; n < 100; n++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await wait(100); }
  throw Error("Scratch deck did not start");
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await exited; } }
async function output(page, marker) {
  try { await page.waitForFunction(m => document.querySelector("#qtScreen")?.textContent.includes(m), marker, { timeout: 15000 }); }
  catch (e) { throw Error(`${e.message}\n${await page.locator("#qtWorkspace").innerText()}`); }
}
async function command(page, text) { await page.locator("#qtCommand").fill(text); await page.locator("#qtForm button").click(); await page.waitForFunction(() => !document.querySelector("#qtCommand")?.disabled); }
try {
  await start();
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH || "/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs");
  browser = await chromium.launch(); const summary = [];
  for (const vp of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 393, height: 873 }]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.name === "phone", hasTouch: vp.name === "phone", colorScheme: "dark" }), errors = [], mutations = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (/\/api\/(new|send|keys|close|start)$/.test(new URL(r.url()).pathname)) mutations.push(r.url()); });
    await page.goto(`${base}/terminals`); await page.waitForSelector("[data-qt-new]");
    const before = await page.evaluate(() => S.rows.size);
    if ((await fetch(`${base}/api/terminals`, { method: "POST", body: '{"op":"machines"}' })).status !== 403) throw Error("Tokenless request was allowed");
    await page.getByRole("button", { name: "Open terminal", exact: true }).click(); await page.waitForSelector("#qtScreen");
    await command(page, "export QUICK_TEST=preserved; printf '\\n%s\\n' SHELL_READY"); await output(page, "\nSHELL_READY");
    await page.locator("#qtCommand").fill("draft preserved"); await wait(1300);
    if (await page.locator("#qtCommand").inputValue() !== "draft preserved") throw Error("Polling lost the draft");
    await page.locator("#qtCommand").fill("");
    await command(page, "sleep 20"); await page.getByRole("button", { name: "Send ctrl+c", exact: true }).click();
    await command(page, "printf '\\n%s\\n' INTERRUPTED_OK"); await output(page, "\nINTERRUPTED_OK");
    if (vp.name === "desktop") {
      await page.locator("#qtScreen").focus(); await page.keyboard.type("printf '\\nDIRECT:%s\\n' typed"); await page.keyboard.press("Enter"); await output(page, "DIRECT:typed");
    }
    await command(page, "printf '\\nUNICODE:%s\\n' 'שלום' "); await output(page, "UNICODE:שלום");
    await page.getByRole("button", { name: "Keep terminal", exact: true }).click(); await page.waitForFunction(() => document.querySelector("#qtState").textContent.startsWith("Kept"));
    const id = await page.evaluate(() => qt.active.id);
    await page.screenshot({ path: join(out, `${vp.name}-terminal.png`) });
    await page.getByRole("button", { name: "Detach", exact: true }).click(); await page.waitForFunction(() => !document.querySelector("#qtScreen"));
    await page.reload(); await page.waitForSelector(`[data-qt-resume="${id}"]`);
    await page.locator(`[data-qt-resume="${id}"]`).click(); await page.waitForSelector("#qtScreen");
    await command(page, "printf '\\nRECONNECTED:%s\\n' \"$QUICK_TEST\""); await output(page, "RECONNECTED:preserved");
    await page.route("**/api/terminals", route => {
      const b = route.request().postDataJSON();
      return b.op === "read" ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fixture connection lost"}' }) : route.continue();
    });
    await page.waitForFunction(() => document.querySelector("#qtStatus")?.textContent.includes("Fixture connection lost"));
    await page.unroute("**/api/terminals"); await page.waitForFunction(() => document.querySelector("#qtStatus")?.textContent === "");
    if (await page.evaluate(() => qt.active.id) !== id) throw Error("Connection recovery changed the terminal");
    // Restart only the scratch deck. tmux and the kept shell must stay intact.
    await stop(); await start(); await page.reload(); await page.waitForSelector(`[data-qt-resume="${id}"]`);
    await page.locator(`[data-qt-resume="${id}"]`).click(); await page.waitForSelector("#qtScreen");
    await command(page, "printf '\\nRESTARTED:%s\\n' \"$QUICK_TEST\""); await output(page, "RESTARTED:preserved");
    await page.getByRole("button", { name: "Detach", exact: true }).click(); await page.waitForFunction(() => !document.querySelector("#qtScreen"));
    await page.locator(`[data-qt-end="${id}"]`).click(); await page.getByRole("button", { name: "End terminal", exact: true }).click();
    await page.waitForFunction(id => !document.querySelector(`[data-qt-resume="${id}"]`), id);
    await page.getByRole("button", { name: "Open terminal", exact: true }).click(); await page.waitForSelector("#qtScreen");
    const temp = await page.evaluate(() => qt.active.id);
    await page.getByRole("button", { name: "Close terminal", exact: true }).click();
    await page.waitForFunction(id => !document.querySelector("#qtScreen") && !document.querySelector(`[data-qt-resume="${id}"]`), temp);
    await page.getByRole("button", { name: "Open terminal", exact: true }).click(); await page.waitForSelector("#qtScreen");
    await page.evaluate(() => setMode("history")); await page.waitForFunction(() => !qt.active); await page.evaluate(() => qt.send); await wait(300);
    await page.goto(`${base}/terminals`); await page.waitForSelector("[data-qt-new]"); await page.waitForFunction(() => qt.lists.get("test")?.terminals?.length === 0);
    // An open response arriving after navigation must release its newly created shell.
    let opened;
    const openReceived = new Promise(r => { opened = r; });
    await page.route("**/api/terminals", async route => {
      if (route.request().postDataJSON().op !== "open") return route.continue();
      const response = await route.fetch(); opened(); await wait(700); await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Open terminal", exact: true }).click(); await openReceived;
    await page.evaluate(() => setMode("history")); await page.waitForFunction(() => !qt.busy && !qt.active);
    await page.unroute("**/api/terminals");
    await page.goto(`${base}/terminals`); await page.waitForFunction(() => qt.lists.get("test")?.terminals?.length === 0);
    if (await page.evaluate(() => S.rows.size) !== before || mutations.length) throw Error("Terminal changed agent sessions");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Horizontal page overflow");
    if (errors.length) throw Error(errors.join("\n"));
    await page.screenshot({ path: join(out, `${vp.name}-machines.png`) });
    const shortcuts = await checkTerminalShortcuts(page, out, vp.name);
    if (errors.length) throw Error(errors.join("\n"));
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Panel causes horizontal page overflow");
    summary.push({ viewport: vp.name, checks: ["token required", "real shell", "draft survives polling", "Ctrl+C", "Unicode input", "connection recovery", "delayed open cleanup", ...(vp.name === "desktop" ? ["direct keyboard input"] : []), "keep", "detach", "reload/reconnect", "deck restart", "explicit end", "temporary close", "navigation cleanup", "no agent sessions", "no page overflow", "no page errors"] });
    summary.at(-1).checks.push(...shortcuts);
    await page.close(); console.log(`${vp.name}: ${summary.at(-1).checks.length} checks passed`);
  }
  await stop(); writeFileSync(join(data, "code-plugins.json"), JSON.stringify({ enabled: { terminals: false }, installed: [], settings: {} })); await start();
  const page = await browser.newPage(), requests = []; page.on("request", r => { if (r.url().includes("/api/terminals")) requests.push(r.url()); });
  await page.goto(base); await wait(500);
  if (await page.locator('[data-view="terminals"]').count() || requests.length || await page.evaluate(() => deckPlugins.has("terminals"))) throw Error("Disabled plugin is still active");
  summary.push({ pluginOff: true, noTerminalRequests: true });
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
} finally {
  await browser?.close(); await stop();
  const socket = "deck-term-" + createHash("sha256").update(data).digest("hex").slice(0, 16);
  const cleanup = spawn("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" }); await new Promise(r => cleanup.once("exit", r));
  rmSync(scratch, { recursive: true, force: true });
}
