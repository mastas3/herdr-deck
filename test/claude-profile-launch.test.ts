// A fake socket receives the launch. Never starts a real Claude process or changes a real account.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = mkdtempSync("/tmp/dcml-");
afterAll(() => rmSync(home, { recursive: true, force: true }));
test("selected profile reaches tab.create.env; unavailable profiles create no tab", async () => {
  const profile = join(home, ".claude-max"); mkdirSync(join(profile, "projects"), { recursive: true }); writeFileSync(join(profile, "settings.json"), "{}");
  const script = `
    import { createSessions } from ${JSON.stringify(new URL("../src/http/sessions.ts", import.meta.url).pathname)};
    const calls = [], socket = ${JSON.stringify(join(home, "h.sock"))};
    const server = Bun.listen({ unix: socket, socket: { data(s,d) {
      for (const line of d.toString().trim().split('\\n')) {
        const q=JSON.parse(line); calls.push(q);
        const result = q.method === 'tab.create' ? {root_pane:{pane_id:'p1'}} : q.method === 'pane.read' ? {read:{text:'ready $ '}} : {};
        s.write(JSON.stringify({id:q.id,result})+'\\n');
      }
    } } });
    const deck = { sessions: new Map([['default',{name:'default',socket,online:true}]]), rows:new Map(), kick:async()=>{} };
    let ready; const done = new Promise(r=>ready=r);
    const sessions=createSessions({deck,graves:{list:[]},remotes:new Map(),broadcastGraves:()=>{},notice:n=>{if(n.message==='claude is ready')ready();}});
    let rejected=false;
    try { await sessions.startSession({kind:'claude',cwd:${JSON.stringify(home)},claudeProfile:'/unlisted'}); } catch { rejected=true; }
    if(calls.length) throw new Error('invalid profile opened a tab');
    await sessions.startSession({kind:'claude',cwd:${JSON.stringify(home)},claudeProfile:${JSON.stringify(profile)},model:'haiku'});
    await done;
    console.log(JSON.stringify({rejected,calls})); server.stop(true);`;
  const p = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(p.stdout).text(), err = await new Response(p.stderr).text();
  expect(await p.exited, err).toBe(0);
  const d = JSON.parse(output);
  expect(d.rejected).toBe(true);
  expect(d.calls.find((c: any) => c.method === "tab.create").params.env).toEqual({ CLAUDE_CONFIG_DIR: profile });
  expect(d.calls.find((c: any) => c.method === "agent.start").params.args).toContain("haiku");
}, 10_000);
