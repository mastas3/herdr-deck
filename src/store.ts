// The Connections store: categories, states and the enrichment the hub applies to every machine's
// inventory (its own, and older nodes' that predate categories), so the page gets one shape everywhere.
import type { Inventory, Item } from "./connections";

export const CATEGORIES = [
  { id: "ai", label: "AI models & agents", hint: "Coding agents, model APIs, local models and the apps around them" },
  { id: "code", label: "Code & Git", hint: "Version control, issue trackers, editors and everyday dev tools" },
  { id: "cloud", label: "Cloud & deploy", hint: "Where things get hosted, deployed and stored" },
  { id: "data", label: "Data & databases", hint: "Databases and caches, local and hosted" },
  { id: "comms", label: "Communication", hint: "Mail, messages, calendars and chat bots" },
  { id: "media", label: "Media & creative", hint: "Image, video and audio generation, design and 3D" },
  { id: "knowledge", label: "Knowledge & notes", hint: "Notes, wikis, docs and agent memory" },
  { id: "commerce", label: "Commerce & payments", hint: "Selling, payments and storefronts" },
  { id: "automation", label: "Automation", hint: "Shortcuts, scripting and services that run on their own" },
  { id: "research", label: "Search & OSINT", hint: "Web search, crawling, trend research and open-source intelligence" },
  { id: "devices", label: "Devices & network", hint: "Your tailnet, SSH hosts and remote access" },
  { id: "browsers", label: "Browsers", hint: "Browser apps, profiles and browser automation" },
  { id: "mcp", label: "MCP servers", hint: "Tool servers each agent app can call" },
  { id: "skills", label: "Skills", hint: "Packaged know-how agents can load" },
  { id: "keys", label: "Keys & secrets", hint: "API key names and where they're set. Values are never read or sent." },
  { id: "yours", label: "Yours", hint: "Connections you added by hand" },
] as const;
export type Cat = (typeof CATEGORIES)[number]["id"];
export type State = "ready" | "signed-out" | "installed" | "offline" | "off";
const IDS = new Set<string>(CATEGORIES.map((c) => c.id));

// Older nodes send services with a free-text group; map those (and a few names) onto the store's categories.
const GROUP: Record<string, Cat> = { "Code & deploy": "cloud", Data: "data", Payments: "commerce", Cloud: "cloud", Network: "devices", AI: "ai", Secrets: "keys", Messaging: "comms", Design: "media", Media: "media" };
const NAME: Record<string, Cat> = { GitHub: "code", npm: "code", Linear: "code", ElevenLabs: "media", fal: "media", "Google Drive": "knowledge", Notion: "knowledge", Playwright: "browsers", Chrome: "browsers", "1Password": "keys" };
const SECTION: Record<string, Cat> = { ai: "ai", mcp: "mcp", machines: "devices", devices: "devices", keys: "keys", dev: "code", browser: "browsers", skills: "skills", custom: "yours", background: "automation" };

export function categorize(item: Item, sectionId = ""): Cat {
  if (item.cat && IDS.has(item.cat)) return item.cat as Cat;
  if (item.custom || sectionId === "custom") return "yours";
  if (NAME[item.name]) return NAME[item.name];
  if (item.kind === "service" && item.group && GROUP[item.group]) return GROUP[item.group];
  return SECTION[sectionId] ?? (item.kind === "agent" || item.kind === "sub" ? "ai" : item.kind === "mcp" ? "mcp" : item.kind === "ssh" ? "devices" : "yours");
}

export function stateOf(item: Item): State {
  if (item.state) return item.state;
  if (item.status === "off") return "off";
  if (item.status === "partial") return "signed-out";
  // Older nodes don't say whether "installed" means usable (ffmpeg) or unconfigured (a CLI never signed in): call it ready.
  return "ready";
}

export type StoreInventory = Inventory & { categories: { id: string; label: string; hint: string }[] };
/** Every item gets a category and a state; the inventory carries the category list. Pure: returns a copy. */
export function enrich(inv: Inventory): StoreInventory {
  return {
    ...inv,
    categories: CATEGORIES.map((c) => ({ ...c })),
    sections: inv.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, cat: categorize(i, s.id), state: stateOf(i) })) })),
  };
}

/** Every item once (the first section that has it wins), for lookups by id. */
export function allItems(inv: Inventory): Item[] {
  const seen = new Map<string, Item>();
  for (const s of inv.sections) for (const i of s.items) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()];
}
