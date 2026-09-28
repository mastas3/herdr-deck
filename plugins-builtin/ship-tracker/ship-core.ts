// Ship tracker, the pure part: a wiki project page read into { status, path }, each project's "last shipped" (its
// newest release tag, or the page saying launched), and who is busy without shipping. The weekly digest line.
import { frontmatter } from "../../src/text";

export type Page = { slug: string; name: string; status: string; updated?: string; path?: string };
export type Facts = { lastCommit?: number; commits14?: number; tag?: string; tagAt?: number; sessions14?: number; live?: number };
export type ShipRow = Page & Facts & { lastShipped?: number; shippedBy?: "tag" | "launched"; daysSince?: number; busy: boolean };

const DAY = 86400_000;

/** One ~/wiki/projects/<slug>.md: its status frontmatter and the "**Path:** `~/…`" line most pages carry. */
export function parsePage(slug: string, text: string): Page {
  const { data, body } = frontmatter(text);
  const path = body.match(/\*\*(?:Local )?[Pp]ath:?\*\*:?\s*`([^`]+)`/)?.[1] ?? body.match(/^[-*]\s*(?:Local )?[Pp]ath:\s*`([^`]+)`/m)?.[1];
  const title = String(data.title ?? "").trim();
  return { slug, name: title || slug, status: String(data.status ?? "unknown").toLowerCase(), updated: data.date_updated ? String(data.date_updated) : undefined, path: path?.replace(/\/+$/, "") };
}

/** Started vs shipped. Busy = at least `busyAt` agent sessions in 14 days and nothing shipped in `staleDays`. */
export function shipRows(pages: (Page & Facts)[], now: number, o: { busyAt?: number; staleDays?: number } = {}): ShipRow[] {
  const busyAt = o.busyAt ?? 5, staleDays = o.staleDays ?? 30;
  const rows = pages.map((p) => {
    const launched = p.status === "launched" && p.updated ? Date.parse(p.updated) : undefined;
    const tag = p.tagAt;
    const lastShipped = Math.max(tag ?? 0, launched && Number.isFinite(launched) ? launched : 0) || undefined;
    const shippedBy: ShipRow["shippedBy"] = lastShipped ? (lastShipped === tag ? "tag" : "launched") : undefined;
    const daysSince = lastShipped ? Math.max(0, Math.floor((now - lastShipped) / DAY)) : undefined;
    const busy = (p.sessions14 ?? 0) >= busyAt && (daysSince === undefined || daysSince > staleDays);
    return { ...p, lastShipped, shippedBy, daysSince, busy };
  });
  // Busy-but-unshipped first, then the longest since shipping (never shipped counts as longest), then most recent work.
  return rows.sort((a, b) => Number(b.busy) - Number(a.busy) || (b.daysSince ?? 1e9) - (a.daysSince ?? 1e9) || (b.sessions14 ?? 0) - (a.sessions14 ?? 0) || (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
}

/** One line for the week: what shipped in the last 7 days, and the busiest projects that didn't. */
export function weeklyLine(rows: ShipRow[], now: number): string {
  const shipped = rows.filter((r) => r.lastShipped && now - r.lastShipped < 7 * DAY);
  const busy = rows.filter((r) => r.busy).sort((a, b) => (b.sessions14 ?? 0) - (a.sessions14 ?? 0)).slice(0, 3);
  const s = shipped.length ? `Shipped this week: ${shipped.map((r) => r.name).join(", ")}.` : "Nothing shipped this week.";
  const b = busy.length ? ` Busy but not shipping: ${busy.map((r) => `${r.name} (${r.sessions14} sessions, ${r.daysSince === undefined ? "never shipped" : `${r.daysSince} days since`})`).join(", ")}.` : "";
  return s + b;
}
