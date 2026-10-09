import type { Detail } from "./transcript";

export type SessionOverview = { purpose?: string; request?: string; outcome?: string; at?: number };

/** Short source excerpts, never a guessed summary or another model call. */
export function overviewText(value?: string, limit = 300): string | undefined {
  if (!value) return;
  const text = value.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^(?:#{1,6}\s*|[-*]\s+)/gm, "").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return;
  if (text.length <= limit) return text;
  const end = text.lastIndexOf(" ", limit);
  return text.slice(0, end > limit / 2 ? end : limit) + "…";
}

export function sessionOverview(d: Pick<Detail, "started" | "turns">): SessionOverview {
  const latest = d.turns.at(-1);
  // The current ask and its reply belong together; an older answer is not the current outcome.
  return { purpose: overviewText(d.started || d.turns[0]?.ask), request: overviewText(latest?.ask), outcome: overviewText(latest?.reply), at: latest?.at };
}
