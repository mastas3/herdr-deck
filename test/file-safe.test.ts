import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { readFileFor, realSafe, resolveReal, resolveSafe } from "../src/http/files";

// The file viewer (/api/file, /api/file-raw, "open on the Mac") follows symlinks: the real target must pass the same
// rules as the path as written. Everything lives in a scratch folder under the home (the viewer only shows files there).
let base = "", proj = "";
beforeAll(() => {
  mkdirSync(`${homedir()}/.cache`, { recursive: true });
  base = realpathSync(mkdtempSync(`${homedir()}/.cache/deck-file-safe-`));
  proj = `${base}/proj`;
  mkdirSync(`${proj}/src`, { recursive: true });
  mkdirSync(`${base}/keys/.ssh`, { recursive: true });
  mkdirSync(`${base}/other`, { recursive: true });
  writeFileSync(`${base}/keys/.ssh/id_rsa`, "PRIVATE KEY");
  writeFileSync(`${base}/other/.env`, "TOKEN=secret");
  writeFileSync(`${proj}/README.md`, "# hi");
  writeFileSync(`${proj}/src/a.ts`, "export const a = 1;");
  symlinkSync(`${base}/keys/.ssh/id_rsa`, `${proj}/notes.txt`); // a harmless name for a key
  symlinkSync(`${base}/other/.env`, `${proj}/config.txt`); // a .env elsewhere
  symlinkSync("/etc/hosts", `${proj}/hosts.txt`); // out of the home folder
  symlinkSync(`${proj}/src/a.ts`, `${proj}/link-a.ts`); // an ordinary link inside the project
  symlinkSync(`${proj}/src`, `${proj}/code`); // an ordinary link to a folder
  symlinkSync(`${base}/missing`, `${proj}/dangling.txt`);
  for (const n of [".env", ".env.local", ".env.production", ".env.example", ".env.sample", ".env.template"]) writeFileSync(`${proj}/${n}`, "A=1");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("symlinks in a session's folder", () => {
  test("a link to a private key is refused, though its own name looks harmless", async () => {
    expect(resolveSafe(proj, "notes.txt")).toBe(`${proj}/notes.txt`); // the name alone passes
    expect(resolveReal(proj, "notes.txt")).toBeUndefined();
    const r: any = await readFileFor(proj, "notes.txt");
    expect(r.error).toContain("isn’t one the deck will show");
    expect(r.content).toBeUndefined();
  });
  test("a link to a .env somewhere else is refused", async () => {
    expect(resolveReal(proj, "config.txt")).toBeUndefined();
    expect(((await readFileFor(proj, "config.txt")) as any).content).toBeUndefined();
  });
  test("a link out of the home folder is refused", async () => {
    expect(resolveReal(proj, "hosts.txt")).toBeUndefined();
    expect(((await readFileFor(proj, "hosts.txt")) as any).content).toBeUndefined();
  });
  test("ordinary links inside the home folder still work, to a file or a folder", async () => {
    expect(resolveReal(proj, "link-a.ts")).toBe(`${proj}/src/a.ts`);
    const r: any = await readFileFor(proj, "link-a.ts");
    expect([r.path, r.content]).toEqual([`${proj}/link-a.ts`, "export const a = 1;"]); // shown under the name you asked for
    const d: any = await readFileFor(proj, "code");
    expect([d.kind, d.entries]).toEqual(["dir", ["a.ts"]]);
    expect(realSafe(`${proj}/README.md`)).toBe(`${proj}/README.md`);
  });
  test("a dangling link or a missing file says not found", async () => {
    expect(resolveReal(proj, "dangling.txt")).toBeUndefined();
    expect(((await readFileFor(proj, "dangling.txt")) as any).error).toContain("Not found");
    expect(((await readFileFor(proj, "nope.txt")) as any).error).toContain("Not found");
  });
});

describe(".env files", () => {
  test("real ones stay refused; their templates show", async () => {
    for (const n of [".env", ".env.local", ".env.production"]) expect(resolveReal(proj, n)).toBeUndefined();
    for (const n of [".env.example", ".env.sample", ".env.template"]) expect(resolveReal(proj, n)).toBe(`${proj}/${n}`);
    expect(((await readFileFor(proj, ".env.example")) as any).content).toBe("A=1");
    expect(resolveSafe(proj, ".env.example.bak")).toBeUndefined();
    expect(resolveSafe(proj, "sub/.env.local")).toBeUndefined();
  });
});
