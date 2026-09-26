import { describe, expect, test } from "bun:test";
import { slashCommands } from "../src/slash";
import { inventoryText, type Inventory } from "../src/connections";

describe("slash commands", () => {
  test("codex has /rename and /compact", async () => {
    const l = await slashCommands("codex", "/tmp");
    expect(l.find((c) => c.cmd === "/rename")?.hint).toBe("[name]");
    expect(l.some((c) => c.cmd === "/compact")).toBe(true);
  });
  test("opencode has built-ins and no duplicates", async () => {
    const l = await slashCommands("opencode", "/tmp");
    expect(l.some((c) => c.cmd === "/compact")).toBe(true);
    expect(new Set(l.map((c) => c.cmd)).size).toBe(l.length);
  });
  test("descriptions have no markdown noise", async () => {
    const l = await slashCommands("claude", "/tmp");
    for (const c of l) expect(c.desc ?? "").not.toMatch(/\*\*/);
  });
  test("unknown agents get nothing", async () => {
    expect(await slashCommands("shell", "/tmp")).toEqual([]);
  });
});

describe("connections text", () => {
  const inv: Inventory = {
    machine: "test", at: 0, ms: 0,
    sections: [
      { id: "services", title: "Services", hint: "", items: [
        { id: "svc:netlify", name: "Netlify", kind: "service", status: "ready", detail: "Deploys", via: ["npx netlify-cli 27.7.0"], use: "npx netlify-cli deploy" },
        { id: "svc:vercel", name: "Vercel", kind: "service", status: "ready", hidden: true },
        { id: "svc:supabase", name: "Supabase", kind: "service", status: "partial", detail: "Postgres" },
      ] },
      { id: "keys", title: "API keys", hint: "", items: [{ id: "key:x", name: "OPENAI_API_KEY", kind: "key", detail: "set in ~/.zshrc", note: "" }] },
      { id: "missing", title: "Not set up", hint: "", items: [{ id: "svc:aws", name: "AWS", kind: "service", status: "off" }] },
    ],
  };
  test("full text skips hidden and missing, flags sign-in", () => {
    const t = inventoryText(inv);
    expect(t).toContain("**Netlify**");
    expect(t).toContain("How: npx netlify-cli deploy");
    expect(t).not.toContain("Vercel");
    expect(t).not.toContain("AWS");
    expect(t).toContain("Supabase** (needs sign-in)");
    expect(t).toContain("OPENAI_API_KEY");
  });
  test("a selection only includes the picked items", () => {
    const t = inventoryText(inv, new Set(["svc:supabase"]));
    expect(t).toContain("Supabase");
    expect(t).not.toContain("Netlify");
    expect(t).not.toContain("OPENAI_API_KEY");
  });
});
