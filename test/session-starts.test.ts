import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStartStore, showStart } from "../src/session-starts";
import { createForward } from "../src/http/forward";
const root = mkdtempSync("/tmp/deck-starts-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("first prompt is durable before launch, retry IDs coalesce and changed payloads are rejected", () => {
  const file = join(root, "receipts.json"), store = createStartStore(file); store.load();
  const body = { requestId: "same", kind: "claude", cwd: root, prompt: "A unique first message", worktree: { branch: "codex/test", install: false } };
  const a = store.begin(body);
  expect(a.fresh).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(store.begin({ ...body, worktree: { install: false, branch: "codex/test" } }).fresh).toBe(false);
  expect(() => store.begin({ ...body, prompt: "different" })).toThrow("different session options");
  const reload = createStartStore(file); reload.load();
  expect(reload.get("same")?.body.prompt).toBe(body.prompt);
  expect(reload.get("same")?.state).toBe("unknown");
  expect(reload.begin(body).fresh).toBe(false);
});
test("restart during delivery never replays it; failed and dismissed messages remain recoverable", () => {
  const file = join(root, "uncertain.json"), store = createStartStore(file); store.load();
  store.begin({ requestId: "sending", kind: "claude", prompt: "Keep me" });
  store.update("sending", { state: "sending", key: "default/w1:p1", sessionId: "original" });
  const reload = createStartStore(file); reload.load();
  expect(reload.get("sending")?.state).toBe("unknown");
  expect(reload.forRow({ key: "default/w1:p1", sessionId: "replacement" })).toBeUndefined();
  const row: any = { key: "default/w1:p1", sessionId: "original", title: "MCP helper process", empty: true, stale: true };
  expect(showStart(row, reload.forRow(row))).toMatchObject({ empty: false, stale: false, title: "Keep me", startup: { state: "unknown" } });
  reload.update("sending", { state: "dismissed" });
  expect(reload.list()).toHaveLength(0);
  expect(reload.get("sending")?.body.prompt).toBe("Keep me");
});
test("a corrupt receipt file blocks new side effects without overwriting the file", () => {
  const file = join(root, "corrupt.json"); writeFileSync(file, "broken");
  const store = createStartStore(file); store.load();
  expect(() => store.begin({ prompt: "save" })).toThrow("Cannot read saved starts");
});
test("remote start receipts retain their machine and unknown machines cannot launch locally", async () => {
  const remote: any = { conf: { id: "linux" }, post: async (path: string) => ({ status: 200, data: path === "/api/new-options" ? { starts: [{ id: "one", key: "default/w1:p1" }] } : { key: "default/w1:p1" } }) };
  const forward = createForward({ remotes: new Map([["linux", remote]]), selfId: "mac", briefKey: () => "", closeLocal: async () => [] });
  expect((await (await forward("/api/new-options", { machine: "linux" }))!.json()).starts[0].key).toBe("linux|default/w1:p1");
  expect((await (await forward("/api/start", { machine: "linux", id: "one" }))!.json()).key).toBe("linux|default/w1:p1");
  expect((await forward("/api/new", { machine: "removed" }))?.status).toBe(400);
});
test("a false named-agent launch failure cannot lose or double-send Claude's positional first prompt", async () => {
  const home = join(root, "home");
  const script = `
    import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    import {createSessions} from ${JSON.stringify(new URL("../src/http/sessions.ts", import.meta.url).pathname)};
    import {createStartStore} from ${JSON.stringify(new URL("../src/session-starts.ts", import.meta.url).pathname)};
    const home=${JSON.stringify(home)}, file=home+'/starts.json', path=home+'/.claude/projects/project/session-id.jsonl';
    mkdirSync(home+'/.claude/projects/project',{recursive:true});
    const starts=createStartStore(file);starts.load();
    const calls=[], socket=home+'/h.sock', prompt='A first message with quotes " and $(literal)';
    const server=Bun.listen({unix:socket,socket:{data(s,d){for(const line of d.toString().trim().split('\\n')){
      const q=JSON.parse(line);calls.push(q);
      if(q.method==='tab.create' && JSON.parse(readFileSync(file,'utf8'))[0].body.prompt!==prompt)throw Error('not saved before creating tab');
      if(q.method==='agent.start'){
        writeFileSync(path,JSON.stringify({type:'user',timestamp:new Date().toISOString(),message:{content:prompt}})+'\\n');
        s.write(JSON.stringify({id:q.id,error:{code:'agent_not_ready',message:'not an active named agent'}})+'\\n');continue;
      }
      const result=q.method==='tab.create'?{root_pane:{pane_id:'p1'}}:q.method==='pane.read'?{read:{text:'ready $'}}:q.method==='agent.get'?{agent:{agent:'claude',agent_session:{agent:'claude',value:'session-id'}}}:{};
      s.write(JSON.stringify({id:q.id,result})+'\\n');
    }}}});
    const deck={sessions:new Map([['default',{name:'default',socket,online:true}]]),rows:new Map(),kick:async()=>{},refresh:()=>{}};
    let done; const ready=new Promise(r=>done=r);
    const sessions=createSessions({deck,starts,graves:{list:[]},remotes:new Map(),broadcastGraves:()=>{},notice:n=>{if(n.message==='claude is running and has your first message')done();}});
    const body={kind:'claude',cwd:home,prompt,requestId:'one',model:'haiku'};
    const results=await Promise.all([sessions.startSession(body),sessions.startSession(body)]);
    await ready;
    const replay=await sessions.startSession(body);
    console.log(JSON.stringify({calls,results,replay,state:starts.get('one').state,prompt}));server.stop(true);
  `;
  const p = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(p.stdout).text(), err = await new Response(p.stderr).text();
  expect(await p.exited, err).toBe(0);
  const d = JSON.parse(output);
  expect(d.calls.filter((c: any) => c.method === "tab.create")).toHaveLength(1);
  expect(d.calls.filter((c: any) => c.method === "agent.start")).toHaveLength(1);
  expect(d.calls.find((c: any) => c.method === "agent.start").params.args.slice(-2)).toEqual(["--", d.prompt]);
  expect(d.calls.some((c: any) => ["agent.prompt", "pane.send_input"].includes(c.method))).toBe(false);
  expect(d.results[0].key).toBe(d.results[1].key);
  expect(d.replay.key).toBe(d.results[0].key);
  expect(d.state).toBe("ready");
}, 10_000);
