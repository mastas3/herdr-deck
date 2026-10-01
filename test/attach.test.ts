import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexUserText } from "../src/agents";

// The attachment helpers live in the browser script (no build step); evaluate just their marked block.
const src = await Bun.file(new URL("../public/js/attach.js", import.meta.url)).text();
const block = src.slice(src.indexOf("/* @pure:attach-begin"), src.indexOf("/* @pure:attach-end */"));
const A = new Function(`${block}; return { withAttachments, splitAttachments, attachKind, attachName, attachSummary, attachCount, attachTakeFrom, attachRestoreTo, attachSize, attachExt, ATTACH_MAX };`)();
const chatSrc = await Bun.file(new URL("../public/js/chat.js", import.meta.url)).text();
const C = new Function(`${chatSrc.slice(chatSrc.indexOf("/* @pure:chat-begin"), chatSrc.indexOf("/* @pure:chat-end */"))}; return { settlePending };`)();

const UP = "/Users/me/.cache/herdr-deck/uploads/2026-10-01";

describe("the message the agent gets", () => {
  test("what you typed, then one [Attached: …] line per file, in the order added", () => {
    expect(A.withAttachments("Look at these", [`${UP}/mg1abc2d-shot.png`, `${UP}/mg1abc2e-report.pdf`]))
      .toBe(`Look at these\n[Attached: ${UP}/mg1abc2d-shot.png]\n[Attached: ${UP}/mg1abc2e-report.pdf]`);
  });
  test("only files: just the lines; no files: just the words (trailing space trimmed, as the box was)", () => {
    expect(A.withAttachments("", ["/tmp/a.txt"])).toBe("[Attached: /tmp/a.txt]");
    expect(A.withAttachments("hi  \n", [])).toBe("hi");
    expect(A.withAttachments("line one\n\nline two", ["/tmp/x y.png"])).toBe("line one\n\nline two\n[Attached: /tmp/x y.png]");
  });
  test("Codex app threads still find the deck's uploads in it (src/http/codex.ts)", () => {
    // Bun reads HOME once, so the check runs in its own process with a scratch HOME (tmp is a symlink on macOS).
    const home = realpathSync(mkdtempSync(join(tmpdir(), "attach-home-")));
    try {
      const dir = join(home, ".cache/herdr-deck/uploads/2026-10-01");
      mkdirSync(dir, { recursive: true });
      for (const f of ["mg1abc2d-shot.png", "mg1abc2e-notes.md", "mg1abc2f-cat photo.jpg"]) writeFileSync(join(dir, f), "x");
      const text = A.withAttachments("Two pictures and a note", ["mg1abc2d-shot.png", "mg1abc2e-notes.md", "mg1abc2f-cat photo.jpg"].map((f) => join(dir, f)));
      const codex = new URL("../src/http/codex.ts", import.meta.url).pathname;
      const run = Bun.spawnSync(["bun", "-e", `const { codexUploadImages } = await import(${JSON.stringify(codex)}); console.log(JSON.stringify(codexUploadImages(process.env.MSG)))`], { env: { ...process.env, HOME: home, MSG: text } });
      expect(JSON.parse(run.stdout.toString()).map((p: string) => p.split("/").pop())).toEqual(["mg1abc2d-shot.png", "mg1abc2f-cat photo.jpg"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("a message's attachment lines in the chat", () => {
  test("come out as files; the words stay without them", () => {
    const m = A.splitAttachments(`Fix this\n[Attached: ${UP}/mg1abc2d-shot.png]\n[Attached: ${UP}/mg1abc2e-app.ts]`);
    expect(m.text).toBe("Fix this");
    expect(m.files).toEqual([
      { path: `${UP}/mg1abc2d-shot.png`, name: "shot.png", kind: "image" },
      { path: `${UP}/mg1abc2e-app.ts`, name: "app.ts", kind: "code" },
    ]);
  });
  test("a message with no lines is untouched; a line inside a sentence stays words", () => {
    expect(A.splitAttachments("plain\n\n  text ")).toEqual({ text: "plain\n\n  text ", files: [] });
    const m = A.splitAttachments("I wrote [Attached: /tmp/a.png] inline");
    expect(m.files).toEqual([]);
    expect(m.text).toBe("I wrote [Attached: /tmp/a.png] inline");
  });
  test("only files: no words; lines between paragraphs leave one blank line", () => {
    expect(A.splitAttachments("[Attached: /tmp/a.pdf]").text).toBe("");
    expect(A.splitAttachments("one\n\n[Attached: /tmp/a.zip]\n\ntwo").text).toBe("one\n\ntwo");
  });
  test("what you sent and what comes back read the same: the send settles on its echo", () => {
    const text = A.withAttachments("see", [`${UP}/mg1abc2d-a.png`]);
    expect(A.splitAttachments(text)).toEqual({ text: "see", files: [{ path: `${UP}/mg1abc2d-a.png`, name: "a.png", kind: "image" }] });
    expect(C.settlePending([{ role: "user", text, at: 1, after: 2 }], [{ i: 3, role: "user", text }])).toEqual([]);
  });
  test("names drop the id only the deck's own uploads carry", () => {
    expect(A.attachName(`${UP}/mg1abc2d-my-file.txt`)).toBe("my-file.txt");
    expect(A.attachName("/Users/me/code/abcdef12-notes.txt")).toBe("abcdef12-notes.txt");
  });
  test("kinds: pictures, PDFs, code, text, archives and anything else", () => {
    expect(["a.PNG", "b.jpeg", "c.webp", "d.pdf", "e.tsx", "f.md", "g.json", "h.tar", "i.heic", "j"].map((n) => A.attachKind(n)))
      .toEqual(["image", "image", "image", "pdf", "code", "text", "text", "archive", "file", "file"]);
    expect(A.attachKind("image.png", "image/png")).toBe("image");
    expect(A.attachKind("blob", "application/pdf")).toBe("pdf");
    expect(A.attachExt("x.tar.gz")).toBe("GZ");
    expect([A.attachSize(900), A.attachSize(4096), A.attachSize(3.5 * 1048576)]).toEqual(["900 B", "4 KB", "3.5 MB"]);
  });
  test("a queued message reads as its words and a file count", () => {
    expect(A.attachSummary(A.withAttachments("Ship  it", ["/tmp/a.png", "/tmp/b.png"]))).toBe("Ship it · 2 files");
    expect(A.attachSummary("[Attached: /tmp/a.png]")).toBe("1 file");
  });
});

describe("each session's attachments, like its draft", () => {
  const item = (id: string, state = "done") => ({ id, state, path: `/tmp/${id}` });
  test("switching sessions leaves each one's files where they are", () => {
    const m = new Map([["s1", [item("a")]], ["s2", [item("b"), item("c", "up")]]]);
    expect(A.attachTakeFrom(m, "s1").map((a: any) => a.id)).toEqual(["a"]);
    expect(m.has("s1")).toBe(false);
    expect(m.get("s2").map((a: any) => a.id)).toEqual(["b", "c"]);
    expect(A.attachCount(m.get("s2"))).toEqual({ up: 1, err: 0 });
  });
  test("a failed send puts its files back first, before any added since, and never twice", () => {
    const m = new Map<string, any[]>(), sent = [item("a"), item("b")];
    m.set("s1", sent);
    expect(A.attachTakeFrom(m, "s1")).toBe(sent);
    m.set("s1", [item("new")]);
    A.attachRestoreTo(m, "s1", sent);
    expect(m.get("s1").map((a: any) => a.id)).toEqual(["a", "b", "new"]);
    A.attachRestoreTo(m, "s1", sent);
    expect(m.get("s1").map((a: any) => a.id)).toEqual(["a", "b", "new"]);
    A.attachRestoreTo(m, "s2", []);
    expect(m.has("s2")).toBe(false);
  });
  test("never more than the limit", () => {
    const m = new Map([["s", Array.from({ length: 19 }, (_, i) => item("n" + i))]]);
    A.attachRestoreTo(m, "s", [item("x"), item("y")]);
    expect(m.get("s").length).toBe(A.ATTACH_MAX);
    expect(A.attachCount([item("a", "err"), item("b", "up"), item("c")])).toEqual({ up: 1, err: 1 });
  });
});

describe("Codex user text", () => {
  test("a picture's <image …> wrapper items aren't words you wrote", () => {
    const content = [
      { type: "input_text", text: "Look\n[Attached: /u/a.png]" },
      { type: "input_text", text: '<image name=[Image #1] path="/u/a.png">' },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "<image name=[Image #2]>" },
      { type: "input_text", text: "</image>" },
    ];
    expect(codexUserText(content)).toBe("Look\n[Attached: /u/a.png]");
    expect(codexUserText([{ type: "input_text", text: "<image> tags are fine in a sentence" }])).toBe("<image> tags are fine in a sentence");
  });
});
