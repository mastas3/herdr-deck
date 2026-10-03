import { findClaudeFile } from "./agents";

/** Only a user message written by Claude after this launch acknowledges initial-prompt delivery. */
export async function claudeRecordedPrompt(id: string, prompt: string, since: number): Promise<boolean> {
  const path = findClaudeFile(id);
  if (!path) return false;
  // Startup context can be large. Read a bounded prefix without blocking the event loop.
  const text = await Bun.file(path).slice(0, 4 * 1024 * 1024).text();
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r.type !== "user" || r.isMeta || !(Date.parse(r.timestamp) >= since - 1000)) continue;
      const c = r.message?.content;
      const value = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
      if (value.trim() === prompt.trim()) return true;
    } catch {}
  }
  return false;
}
