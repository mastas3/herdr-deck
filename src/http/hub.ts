// Everything a route needs from the running deck, built once by src/server.ts after startup has made it all.
import type { Deck, Row } from "../deck";
import type { Decision } from "../decisions";
import type { PushStore } from "../push";
import type { Automations } from "../automations";
import type { McpCtx } from "../mcp";
import type { Assets } from "../assets";
import type { createLibrary } from "../library";
import type { createLeads } from "../leads";
import type { researchForServer } from "../autoresearch-server";
import type { createJourneys } from "../journey";
import type { gameForServer } from "../game-server";
import type { createOpportunityService } from "../opportunity-service";
import type { createPlugins } from "../plugins";
import type { PluginHost } from "../plugin-host";
import type { createCodePluginApi } from "../plugin-code-api";
import type { Graves, Self } from "./config";
import type { Sse } from "./sse";
import type { Machines } from "./machines";
import type { Sessions } from "./sessions";
import type { Chat } from "./chat";
import type { ToolRuns } from "./run-tools";

export type Hub = {
  DEV: boolean; TOKEN: string; PORT: number; SELF: Self;
  deck: Deck; hosts: Machines; graves: Graves; fakeRows: Map<string, Row>;
  /** Which session each open page is showing (and whether it's on screen): no push for what you're looking at. */
  presence: Map<string, { key: string | null; at: number }>;
  push: PushStore; auto: Automations | undefined; game: ReturnType<typeof gameForServer>;
  library: ReturnType<typeof createLibrary>; leads: ReturnType<typeof createLeads>; research: ReturnType<typeof researchForServer>;
  journeys: ReturnType<typeof createJourneys>; opportunities: ReturnType<typeof createOpportunityService>; plugins: ReturnType<typeof createPlugins>;
  pluginHost: PluginHost; codePlugins: ReturnType<typeof createCodePluginApi>;
  sse: Sse; fullState: () => unknown; page: () => string; assets: Assets;
  decisions: Map<string, Decision>; scheduleDecisions: () => void; broadcastGraves: () => void; refreshShared: () => Promise<void>;
  sessions: Sessions; chat: Chat; tools: ToolRuns; queue: { queues: Record<string, { id: string; text: string; at: number }[]>; saveQueues: () => void };
  mcp: { token: string; ctx: McpCtx }; auth: { hasApiToken: (req: Request) => boolean; allowedHost: (req: Request) => boolean };
  forwardToMachine: (path: string, body: any) => Promise<Response | undefined>;
};

/** The part of the discover plugin's service (plugins-builtin/discover) the core reads: Leads' saved list, the profile
 *  Research and Leads start from, and the ingredients and archive Opportunities builds on. */
export type DiscoverService = {
  leadsSaved: { get: () => any[]; set: (v: any[]) => void };
  profile(): Promise<{ interests: { id: string; label: string; score?: number }[]; projects: { name: string; tldr: string; status: string; weight: number }[] }>;
  ingredients(max: number): Promise<{ list: any[] }>;
  handle(path: string, body: any): Promise<any>;
};
