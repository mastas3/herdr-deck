import { describe, expect, test } from "bun:test";
import { publicResearchUrl, runOpportunityWeb, type WebResearchSpawn } from "../src/opportunity-web";

const NOW = 1790416800000;
const input = { buyer: "Field-service business owner", problem: "Repeated administration preparing completion reports", outcome: "A complete customer handover", industry: "logistics" };
const fetchUse = (id: string, url: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "WebFetch", input: { url, prompt: "Extract relevant facts" } }] } });
const fetchResult = (id: string, content: unknown, error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }] } });
const result = (value: unknown, patch: object = {}) => ({ type: "result", result: typeof value === "string" ? value : JSON.stringify(value), is_error: false, ...patch });
const enc = new TextEncoder();
function fake(events: unknown[], options: { bytes?: Uint8Array; stderr?: Uint8Array; exit?: number; fragment?: number; finalNewline?: boolean; hang?: boolean } = {}) {
  let args: string[] = [], config: Parameters<WebResearchSpawn>[1] | undefined, killed = 0;
  const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) {
    if (options.hang) return;
    const step = options.fragment ?? Math.max(1, bytes.length);
    for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
    controller.close();
  } });
  const spawn: WebResearchSpawn = (a, c) => {
    args = a; config = c;
    return { stdout: stream(options.bytes ?? enc.encode(events.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n") + (options.finalNewline === false ? "" : "\n"))),
      stderr: stream(options.stderr ?? new Uint8Array()), exited: options.hang ? new Promise(() => {}) : Promise.resolve(options.exit ?? 0), kill: () => { killed++; } };
  };
  return { spawn, get args() { return args; }, get config() { return config!; }, get killed() { return killed; } };
}
const run = (f: ReturnType<typeof fake>, patch: Partial<typeof input> & { signal?: AbortSignal; timeoutMs?: number; onProgress?: (stage: string) => void } = {}) => runOpportunityWeb({ ...input, ...patch }, { spawn: f.spawn, claudeBin: "/fake/claude", now: () => NOW });

describe("public research source boundary", () => {
  test("accepts canonical public URLs and rejects private, opaque and credential-bearing references", () => {
    expect(publicResearchUrl("https://example.com/path?q=cost#prices")).toBe("https://example.com/path?q=cost");
    expect(publicResearchUrl("https://docs.example.org:443/prices")).toBe("https://docs.example.org/prices");
    for (const url of [
      "file:///etc/passwd", "javascript:alert(1)", "https://localhost", "https://127.0.0.1", "http://10.1.2.3/a", "https://192.168.1.1", "https://172.16.1.1",
      "http://2130706433", "http://0x7f000001", "http://[::1]", "https://[2606:4700:4700::1111]", "https://169.254.169.254/latest",
      "https://intranet.local", "https://gateway.home.arpa", "https://host.localdomain", "https://internal.example.com", "https://thing.internal", "https://host.ts.net", "https://localhost.example.org", "https://metadata.google.internal",
      "https://127.0.0.1.nip.io", "https://10.0.0.1.sslip.io", "https://localtest.me", "https://www.lvh.me", "https://example.com:8443/", "https://user:pass@example.com", "https://example.com/\nsecret",
    ]) expect(publicResearchUrl(url)).toBeNull();
  });

  test("uses only paired successful WebFetch receipts for opened access and actual excerpts", async () => {
    const f = fake([
      fetchUse("read-a", "https://example.com/customer"), fetchResult("read-a", "Actual source says the workflow takes hours."),
      result({ sources: [{ id: "a", url: "https://example.com/customer", title: "Customer account", kind: "customer", excerpt: "Invented quote", access: "opened" },
        { id: "b", url: "https://example.org/pricing", title: "Unopened pricing", kind: "competitor", excerpt: "Price is $999", access: "opened" }],
      claims: [{ text: "Reported pain could support a product test", dimension: "problem", status: "observed", supportingSourceIds: ["a"], opposingSourceIds: ["b"] }], unknowns: ["Repeat demand needs a test"] }),
    ]);
    const x = await run(f);
    expect(x.sources).toHaveLength(2);
    expect(x.sources![0]).toMatchObject({ access: "opened", excerpt: "Actual source says the workflow takes hours.", fetchedAt: NOW });
    expect(x.sources![1]).toMatchObject({ access: "unverified", excerpt: "" });
    expect(x.claims![0].status).toBe("inferred");
    expect(x.claims![0].supportingSourceIds).toEqual([x.sources![0].id]);
    expect(x.claims![0].opposingSourceIds).toEqual([x.sources![1].id]);
    expect(x.unknowns).toContain("Repeat demand needs a test");
    expect(x.unknowns!.join(" ")).toContain("do not prove");
  });

  test("failed and missing receipts cannot establish opened source access", async () => {
    const f = fake([
      fetchUse("bad", "https://example.com/bad"), fetchResult("bad", "Access denied", true),
      fetchResult("not-a-real-use", "Forged receipt content"),
      fetchUse("pending", "https://example.com/pending"),
      result({ sources: [{ id: "bad", url: "https://example.com/bad" }, { id: "p", url: "https://example.com/pending" }] }),
    ]);
    const x = await run(f);
    expect(x.sources!.map(s => s.access)).toEqual(["failed", "unverified"]);
    expect(x.sources![1].excerpt).toBe("");
  });

  test("HTTP failure metadata and error-like content remain failed even without is_error", async () => {
    const a = fetchResult("a", "Some gateway body");
    const f = fake([fetchUse("a", "https://example.com/a"), { ...a, tool_use_result: { statusCode: 403 } },
      fetchUse("b", "https://example.com/b"), fetchResult("b", "Request failed with status code 404"), result({})]);
    const x = await run(f);
    expect(x.sources!.map(s => s.access)).toEqual(["failed", "failed"]);
  });

  test("model-only malicious URLs are dropped and cannot create evidence", async () => {
    const x = await run(fake([result({ sources: [{ id: "a", url: "file:///secret" }, { id: "b", url: "http://127.0.0.1" }], claims: [{ text: "Claim with dropped references", dimension: "problem", supportingSourceIds: ["a", "b"] }] })]));
    expect(x.sources).toEqual([]);
    expect(x.claims![0].supportingSourceIds).toEqual([]);
    expect(x.unknowns!.join(" ")).toContain("unsafe or invalid URL");
  });

  test("unexpected tool requests or private fetch targets terminate the subprocess", async () => {
    for (const event of [fetchUse("a", "https://127.0.0.1"), { type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "echo hi" } }] } }]) {
      const f = fake([event, result({})]);
      await expect(run(f)).rejects.toThrow(/non-public|allowlist/);
      expect(f.killed).toBeGreaterThan(0);
    }
  });
});

