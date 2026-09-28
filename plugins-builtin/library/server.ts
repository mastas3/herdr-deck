// The library plugin: the Founder Library (library.ts and its pieces, the Python bridge beside them), its API at
// /api/library/*, the deck_library MCP tool, and the `library` service everything else reads evidence and comparable
// founders through. Its data stays in ~/.config/herdr-deck/library (DECK_LIBRARY_DIR moves it). DECK_NO_LIBRARY=1
// keeps the worker and the date backfill from resuming on start, as before; switching the plugin off stops both, asks
// the bridge to exit and closes the cards database.
import type { Host } from "../../src/plugin-api";
import type { Card } from "../../src/library-card";
import { comparablesFor, type Comparables, type Target } from "../../src/library-strategy";
import { createLibrary, type Library } from "./library";

/** What `use("library")` returns: the library itself, plus comparable founders for a plan from its cards. */
export type LibraryService = Library & { comparables(t: Target, k?: number): Comparables | undefined };

/** The MCP tool research agents call (src/mcp.ts lists it while the plugin is on). */
export const libraryTool = (lib: Pick<Library, "evidence">) => ({
  name: "deck_library",
  description: "The Founder Library: how real builders built and got customers, from YouTube interviews (Starter Story, My First Million, Y Combinator and more) the user collected. Ask a question (\"how did people get first customers for a Telegram bot?\", \"pricing for a B2B Chrome extension\"); get founder cards (claimed revenue, price, first-customer tactics, lessons) and transcript quotes, each with a YouTube timestamp link. Use it for idea research and pre-mortems; cite the links; numbers are the founders' claims.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", description: "How many videos (default 5, max 8)" } }, required: ["query"] },
  call: async (a: any) => (await lib.evidence(String(a?.query ?? ""), Math.min(Number(a?.limit) || 5, 8), "research")).text || "The Founder Library has nothing on that yet.",
});

export function activate(host: Host) {
  const lib = createLibrary();
  // Comparables read every card; a minute-old copy is plenty for matching plans.
  let memo: { at: number; cards: Card[] } | undefined;
  const cards = () => {
    if (!memo || Date.now() - memo.at > 60_000) { try { memo = { at: Date.now(), cards: lib.cards().all() }; } catch { memo = { at: Date.now(), cards: [] }; } }
    return memo.cards;
  };
  host.provide<LibraryService>("library", { ...lib, comparables: (t, k) => comparablesFor(t, { k, cards: cards() }) });
  host.routes("library", ({ path, body }) => (path.startsWith("/api/library/") ? lib.handle(path, body) : undefined));
  host.extend("mcp.tools", libraryTool(lib));
  if (!host.env("DECK_NO_LIBRARY")) lib.autostart({ after: host.after, every: host.every });
  host.onStop(() => lib.stop());
}
