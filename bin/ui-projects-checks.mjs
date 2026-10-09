import assert from 'node:assert/strict';
import { join } from 'node:path';

// Runs inside the explorer harness's disposable HOME; never uses real conversations.
export async function checkProjectView(page, { scratch, out, phone }) {
  assert.equal(await page.evaluate(() => explorer.view), 'projects');
  await page.evaluate(home => {
    window.__projectTest = { rows: structuredClone([...S.rows]), usage: S.usage, machines: structuredClone(S.summary.machines) };
    S.sel = null; S.board = true;
    const r = S.rows.get('demo:deck'), now = Date.now();
    Object.assign(r, { title: 'Make project navigation effortless', firstPrompt: 'Group active work by project so you can pick up exactly where you left off.', model: 'claude-opus-5-5', effort: 'high', sessionId: 'parent-demo', createdAt: now - 3 * 86400_000, turnStartedAt: now - 12 * 60_000, ctxTokens: 84000, ctxWindow: 200000, transcriptBytes: 3 * 1024 ** 2, rssKB: 250 * 1024, procs: 3, subagents: [{ id: 'native-demo', type: 'Explore', description: 'Map the session metadata', model: 'claude-sonnet-5-5', running: true, tools: 8, now: 'Read: session state' }, { id: 'native-idle', type: 'Review', description: 'Review keyboard navigation', running: false, tools: 4 }], overview: { purpose: 'Group active work by project so you can pick up exactly where you left off.', request: 'Bring native agents and fleet workers into the tree.', at: now - 12 * 60_000 } });
    S.rows.get('demo:src').gitRoot = home + '/Projects/herdr-deck';
    S.rows.set('demo:worker', { ...r, key: 'demo:worker', sessionId: 'worker-demo', project: 'Checks', cwd: home + '/Projects/checks', projectRoot: home + '/Projects/checks', title: 'Verify the phone layout', firstPrompt: 'Check every action on a narrow screen.', overview: null, subagents: [], parent: { key: 'demo:deck', srcName: r.title, brief: 'UI-2' } });
    S.rows.set('demo:empty', { ...r, key: 'demo:empty', empty: true, status: 'empty', cwd: home + '/Downloads', projectRoot: home + '/Downloads', subagents: [], parent: undefined });
    S.usage = { accounts: [{ id: 'fixture', provider: 'claude', name: 'Claude', machines: ['test'], at: now, windows: [{ label: '5h', pct: 23, resets: now + 3600_000 }, { label: 'Week', pct: 61, resets: now + 86400_000 }] }] };
    explorer.open = {}; renderNow();
  }, scratch);
  assert.equal(await page.locator('.ex-project').count(), 3);
  assert.equal(await page.locator('.ex-project > .ex-line').filter({ hasText: 'Downloads' }).count(), 0);
  assert.equal(await page.locator('.ex-project > .ex-line').filter({ hasText: 'Checks' }).count(), 0);
  const project = page.locator(`[data-ex-node=${JSON.stringify('project:' + JSON.stringify(['test', scratch + '/Projects/herdr-deck']))}] > .ex-line`);
  await project.click();
  const row = page.locator('.ex-session[data-key="demo:deck"]');
  await row.waitFor();
  assert.match(await row.innerText(), /Opus 5\.5 · high/); assert.match(await row.innerText(), /42% ctx/);
  assert.match(await row.innerText(), /Group active work/);
  await row.locator('[data-ex-session-action="details"]').click();
  const facts = page.locator('[data-ex-panel="details:demo:deck"]');
  assert.match(await facts.innerText(), /3\.0 MB/); assert.match(await facts.innerText(), /250\.0 MB/);
  assert.match(await facts.innerText(), /23% used/); assert.match(await facts.innerText(), /Shared/);
  assert.equal(await page.evaluate(() => S.sel), null, 'Inspecting facts does not navigate away');
  assert.equal(await page.evaluate(() => {
    const b = document.querySelector('[data-ex-key="demo:deck"][data-ex-session-action="details"]'); b.focus();
    S.rows.get('demo:deck').ctxTokens += 100; renderNow(); return document.activeElement === b && b.isConnected;
  }), true);
  await row.locator('[data-ex-session-action="details"]').click();
  await row.locator('[data-ex-session-action="team"]').click();
  assert.equal(await page.locator('.ex-session[data-key="demo:worker"]').count(), 1);
  assert.equal(await page.locator('.ex-tree [data-ex-native]').count(), 2);
  await page.evaluate(() => { const r = rowOf('demo:deck'); for (let i = 0; i < 10; i++) r.subagents.push({ id: 'older-' + i, description: 'Earlier investigation ' + i, running: false, tools: 2 }); renderNow(); });
  assert.equal(await page.locator('.ex-tree [data-ex-native]').count(), 4, 'Old native agents do not flood the tree');
  await page.getByRole('button', { name: 'Show 8 earlier agents', exact: true }).click();
  assert.equal(await page.locator('.ex-tree [data-ex-native]').count(), 12);
  await page.getByRole('button', { name: 'Show recent agents', exact: true }).click();
  await page.locator('#q').fill('Earlier investigation 9'); await page.waitForFunction(() => explorer.search === 'Earlier investigation 9');
  assert.equal(await page.locator('.ex-tree [data-ex-native="older-9"]').count(), 1, 'Search reaches older native agents');
  assert.equal(await page.locator('.ex-tree [data-ex-native]').count(), 1);
  await page.locator('#q').fill(''); await page.waitForFunction(() => !S.q && !explorer.search);
  await page.evaluate(() => { rowOf('demo:deck').subagents = rowOf('demo:deck').subagents.filter(s => !s.id.startsWith('older-')); renderNow(); });
  await page.locator('.ex-tree [data-ex-native="native-demo"]').focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'demo:deck');

  assert.match(await page.locator('.ex-session[data-key="demo:worker"]').innerText(), /Fleet worker · Checks/);
  await page.locator('.ex-tree [data-ex-native="native-demo"]').click();
  assert.equal(await page.evaluate(() => S.sub), 'native-demo');
  assert.equal(await page.evaluate(() => S.sel), 'demo:deck');
  if (phone) await page.locator('#mBack').click();
  await page.evaluate(() => { S.sel = null; S.sub = null; S.board = true; renderNow(); $('rows').scrollTop = 0; });
  await page.screenshot({ path: join(out, (phone ? 'phone' : 'desktop') + '-projects.png'), animations: 'disabled' });
  await page.locator('#q').fill('Verify the phone');
  await page.waitForFunction(() => explorer.search === 'Verify the phone');
  assert.equal(await page.locator('.ex-session[data-key="demo:worker"]').count(), 1);
  assert.equal(await page.locator('.ex-session[data-key="demo:deck"]').count(), 1, 'Worker search keeps its parent as context');
  await page.locator('#q').fill(''); await page.waitForFunction(() => !S.q && !explorer.search);
  await page.getByRole('button', { name: 'All folders', exact: true }).click();
  assert.equal(await page.evaluate(() => explorer.view), 'folders');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  assert.equal(await project.getAttribute('aria-expanded'), 'true', 'Project expansion is independent of folder expansion');
  assert.equal(await row.locator('[data-ex-session-action="team"]').getAttribute('aria-expanded'), 'true');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await row.locator('[data-ex-session-action="details"]').click();
  assert.deepEqual(await page.evaluate(() => document.querySelector('.ex-tree').getAnimations({ subtree: true }).filter(a => a.playState === 'running').map(a => a.animationName)), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(out, (phone ? 'phone' : 'desktop') + '-project-details.png'), animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  // Restore the base fixtures for the full real-directory and PTY journey that follows.
  await page.evaluate(() => {
    S.rows = new Map(window.__projectTest.rows); S.usage = window.__projectTest.usage; S.summary.machines = window.__projectTest.machines;
    for (const key of Object.keys(exSessionOpen)) delete exSessionOpen[key];
    for (const key of Object.keys(exTeamOpen)) delete exTeamOpen[key];
    S.sel = null; S.sub = null; S.board = true; renderNow();
    delete window.__projectTest;
  });
  await page.reload(); await page.waitForSelector('.ex-tree');
  assert.equal(await page.evaluate(() => explorer.view), 'projects');
  assert.equal(await project.getAttribute('aria-expanded'), 'true', 'Project expansion survives reload');
  await page.getByRole('button', { name: 'All folders', exact: true }).click();
  await page.evaluate(() => { explorer.open = {}; renderNow(); });
}
