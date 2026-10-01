#!/usr/bin/env node
// Run against `bun bin/aether-preview.ts --fixture`. Browser writes are intercepted; no real session receives input.
import { mkdirSync, writeFileSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || "/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs");
const base = process.env.AETHER_TEST_URL || "http://127.0.0.1:4768";
const out = process.argv[2] || "/tmp/aether-ui"; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (ok, message) => { if (!ok) throw new Error(message); };
try {
  for (const [name, config] of Object.entries({ desktop: { viewport: { width: 1440, height: 1000 } }, phone: { viewport: { width: 393, height: 873 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } })) {
    const context = await browser.newContext({ ...config, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [], mutations = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let failChat = false, slowChat = false, chatCalls = 0;
    await page.route("**/*", async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.origin !== base) return route.abort();
      if (u.pathname === "/api/chat") {
        chatCalls++;
        if (slowChat) await new Promise((r) => setTimeout(r, 400));
        if (failChat) return route.fulfill({ status: 503, json: { error: "Fixture connection lost" } });
        return route.continue();
      }
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        if (u.pathname === "/api/detail") return route.fulfill({ json: { asks: 1, subagents: [], images: [], turns: [], recap: "Fixture preview" } });
        if (u.pathname === "/api/screen") return route.fulfill({ json: { text: "Fixture only" } });
        if (u.pathname === "/api/push/presence") return route.fulfill({ json: { ok: true } });
        mutations.push({ path: u.pathname, body });
        return route.fulfill({ status: 403, json: { error: "Fixture forbids live mutations" } });
      }
      return route.continue();
    });
    await page.goto(base + "/?view=aether");
    await page.waitForFunction(() => aetherConnected());
    await page.waitForFunction(() => document.querySelector(".aether-target")?.textContent.includes("fixture-aether-session"));
    await page.locator(".aether-target").waitFor({ state: "visible" });
    check(await page.locator(".aether-target").textContent().then((s) => s.includes("fixture-aether-session")), "Target not identified");
    await page.waitForFunction(() => document.querySelector(".aether-garden")?.naturalWidth === 1536);
    check(await page.evaluate(async () => { const img = new Image(); img.src = "/aether-art/aether.webp"; await img.decode(); return img.width === 1536 && img.height === 2288; }), "Approved sprite atlas geometry changed");
    check(await page.locator(".aether-fox").evaluate((el) => getComputedStyle(el).backgroundPositionY) === "-728px", "Working sprite row is wrong");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Horizontal viewport overflow");
    check(await page.evaluate(() => { const a = document.querySelector('[data-aether="choose"]').getBoundingClientRect(), b = document.querySelector('[data-vclose]').getBoundingClientRect(); return a.right <= b.left || a.left >= b.right || a.top >= b.bottom || a.bottom <= b.top; }), "Change and Close overlap");
    await page.screenshot({ path: `${out}/aether-${name}.png`, fullPage: true });
    for (const [status, row] of [["blocked", "-624px"], ["done", "-312px"]]) {
      await page.evaluate((status) => { rowOf(aetherState.target.key).status = status; aetherRender(); }, status);
      check(await page.locator(".aether-fox").evaluate((el) => getComputedStyle(el).backgroundPositionY) === row, "Wrong sprite for " + status);
      await page.screenshot({ path: `${out}/aether-${name}-${status}.png`, fullPage: true });
    }
    await page.evaluate(() => { rowOf(aetherState.target.key).status = "working"; aetherRender(); });
    await page.locator(".aether-history summary").click();
    await page.evaluate(() => { aetherState.fetched = Date.now(); aetherRender(); });
    check(await page.locator(".aether-history").getAttribute("open") !== null, "Live update collapsed history");
    // The picker has an explicit commit and leaves the current target alone on all dismissals.
    await page.locator('[data-aether="choose"]').first().click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.aether-picker"));
    check(await page.locator("dialog.aether-picker").count() === 0, "Escape did not dismiss picker");
    await page.locator('[data-aether="choose"]').first().click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("dialog.aether-picker"));
    check(await page.locator("dialog.aether-picker").count() === 0, "Cancel did not dismiss picker");
    // Repeated refreshes share the same in-flight read. A vanished/reused pane cannot get a reply.
    slowChat = true;
    const beforeRefresh = chatCalls;
    await page.evaluate(async () => { await Promise.all([aetherRefresh(), aetherRefresh(), aetherRefresh()]); });
    check(chatCalls === beforeRefresh + 1, "Repeated refreshes issued duplicate reads");
    slowChat = false;
    await page.evaluate(() => { es.close(); rowOf(aetherState.target.key).sessionId = "different-session"; aetherRender(); aetherReply(); });
    check(await page.locator(".aether-reply").isDisabled(), "Reused target is actionable");
    check(await page.evaluate(() => S.mode) === "aether", "Wrong target navigated");
    await page.evaluate(() => { rowOf(aetherState.target.key).sessionId = aetherState.target.sessionId; aetherRender(); });
    // An offline phone retains the last update but cannot reply. Explicit retry recovers.
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector(".aether-reply").disabled);
    await page.screenshot({ path: `${out}/aether-${name}-offline.png`, fullPage: true });
    await context.setOffline(false);
    failChat = true;
    await page.evaluate(async () => { await aetherRefresh(); });
    await page.waitForSelector(".aether-error");
    check(await page.locator(".aether-latest").innerText().then((s) => s.includes("first companion")), "Read failure lost last update");
    failChat = false;
    await page.getByRole("button", { name: "Retry connection" }).click();
    await page.waitForFunction(() => aetherConnected());
    // The approved handoff reuses select()/the core composer. Repeated taps cannot send anything.
    await page.evaluate(() => { delete window.__BOOT__.aetherPreview; S.autoBrief = false; const r = aetherCurrent(); r.status = "idle"; S.details.set(r.key, { at: Date.now(), stamp: r.lastActiveAt, data: { asks: 1, subagents: [], images: [], turns: [] } }); aetherRender(); });
    await page.evaluate(() => { aetherReply(); aetherReply(); });
    await page.waitForFunction(() => !S.mode && S.sel === "fixture:companion");
    await page.locator("#composer").waitFor({ state: "visible" });
    check(await page.locator("#composer").isVisible(), "Existing composer not visible");
    check(mutations.length === 0, "Reply handoff attempted mutation: " + JSON.stringify(mutations));
    // Android back restores the island; close leaves it. Desktop uses the tab to return.
    if (name === "phone") { await page.goBack(); await page.waitForFunction(() => S.mode === "aether"); }
    else await page.evaluate(() => setMode("aether"));
    await page.locator("[data-vclose]").click();
    check(await page.evaluate(() => S.mode) !== "aether", "Close did not leave island");
    check(errors.length === 0, "Page errors: " + errors.join("; "));
    results.push({ viewport: name, passed: ["render", "approved artwork decode", "working/blocked/done sprite geometry", "no overflow", "history retention", "picker Escape", "picker Cancel", "refresh coalescing", "wrong target", "offline", "failed read keeps update", "retry", "repeated reply handoff", "no mutations", "navigation dismissal"], chatCalls, errors, mutations });
    await context.close();
  }
} finally { await browser.close(); writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results, null, 2));
