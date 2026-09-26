// Short "what was this about" briefs, written by a local Ollama model so conversation
// content never leaves the machine and no agent usage limits are spent. Cached on disk.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Detail } from "./transcript";

export type Brief = { about: string; started: string; now: string; at: number; asks: number; model: string };

const DIR = `${homedir()}/.config/herdr-deck/briefs`;
const MODEL = process.env.DECK_BRIEF_MODEL ?? "gemma4:e4b";
const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
mkdirSync(DIR, { recursive: true });

const file = (id: string) => `${DIR}/${id.replace(/[^\w.-]/g, "_")}.json`;

export function cachedBrief(id: string): Brief | undefined {
  try { return JSON.parse(readFileSync(file(id), "utf8")); } catch {}
}

const cut = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? s.slice(0, n) + "…" : s);

export function briefPrompt(title: string, project: string, d: Detail): string {
  // Keep the prompt small: the opening ask, a spread of later asks, and the latest state.
  const asks = d.turns.slice(1);
  const step = Math.max(1, Math.ceil(asks.length / 18));
  const sampled = asks.filter((_, i) => i % step === 0 || i === asks.length - 1);
  const last = d.turns[d.turns.length - 1];
  return [
    `You summarise a coding-agent session so its owner remembers it at a glance.`,
    `Session title: ${title}`,
    `Project folder: ${project}`,
    ``,
    `First request:\n${cut(d.started, 1500)}`,
    ``,
    sampled.length ? `Later requests, in order:\n${sampled.map((t) => `- ${cut(t.ask, 220)}`).join("\n")}` : "",
    d.recap ? `\nAgent's own recap:\n${cut(d.recap.text, 700)}` : "",
    last?.reply ? `\nAgent's latest reply:\n${cut(last.reply, 700)}` : "",
    ``,
    `Write exactly three lines, plain text, no markdown, second person ("you"):`,
    `ABOUT: one sentence on what this session is for.`,
    `STARTED: one sentence on how it began.`,
    `NOW: one or two sentences on where it stands and what is left, if anything.`,
  ].join("\n");
}

export function parseBrief(text: string) {
  // Models sometimes bold the label, with the colon inside or outside the stars.
  const grab = (k: string) => text.match(new RegExp(`^\\s*\\**\\s*${k}\\s*(?::\\s*\\**|\\**\\s*:)\\s*(.+)$`, "im"))?.[1].trim() ?? "";
  return { about: grab("ABOUT"), started: grab("STARTED"), now: grab("NOW") };
}

const inflight = new Map<string, Promise<Brief>>();

export function writeBrief(id: string, title: string, project: string, d: Detail): Promise<Brief> {
  const running = inflight.get(id);
  if (running) return running;
  const job = (async () => {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        prompt: briefPrompt(title, project, d),
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: 220, num_ctx: 8192 },
      }),
      signal: AbortSignal.timeout(120_000),
    }).catch(() => {
      throw new Error(`Ollama isn't reachable at ${OLLAMA}; start it with "ollama serve"`);
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out: any = await res.json();
    const parsed = parseBrief(out.response ?? "");
    if (!parsed.about && !parsed.now) throw new Error("The model's answer couldn't be read; try again");
    const brief: Brief = { ...parsed, at: Date.now(), asks: d.asks, model: MODEL };
    writeFileSync(file(id), JSON.stringify(brief));
    return brief;
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
