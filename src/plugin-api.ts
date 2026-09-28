// The contract between the deck and a code plugin: what `activate(host)` receives. Types only, so a plugin can import
// them (`import type { Host } from "../../src/plugin-api"`) without pulling in any of the deck. The host that fills
// this in is src/plugin-host.ts; the manifest (plugin.json) is src/plugin-code-format.ts.
// Design: docs/superpowers/specs/2026-09-28-code-plugins-design.md.
import type { Row } from "./deck";
import type { Decision } from "./decisions";
import type { Machine } from "./federation";
import type { PushStore } from "./push";
import type { Automations } from "./automations";
import type { Tool } from "./tools";
import type { CheckResult } from "./verify";
import type { HistSession } from "./history";

/** What a plugin's server entry exports. The returned function (if any) runs first when the plugin is turned off. */
export type Deactivate = () => void | Promise<void>;
export type Activate = (host: Host) => Promise<Deactivate | void> | Deactivate | void;

/** One request to a plugin route. `body` is the parsed JSON body of a POST (`{}` for a GET). */
export type RouteReq = { method: string; path: string; url: URL; body: any; req: Request };
/** A Response is sent as is; `undefined` means "not mine" (the next handler, then core, gets it); anything else is
 *  sent as JSON. A throw becomes a 500 naming this plugin, and nothing else is affected. */
export type RouteHandler = (r: RouteReq) => unknown | Promise<unknown>;

export type Notice = { key?: string; ok: boolean; message: string };
export type StartSession = { kind: string; cwd: string; prompt?: string; args?: string[]; label?: string; model?: string; effort?: string; focus?: boolean };

/** Extension points the core reads. Plugins may also open their own (e.g. `discover.tabs`): any other name is free. */
export type CorePoints = {
  /** A top-level key in the page's starting state (window.__BOOT__ and every SSE "full"). Core keys can't be taken. */
  fullState: { key: string; get: () => unknown };
  /** A section of the morning digest push, e.g. today's quests. `pref` is a device preference that turns it off. */
  "digest.lines": { title: string; lines: () => Promise<string[]>; pref?: string };
  /** An MCP tool other agents can call through the deck's /mcp endpoint. */
  "mcp.tools": { name: string; description: string; inputSchema: object; call: (args: any) => Promise<unknown> };
  /** A session tool (the Tools view and the "." menu); runs like the built-in prompt tools. */
  "tools.entries": Tool;
};
export type PointName = keyof CorePoints | (string & {});
export type Contribution<P extends PointName> = P extends keyof CorePoints ? CorePoints[P] : unknown;

export type Host = {
  /** This plugin's id, its folder, and the deck's data folder (~/.config/herdr-deck): data stays where it lives today. */
  readonly id: string;
  readonly dir: string;
  readonly dataDir: string;
  /** An environment variable (DECK_* overrides, test folders). */
  env(name: string): string | undefined;
  log(msg: string): void;

  /** `routes("covers", h)`: POST /api/covers and /api/covers/* (the action token is already checked).
   *  `routes("/covers/", h)`: GETs under that path, no token (images, files). Both must be listed in plugin.json `routes`. */
  routes(prefix: string, handler: RouteHandler): void;
  /** Timers that stop when the plugin is turned off. Each returns a function that cancels it early. */
  every(ms: number, fn: () => unknown): () => void;
  after(ms: number, fn: () => unknown): () => void;
  /** Runs when the plugin is turned off (close databases, abort child processes). */
  onStop(fn: () => unknown): void;

  /** Offer a service by a name listed in plugin.json `provides`. */
  provide<T extends object>(name: string, api: T): void;
  /** Another plugin's service, from one listed in `requires` or `uses`; `undefined` while that plugin is off.
   *  Call it when you need it, don't keep the result: a plugin can be turned off at any time. */
  use<T = any>(name: string): T | undefined;
  /** Contribute to an extension point listed in plugin.json `extends`. Removed when the plugin is turned off. */
  extend<P extends PointName>(point: P, contribution: Contribution<P>): void;
  /** Everything contributed to a point, by running plugins in load order. */
  contributions<P extends PointName>(point: P): Contribution<P>[];
  /** This plugin's settings (plugin.json `settings`), as the user set them in the Plugins view. */
  setting<T = unknown>(key: string): T;

  // ── the core, lent as it is ──
  rows(): Row[];
  sessions: { start(o: StartSession): Promise<{ key?: string; paneId?: string }>; send(key: string, text: string): Promise<void>; close(keys: string[], wholeTab?: boolean): Promise<unknown> };
  push: PushStore;
  automations(): Automations | undefined;
  decisions(): Decision[];
  /** An SSE event to every open page (not one of the core's own event names). */
  broadcast(event: string, data: unknown): void;
  /** A toast on every open page. */
  notice(n: Notice): void;
  machines(): Machine[];
  /** Past sessions on every machine (the History view's search): by words (`q`), by project, newest first. */
  history(o: { q?: string; project?: string; agent?: string; limit?: number }): Promise<(HistSession & { machine?: string })[]>;
  /** Proof of done: the latest check result per project root the deck has seen. */
  checks(): ReadonlyMap<string, CheckResult>;
  /** True when a hub talks to this deck. Hub-only plugins never start on a node; this is for work that should pause. */
  isNode(): boolean;
};
