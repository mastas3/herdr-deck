#!/usr/bin/env node
// Real folder/PTY checks in an isolated HOME, with synthetic sessions and two machine fixtures.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const repo = resolve(new URL('..', import.meta.url).pathname), scratch = mkdtempSync(join(tmpdir(), 'deck-explorer-ui-'));
const out = resolve(process.argv[2] || '/tmp/deck-explorer-ui'); mkdirSync(out, { recursive: true });
const keep = process.argv.includes('--keep'), preview = process.argv.includes('--preview');
const portArg = process.argv.indexOf('--port');
const net = createServer(); await new Promise(r => net.listen(portArg >= 0 ? Number(process.argv[portArg + 1]) : preview ? 4776 : 0, '127.0.0.1', r));
const port = net.address().port; await new Promise(r => net.close(r));
const base = `http://127.0.0.1:${port}`, data = join(scratch, '.config/herdr-deck'); mkdirSync(data, { recursive: true });
for (const p of ['Projects/herdr-deck/src', 'Projects/herdr-deck/design', 'Projects/herdr-deck/empty folder', 'Projects/Atlas', 'wiki', '.hidden']) mkdirSync(join(scratch, p), { recursive: true });
writeFileSync(join(data, 'hosts.json'), JSON.stringify({ self: { id: 'test', label: 'MacBook Pro' } }));
writeFileSync(join(data, 'code-plugins.json'), JSON.stringify({ enabled: { terminals: true }, installed: [], settings: {} }));
const env = { PATH: process.env.PATH, HOME: scratch, SHELL: '/bin/sh', HISTFILE: '/dev/null', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', DECK_PORT: String(port), DECK_DEV: '1', DECK_ROLE: 'hub', DECK_PLUGINS_DEFAULT: 'off', DECK_NO_JEV: '1', DECK_CLAUDE_BIN: '/usr/bin/false', DECK_CODEX_BIN: '/usr/bin/false', DECK_JEV_BIN: '/usr/bin/false', DECK_NO_LIBRARY: '1', DECK_NO_LOGINS: '1', OLLAMA_HOST: 'http://127.0.0.1:9' };
const child = spawn('bun', ['src/server.ts'], { cwd: repo, env, stdio: 'ignore' });
let browser;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(100); }
  const state = await (await fetch(base + '/api/state')).json();
  const rows = [
    { key: 'demo:deck', machine: 'test', cwd: join(scratch, 'Projects/herdr-deck'), projectRoot: join(scratch, 'Projects/herdr-deck'), project: 'herdr-deck', title: 'Make navigation feel familiar', status: 'working', now: 'Refining the folder explorer' },
    { key: 'demo:review', machine: 'test', cwd: join(scratch, 'Projects/herdr-deck'), projectRoot: join(scratch, 'Projects/herdr-deck'), project: 'herdr-deck', title: 'Review the new folder interactions', status: 'blocked' },
    { key: 'demo:src', machine: 'test', cwd: join(scratch, 'Projects/herdr-deck/src'), project: 'herdr-deck', title: 'Directory browsing and terminals', status: 'idle' },
    { key: 'demo:atlas', machine: 'test', cwd: join(scratch, 'Projects/Atlas'), project: 'Atlas', title: 'A calmer reading experience', status: 'done' },
    { key: 'demo:wiki', machine: 'test', cwd: join(scratch, 'wiki'), project: 'wiki', title: 'Collect this week’s notes', status: 'idle' },
  ];
  await fetch(base + '/api/dev/fake-rows', { method: 'POST', headers: { 'x-deck-token': state.token, 'content-type': 'application/json' }, body: JSON.stringify({ rows: rows.map(r => ({ ...r, lastActiveAt: Date.now() })) }) });
  assert.equal((await fetch(base + '/api/browse-folders', { method: 'POST', body: '{}' })).status, 403);
  if (preview) { console.log(JSON.stringify({ preview: base, scratch, port })); await new Promise(() => {}); }
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH || '/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs');
  browser = await chromium.launch(); const results = [];
  for (const phone of [false, true]) {
    const page = await browser.newPage({ viewport: { width: phone ? 393 : 1440, height: phone ? 873 : 1000 }, isMobile: phone, hasTouch: phone, colorScheme: 'dark' });
    const errors = [], unsafe = [], browseReads = []; page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/(new|send|start|keys|close)$/.test(new URL(r.url()).pathname)) unsafe.push(r.url()); });
    page.on('request', r => { if (new URL(r.url()).pathname === '/api/browse-folders') browseReads.push(r.url()); });
    console.log('Checking', phone ? 'phone' : 'desktop');
    await page.goto(base); await page.waitForSelector('.ex-tree');
    assert.equal(browseReads.length, 0, 'The initial tree uses inlined state without directory scans');
    await page.evaluate(home => { explorer.homes.set('test', home); renderNow(); }, scratch);
    const folder = path => page.locator(`[data-ex-node=${JSON.stringify(JSON.stringify(['test', path]))}] > .ex-line`);
    const project = join(scratch, 'Projects/herdr-deck'), src = project + '/src';
    await folder(src).click();
    assert.equal(await folder(src).getAttribute('aria-expanded'), 'true');
    assert.equal(await folder(project).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-key="demo:src"]').count(), 1);
    await page.getByRole('button', { name: 'Actions for herdr-deck', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Browse folders', exact: true }).click();
    await page.waitForSelector(`[data-ex-node=${JSON.stringify(JSON.stringify(['test', project + '/empty folder']))}]`);
    await folder(project + '/empty folder').click();
    await page.getByRole('button', { name: 'Terminal in empty folder', exact: true }).click();
    await page.waitForSelector('#qtScreen');
    await page.locator('#qtCommand').fill(`test "$PWD" -ef '${project}/empty folder' && printf '\\nEXPLORER_CWD_OK\\n'`); await page.locator('#qtForm button').click();
    await page.waitForFunction(() => document.querySelector('#qtScreen')?.textContent.includes('\nEXPLORER_CWD_OK')).catch(async e => { throw Error(e.message + '\n' + await page.locator('#qtWorkspace').innerText()); });
    assert.equal(await page.evaluate(() => S.rows.size), 5);
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await page.waitForFunction(() => !qt.active);
    console.log('Folder terminal verified');
    // A live update keeps the focused button and its folder open, even after attention clears.
    assert.equal(await page.evaluate(project => {
      const line = [...document.querySelectorAll('.ex-line')].find(el => el.dataset.exFocus === JSON.stringify(['test', project]));
      const button = line.querySelector('[data-ex-action="menu"]'); button.focus();
      const row = rowOf('demo:review'), status = row.status, title = row.title;
      row.status = 'idle'; row.title = 'Live update'; renderNow();
      const kept = document.activeElement === button && button.isConnected && line.getAttribute('aria-expanded') === 'true';
      row.status = status; row.title = title; renderNow(); return kept;
    }, project), true);
    assert.equal(await page.locator('.ex-tree [role="treeitem"][tabindex="0"]').count(), 1);
    // Searching an empty loaded folder keeps its entire path; closing it is temporary to the search.
    await page.locator('#q').fill('empty folder');
    await page.waitForFunction(() => S.q === 'empty folder' && explorer.search === S.q);
    assert.equal(await folder(project + '/empty folder').count(), 1);
    assert.equal(await page.locator('.ex-tree .ex-session').count(), 0);
    await folder(project + '/empty folder').click();
    assert.equal(await folder(project + '/empty folder').getAttribute('aria-expanded'), 'false');
    await page.locator('#q').fill(''); await page.waitForFunction(() => !S.q && explorer.search === "");
    assert.equal(await folder(project + '/empty folder').getAttribute('aria-expanded'), 'true');
    await folder(project + '/empty folder').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exFocus), JSON.stringify(['test', project + '/empty folder']));
    // The command palette uses the selected directory, not a previous agent or an unrelated filter.
    await page.evaluate(() => qtQuickTerminal()); await page.waitForSelector('#qtScreen');
    assert.equal(await page.evaluate(() => qt.active.cwd), project + '/empty folder');
    await page.screenshot({ path: join(out, (phone ? 'phone' : 'desktop') + '-terminal.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    await page.waitForFunction(() => !qt.active);

    // Collapsing one branch preserves other branches, and reload remembers the user's choice.
    await folder(project).click();
    assert.equal(await folder(project).getAttribute('aria-expanded'), 'false');
    await page.reload(); await page.waitForSelector('.ex-tree');
    assert.equal(await folder(project).getAttribute('aria-expanded'), 'false');
    await folder(project).click();
    // Keyboard folders and sessions share the same tree; arrows never send input to an agent.
    await folder(project).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'demo:review');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.exFocus), JSON.stringify(['test', project]));
    await page.locator('#q').fill('Directory browsing');
    await page.waitForFunction(() => S.visible.length === 1);
    assert.equal(await page.locator('.ex-tree .ex-session').count(), 1);
    await page.locator('#q').fill(''); await page.waitForFunction(() => !S.q && explorer.search === "");
    // Go to an arbitrary path clears a previous search and preserves the typed path through updates.
    await page.locator("#q").fill("Directory browsing"); await page.waitForFunction(() => explorer.search === "Directory browsing");
    await page.getByRole('button', { name: 'Go to folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill(project + '/design');
    await page.evaluate(() => { const r = rowOf('demo:wiki'); r.title += ' updated'; renderNow(); });
    assert.equal(await page.getByRole('textbox', { name: 'Folder path', exact: true }).inputValue(), project + '/design');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.waitForFunction(() => explorer.selected.includes('/design'));
    assert.equal(await folder(project + '/design').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#q').inputValue(), '');
    await page.evaluate(() => { explorer.open = {}; S.sel = null; S.board = true; renderNow(); });
    await page.locator('[data-key="demo:deck"]').click();
    await page.waitForFunction(() => S.sel === 'demo:deck' && !S.board);
    if (phone) { await page.locator('#mBack').click(); await page.waitForFunction(() => app.dataset.mview === 'list'); }
    assert.equal(await folder(project).getAttribute('aria-expanded'), 'true');
    await page.route('**/api/new-options', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ recent: [], projects: [], argHints: {}, choices: {} }) }));
    await page.getByRole('button', { name: 'Actions for herdr-deck', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New session here…', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('#nCwd').value === expected, project);
    assert.equal(await page.evaluate(() => newMachine), 'test');
    await page.evaluate(() => { $('newDlg').close(); S.sel = null; S.board = true; renderNow(); });
    // A remote fixture verifies exact machine/path routing, without SSH or real agent actions.
    await page.evaluate(() => { S.summary.machines.push({ id: 'remote', label: 'Linux workstation', online: true }); S.rows.set('demo:remote', { ...S.rows.get('demo:wiki'), key: 'demo:remote', machine: 'remote', cwd: '/home/dev/Projects/Atlas', project: 'Atlas', title: 'Build the data index', status: 'working' }); renderNow(); });
    await page.route('**/api/browse-folders', async route => {
      const b = route.request().postDataJSON();
      if (b.machine !== 'remote') return route.continue();
      assert.equal(b.path, '/home/dev/Projects/Atlas');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ path: b.path, home: '/home/dev', folders: [{ name: 'data', path: b.path + '/data' }] }) });
    });
    await page.locator(`[data-ex-node=${JSON.stringify(JSON.stringify(['remote', '/home/dev/Projects/Atlas']))}] > .ex-line`).click();
    await page.getByRole('button', { name: 'Actions for Atlas', exact: true }).last().click();
    await page.getByRole('menuitem', { name: 'Browse folders', exact: true }).click();
    await page.waitForSelector(`[data-ex-node=${JSON.stringify(JSON.stringify(['remote', '/home/dev/Projects/Atlas/data']))}]`);
    const viewport = phone ? 'phone' : 'desktop';
    await page.evaluate(() => { $('rows').scrollTop = 0; });
    await page.screenshot({ path: join(out, viewport + '-explorer.png'), animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await folder(project).click();
    const animations = await page.evaluate(() => document.querySelector('.ex-tree').getAnimations({ subtree: true }).map(a => ({ name: a.animationName, target: a.effect.target.className, state: a.playState, time: a.currentTime, frames: a.effect.getKeyframes(), timing: a.effect.getTiming() })));
    assert.deepEqual(animations, []);
    // The deck's explicit setting also works when the OS permits motion.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => motion.setReduced(true)); await folder(project).click();
    assert.deepEqual(await page.evaluate(() => document.querySelector('.ex-tree').getAnimations({ subtree: true }).map(a => ({ name: a.animationName, target: a.effect.target.className, state: a.playState, time: a.currentTime, frames: a.effect.getKeyframes(), timing: a.effect.getTiming(), reduced: motion.reduced(), pref: document.documentElement.dataset.motion }))), []);
    await page.evaluate(() => motion.setReduced(false));

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(out, viewport + '-light.png'), animations: 'disabled' });
    // Legacy layouts must not reuse the explorer's compact row markup/styles.
    await page.evaluate(() => setGroup("priority")); await page.waitForFunction(() => document.querySelector("#rows").dataset.view === "list");
    assert.equal(await page.locator("#rows .ex-session").count(), 0);
    await page.evaluate(() => setGroup("project")); await page.waitForSelector("#rows .sec.proj");
    await page.evaluate(() => setGroup("folders")); await page.waitForSelector(".ex-tree");
    assert.deepEqual(errors, []); assert.deepEqual(unsafe, []);
    results.push({ viewport, errors, unsafe, checks: 'nested branches, real folder listing, exact terminal cwd, focus-preserving updates, empty-folder search, contextual command, persistence, keyboard, arbitrary paths, remote routing, OS/deck reduced motion, overflow' });
    await page.close();
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ ok: true, port, scratch, results }));
} finally { await browser?.close(); child.kill('SIGTERM'); if (!keep) rmSync(scratch, { recursive: true, force: true }); }
