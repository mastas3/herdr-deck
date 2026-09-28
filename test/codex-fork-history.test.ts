import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexForkHistory } from "../src/codex-fork-history";
import { codexDetail, codexImage } from "../src/transcript";

const a = "00000000-0000-0000-0000-000000000001", b = "00000000-0000-0000-0000-000000000002", c = "00000000-0000-0000-0000-000000000003";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const line = (type: string, payload: any, timestamp = "2026-09-28T11:00:00Z") => JSON.stringify({ timestamp, type, payload }) + "\n";
const meta = (id: string, history_base?: any, forked_from_id?: string) => line("session_meta", { id, timestamp: "2026-09-28T11:00:00Z", ...(history_base ? { history_mode: "paginated", history_base, forked_from_id: forked_from_id ?? history_base.thread_id } : {}) });
const turn = (id: string, text: string, image = false) => line("event_msg", { type: "task_started", turn_id: id }) +
  line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `ask ${text}` }, ...(image ? [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] : [])] }) +
  line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] }) +
  line("event_msg", { type: "task_complete", turn_id: id });
const base = (id: string, data: string) => ({ thread_id: id, end_byte_offset: Buffer.byteLength(data), end_ordinal_exclusive: data.split("\n").length - 1 });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codex-fork-history-")); roots.push(dir);
  const paths = new Map<string, string>();
  const reader = createCodexForkHistory((id) => paths.get(id));
  const save = (id: string, text: string) => { const path = join(dir, `${id}.jsonl`); writeFileSync(path, text); paths.set(id, path); return path; };
  return { dir, paths, reader, save };
}

