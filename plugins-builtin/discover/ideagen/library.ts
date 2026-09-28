// Outside evidence for pre-mortems: the founder-story library (another deck agent ingests channels like Starter Story
// into ~/.config/herdr-deck/library/ and serves POST /api/library/search) and the autoresearch reports in
// ~/.config/herdr-deck/research/**. Both are optional: with neither present every lookup returns [] and the engine
// works as before. Local files only; nothing here calls the network by itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { terms } from "./evidence";

export type Passage = { text: string; source: string; url?: string; title?: string };
export type LibrarySearch = (q: string, k: number) => Promise<Passage[]>;
const HOME = homedir();

function mdFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...mdFiles(p, depth - 1));
    else if (/\.(md|txt)$/.test(name)) out.push(p);
  }
  return out;
}
/** Paragraphs from local markdown that share at least three words with the query, best first. */
function searchFiles(files: string[], q: string, k: number, source: string): Passage[] {
  const want = new Set(terms(q));
  const hits: (Passage & { n: number })[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const title = text.match(/^#\s+(.+)$/m)?.[1];
    for (const para of text.split(/\n\s*\n/)) {
      const n = terms(para).filter((w) => want.has(w)).length;
      if (n >= 3 && para.length > 80) hits.push({ text: para.replace(/\s+/g, " ").slice(0, 400), source, url: para.match(/https?:\/\/\S+/)?.[0]?.replace(/[)\]>.,]+$/, "") ?? `file://${f}`, title, n });
    }
  }
  return hits.sort((a, b) => b.n - a.n).slice(0, k).map(({ n, ...p }) => p);
}
/** Founder stories (who did something similar, how much they make). Uses the library's search when the deck passes it. */
export async function libraryEvidence(q: string, o: { search?: LibrarySearch; dir?: string; k?: number } = {}): Promise<Passage[]> {
  const k = o.k ?? 3;
  if (o.search) { try { return (await o.search(q, k)).slice(0, k); } catch { return []; } }
  return searchFiles(mdFiles(o.dir ?? `${HOME}/.config/herdr-deck/library`), q, k, "library");
}
/** Competitors, prices and complaints from autoresearch reports. */
export function researchEvidence(q: string, o: { dir?: string; k?: number } = {}): Passage[] {
  return searchFiles(mdFiles(o.dir ?? `${HOME}/.config/herdr-deck/research`), q, o.k ?? 3, "research");
}
