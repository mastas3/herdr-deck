// The deck's settings and its own files: where it listens, the data folder, the node token, hosts.json and the
// graveyard of closed sessions. The constants only read the environment; the functions touch the disk, and
// src/server.ts calls them at startup in this order.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import type { RemoteConf } from "../federation";

export const PORT = Number(process.env.DECK_PORT ?? 4747);
export const HOST = process.env.DECK_HOST ?? "127.0.0.1";
export const DEV = !!process.env.DECK_DEV;
export const TOKEN = crypto.randomUUID();
export const DATA_DIR = `${homedir()}/.config/herdr-deck`;
// Push keys, subscribed devices and automation rules (DECK_PUSH_DIR moves them, e.g. for a test instance).
export const PUSH_DIR = process.env.DECK_PUSH_DIR ?? DATA_DIR;
export const PUBLIC_URL = (process.env.DECK_PUBLIC_URL ?? "").replace(/\/$/, "");

export function makeDataDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(PUSH_DIR, { recursive: true });
}

// Nodes authenticate hub requests with this token. Only someone who can already log in to this
// machine (the hub reads it over SSH) can obtain it.
const API_TOKEN_FILE = `${DATA_DIR}/api.token`;
export function loadApiToken() {
  let token = "";
  try { token = readFileSync(API_TOKEN_FILE, "utf8").trim(); } catch {}
  if (!/^[a-f0-9]{32,}$/.test(token)) {
    token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    writeFileSync(API_TOKEN_FILE, token + "\n", { mode: 0o600 });
  }
  chmodSync(API_TOKEN_FILE, 0o600);
  return token;
}

// hosts.json: { "self": { "id", "label" }, "remotes": [{ "id", "label", "ssh" }] }
export type HostsFile = { self?: { id?: string; label?: string }; remotes?: RemoteConf[] };
export function loadHosts() {
  let hostsConf: HostsFile = {};
  try { hostsConf = JSON.parse(readFileSync(`${DATA_DIR}/hosts.json`, "utf8")); } catch {}
  const self = {
    id: (hostsConf.self?.id ?? "local").replace(/[^\w-]/g, "") || "local",
    label: hostsConf.self?.label ?? hostname().replace(/\.local$/, ""),
  };
  return { hostsConf, self };
}
export type Self = ReturnType<typeof loadHosts>["self"];

export type Grave = {
  id: string;
  closedAt: number;
  herdr: string;
  workspaceId: string;
  title: string;
  agent: string;
  cwd: string;
  project: string;
  tab: string;
  sessionId?: string;
  resume?: string;
  lastActiveAt?: number;
};

/** Closed sessions, newest first, so they can be reopened. `list` is replaced when entries go. */
export function loadGraves() {
  const file = `${DATA_DIR}/graveyard.json`;
  const g = { list: [] as Grave[], save: () => writeFileSync(file, JSON.stringify(g.list.slice(0, 300), null, 1)) };
  try { g.list = JSON.parse(readFileSync(file, "utf8")); } catch {}
  return g;
}
export type Graves = ReturnType<typeof loadGraves>;