describe("Codex paginated fork history", () => {
  test("hydrates only the exact selected prefix and appends child history incrementally", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    const parent = f.save(a, prefix + turn("second", "SECOND")), child = f.save(b, meta(b, base(a, prefix)));
    const first = await codexDetail(child, f.reader);
    expect(first.messages.map((m) => m.text)).toEqual(["ask FIRST", "FIRST"]);
    expect(first.messages[1]).toMatchObject({ forkAfterTurnId: "first", codexSourceId: a });
    appendFileSync(parent, turn("third", "THIRD"));
    const unchanged = await codexDetail(child, f.reader);
    expect(unchanged).toBe(first);
    appendFileSync(child, turn("child", "CHILD"));
    const appended = await codexDetail(child, f.reader);
    expect(appended).toBe(first);
    expect(appended.messages.map((m) => m.text)).toEqual(["ask FIRST", "FIRST", "ask CHILD", "CHILD"]);
    expect(appended.messages[3].codexSourceId).toBeUndefined();
    expect((await f.reader.resolve(child)).segments[0].lastAt).toBe(Date.parse("2026-09-28T11:00:00Z"));
  });

  test("nested native flattening permits a different immediate fork source", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    f.save(a, prefix + turn("later", "LATER")); f.save(b, meta(b, base(a, prefix)));
    const child = f.save(c, meta(c, base(a, prefix), b));
    const detail = await codexDetail(child, f.reader);
    expect(detail.messages.map((m) => m.text)).toEqual(["ask FIRST", "FIRST"]);
    expect((await f.reader.resolve(child)).segments.map((s) => s.threadId)).toEqual([a]);
  });

  test("recursive base segments replay into independent child state", async () => {
    const f = fixture(), first = meta(a) + turn("first", "FIRST");
    const middle = meta(b, base(a, first)) + turn("middle", "MIDDLE");
    f.save(a, first); f.save(b, middle + turn("excluded", "EXCLUDED"));
    const target = base(b, middle);
    target.end_ordinal_exclusive += base(a, first).end_ordinal_exclusive;
    const child = f.save(c, meta(c, target));
    const detail = await codexDetail(child, f.reader);
    expect(detail.messages.map((m) => m.text)).toEqual(["ask FIRST", "FIRST", "ask MIDDLE", "MIDDLE"]);
    const segments = (await f.reader.resolve(child)).segments;
    expect(segments[1].ordinalEnd).toBe(segments[0].ordinalEnd + segments[1].recordCount);
    f.save(c, meta(c, base(b, middle)));
    expect((await f.reader.resolve(child)).warning).toBeDefined();
    f.save(c, meta(c, target));
    const separate = await codexDetail(f.paths.get(a)!, f.reader); separate.messages[0].text = "MUTATED CACHE";
    expect(detail.messages[0].text).toBe("ask FIRST");
  });

  test("resolves an archived parent through the index and preserves the child parse", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    const parent = f.save(a, prefix), child = f.save(b, meta(b, base(a, prefix)));
    const before = await codexDetail(child, f.reader);
    const archived = join(f.dir, "archived-parent.jsonl"); renameSync(parent, archived); f.paths.set(a, archived);
    const after = await codexDetail(child, f.reader);
    expect(after).toBe(before); expect(after.messages.length).toBe(2);
  });

  test("missing parents show an honest note and recover when the index catches up", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    const parent = f.save(a, prefix), child = f.save(b, meta(b, base(a, prefix)));
    f.paths.delete(a);
    const missing = await codexDetail(child, f.reader);
    expect(missing.messages[0]).toMatchObject({ role: "note" });
    expect(missing.messages[0].text).toContain("Open the task in Codex");
    f.paths.set(a, parent);
    const recovered = await codexDetail(child, f.reader);
    expect(recovered.gen).not.toBe(missing.gen); expect(recovered.messages[1].text).toBe("FIRST");
    renameSync(parent, parent + ".moved");
    expect((await codexDetail(child, f.reader)).messages[0].role).toBe("note");
  });

  test("changed or replaced parent content never silently changes an already inherited prefix", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    const parent = f.save(a, prefix), child = f.save(b, meta(b, base(a, prefix)));
    await codexDetail(child, f.reader);
    writeFileSync(parent, prefix.replaceAll("FIRST", "OTHER"));
    const changed = await codexDetail(child, f.reader);
    expect(changed.messages[0].role).toBe("note"); expect(changed.messages.some((m) => m.text === "OTHER")).toBe(false);
    writeFileSync(parent, prefix); expect((await codexDetail(child, f.reader)).messages[1].text).toBe("FIRST");
    writeFileSync(parent, meta(c) + turn("first", "FIRST"));
    expect((await f.reader.resolve(child)).warning).toBeDefined();
  });

  test("invalid bounds, incorrect ordinal, identity mismatch, and cycles fail closed", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST"); f.save(a, prefix);
    for (const patch of [{ end_byte_offset: Buffer.byteLength(prefix) - 1 }, { end_byte_offset: Buffer.byteLength(prefix) + 1 }, { end_ordinal_exclusive: 2 }, { end_byte_offset: -1 }, { end_ordinal_exclusive: 1.5 }, { thread_id: "../../arbitrary" }]) {
      const child = f.save(b, meta(b, { ...base(a, prefix), ...patch }));
      expect((await f.reader.resolve(child)).warning).toBeDefined();
    }
    const cycle = meta(a, { thread_id: b, end_byte_offset: 1000, end_ordinal_exclusive: 2 }); f.save(a, cycle);
    const child = f.save(b, meta(b, base(a, cycle)));
    expect((await f.reader.resolve(child)).warning).toBeDefined();
  });

  test("inherited inline images resolve only within the validated ancestor prefix", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST", true);
    const parent = f.save(a, prefix + turn("later", "LATER", true)), child = f.save(b, meta(b, base(a, prefix)));
    const detail = await codexDetail(child, f.reader), imageId = detail.images[0].id;
    expect(imageId.startsWith(`b:${a}:x:`)).toBe(true);
    expect(Buffer.from((await codexImage(child, imageId, f.reader))!.data).toString()).toBe("hello");
    expect(await codexImage(child, imageId.replace(a, c), f.reader)).toBeUndefined();
    expect(await codexImage(child, `b:${a}:x:${Buffer.byteLength(prefix)}:1`, f.reader)).toBeUndefined();
    expect(await codexImage(child, `b:${a}:x:2:1`, f.reader)).toBeUndefined();
    const archived = parent + ".archived"; renameSync(parent, archived); f.paths.set(a, archived);
    expect(Buffer.from((await codexImage(child, imageId, f.reader))!.data).toString()).toBe("hello");
  });

  test("logical ordinal may exceed the immediate file's physical byte length", async () => {
    const f = fixture(), first = meta(a) + "{}\n".repeat(1000);
    f.save(a, first);
    const middle = meta(b, base(a, first)) + line("event_msg", { type: "other" });
    f.save(b, middle);
    const selected = base(b, middle); selected.end_ordinal_exclusive += base(a, first).end_ordinal_exclusive;
    expect(selected.end_ordinal_exclusive).toBeGreaterThan(selected.end_byte_offset);
    const child = f.save(c, meta(c, selected)), plan = await f.reader.resolve(child);
    expect(plan.warning).toBeUndefined();
    expect(plan.segments[1]).toMatchObject({ ordinalEnd: 1003, recordCount: 2 });
  });

  test("partial replay is discarded if the validated parent changes before replay", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "FIRST");
    const parent = f.save(a, prefix), child = f.save(b, meta(b, base(a, prefix)) + turn("own", "OWN"));
    const racingReader = { ...f.reader, replay: async (...args: Parameters<typeof f.reader.replay>) => {
      if (args[0].segments.length) writeFileSync(parent, prefix.replaceAll("FIRST", "OTHER"));
      return f.reader.replay(...args);
    } };
    const detail = await codexDetail(child, racingReader);
    expect(detail.messages.map((m) => m.role)).toEqual(["note", "user", "assistant"]);
    expect(detail.messages.slice(1).map((m) => m.text)).toEqual(["ask OWN", "OWN"]);
    expect(detail.messages.some((m) => m.codexSourceId)).toBe(false);
  });

  test("timestamp cutoffs accept numeric Codex timestamps and reject non-JSON prefixes", async () => {
    const f = fixture(), prefix = meta(a) + line("event_msg", { type: "other" }, 1_900_000_000 as any);
    f.save(a, prefix); const child = f.save(b, meta(b, base(a, prefix)));
    expect((await f.reader.resolve(child)).segments[0].lastAt).toBe(1_900_000_000_000);
    const bad = meta(a) + "not json\n"; f.save(a, bad); f.save(b, meta(b, base(a, bad)));
    expect((await f.reader.resolve(child)).warning).toBeDefined();
  });

  test("large records crossing read chunks preserve byte offsets and non-ASCII text", async () => {
    const f = fixture(), prefix = meta(a) + turn("first", "א".repeat(600_000), true);
    f.save(a, prefix); const child = f.save(b, meta(b, base(a, prefix)));
    const plan = await f.reader.resolve(child); expect(plan.warning).toBeUndefined();
    const detail = await codexDetail(child, f.reader);
    expect(detail.messages[1].forkAfterTurnId).toBe("first");
    expect(Buffer.from((await codexImage(child, detail.images[0].id, f.reader))!.data).toString()).toBe("hello");
  });
});