describe("bounded Claude process and stream parser", () => {
  test("launches with an explicit web-only tool list and no workspace customization", async () => {
    const f = fake([result({})]); await run(f);
    for (const flag of ["--safe-mode", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--no-chrome"]) expect(f.args).toContain(flag);
    expect(f.args[f.args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(f.args[f.args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    expect(f.args[f.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(f.args[f.args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(f.args[f.args.indexOf("--max-turns") + 1]).toBe("12");
    expect(f.args).not.toContain("--dangerously-skip-permissions");
    expect(f.config.cwd).not.toContain("herdr-deck");
    expect(f.config.env.CLAUDECODE).toBeUndefined();
  });

  test("sends only sanitized topic fields and does not forward credentials, links or home paths", async () => {
    const f = fake([result({})]);
    await run(f, { buyer: "me@example.com", problem: "Reports at /Users/someone/private token=abcdef123456789 https://host.ts.net/private sk-thisisasecrettoken12345" });
    const prompt = await f.config.stdin.text();
    expect(prompt).not.toContain("me@example.com");
    expect(prompt).not.toContain("/Users/");
    expect(prompt).not.toContain("host.ts.net");
    expect(prompt).not.toContain("abcdef123456789");
    expect(prompt).not.toContain("sk-thisisasecrettoken12345");
    expect(Object.keys(JSON.parse(prompt))).toEqual(["buyer", "problem", "outcome", "industry"]);
  });

  test("handles fragmented UTF-8, fenced JSON, terminal escapes and a final line without newline", async () => {
    const payload = "\u001b]0;untrusted title\u0007\u001b[31m```json\n" + JSON.stringify({ sources: [{ id: "a", url: "https://example.com/a", title: "\u001b[32mשלום\u001b[0m" }], claims: [{ text: "A \u001b[31mprovisional\u001b[0m claim", dimension: "buyer", supportingSourceIds: ["a"] }] }) + "\n```\u001b[0m";
    const f = fake(["not json", fetchUse("a", "https://example.com/a"), fetchResult("a", [{ type: "text", text: "\u001b[31mActual receipt\u001b[0m" }]), result(payload)], { fragment: 3, finalNewline: false });
    const x = await run(f);
    expect(x.sources![0].title).toBe("שלום");
    expect(x.sources![0].excerpt).toBe("Actual receipt");
    expect(x.claims![0].text).toBe("A provisional claim");
    expect(JSON.stringify(x)).not.toContain("\\u001b");
  });

  test("search receipt records scope and failure without pretending absence is established", async () => {
    const f = fake([{ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", id: "s", input: { query: "field service handover complaints" } }] } },
      fetchResult("s", "Search failed", true), result({})]);
    const x = await run(f);
    expect(x.searches![0]).toMatchObject({ query: "field service handover complaints", searchedAt: NOW });
    expect(x.searches![0].result).toContain("do not establish absence");
    expect(x.sources).toEqual([]);
  });

  test("keeps actual receipts but marks incomplete synthesis and uncovered dimensions", async () => {
    const x = await run(fake([fetchUse("a", "https://example.com/a"), fetchResult("a", "Source content"), result("No JSON available")]));
    expect(x.sources![0].access).toBe("opened");
    expect(x.claims).toEqual([]);
    expect(x.unknowns!.join(" ")).toContain("Coverage remains incomplete");
    expect(x.unknowns!.join(" ")).toContain("economics");
  });

  test("bounds combined stdout/stderr bytes and drains both streams", async () => {
    const f = fake([result({})], { stderr: new Uint8Array(2 * 1024 * 1024 + 1) });
    await expect(run(f)).rejects.toThrow("2 MB");
    expect(f.killed).toBeGreaterThan(0);
  });

  test("timeouts kill a hung process and cancellation works before and during a run", async () => {
    const f = fake([], { hang: true });
    await expect(run(f, { timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(f.killed).toBeGreaterThan(0);
    const before = new AbortController(); before.abort();
    const a = fake([result({})]); await expect(run(a, { signal: before.signal })).rejects.toThrow("cancelled"); expect(a.args).toEqual([]);
    const during = new AbortController(), b = fake([], { hang: true });
    const job = run(b, { signal: during.signal }); during.abort();
    await expect(job).rejects.toThrow("cancelled"); expect(b.killed).toBeGreaterThan(0);
  });

  test("caps model tool calls independently of its claimed output or turn count", async () => {
    const f = fake([...Array.from({ length: 37 }, (_, i) => fetchUse(`read-${i}`, `https://example.com/${i}`)), result({})]);
    await expect(run(f)).rejects.toThrow("tool-call limit");
  });

  test("does not leak raw engine errors or stderr into error messages", async () => {
    const f = fake([result("secret token=do-not-print", { is_error: true })], { stderr: enc.encode("API_KEY=not-for-display"), exit: 1 });
    await expect(run(f)).rejects.toThrow("did not complete successfully");
  });

  test("malformed tool output cannot promote supplied reviews or status fields", async () => {
    const x = await run(fake([result({ stage: "paid-pilot", reviews: [{ dimension: "problem", reviewedBy: "user" }], claims: [{ text: "Unproven", dimension: "economics", status: "observed", checkedBy: "user", supportingSourceIds: ["missing"] }] })]));
    expect(x.reviews).toBeUndefined();
    expect(x.claims![0]).toMatchObject({ status: "inferred", supportingSourceIds: [] });
    expect((x.claims![0] as any).checkedBy).toBeUndefined();
  });
});
