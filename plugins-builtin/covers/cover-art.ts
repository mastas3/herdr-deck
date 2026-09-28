// Cover art for Discover ideas: the house style, the prompt that turns an idea into one visual metaphor, the Codex
// call that paints it (gpt-image-2 through the user's ChatGPT login, the codex-image skill's method), and the
// resize to small WebP files. The job that decides *which* idea gets painted *when* is src/covers.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const HOME = homedir();

// ── the house style: one place, so every cover looks like it came from the same print shop ──
/** Two spot inks per category on the same cream paper; where inks overlap they make the third tone. Never purple. */
export const PALETTES: Record<string, { name: string; inks: [string, string]; paper: string }> = {
  money: { name: "riso green and bright red", inks: ["#00A95C", "#F15060"], paper: "#F4EEE2" },
  saas: { name: "riso blue and yellow", inks: ["#0078BF", "#FFD400"], paper: "#F4EEE2" },
  automations: { name: "teal and orange", inks: ["#00838A", "#FF6C2F"], paper: "#F4EEE2" },
  content: { name: "bright red and federal blue", inks: ["#F15060", "#3D5588"], paper: "#F4EEE2" },
  projects: { name: "brick red and aqua", inks: ["#A75154", "#5EC8E5"], paper: "#F4EEE2" },
  gem: { name: "medium blue and mint", inks: ["#3255A4", "#82D8D5"], paper: "#F4EEE2" },
  weekend: { name: "sunflower and charcoal", inks: ["#FFB511", "#2E2E2E"], paper: "#F4EEE2" },
  wild: { name: "fluorescent pink and green", inks: ["#FF48B0", "#00A95C"], paper: "#F4EEE2" },
};
export const HOUSE_STYLE = [
  "Editorial risograph poster illustration: flat, bold graphic shapes printed in exactly two spot inks on warm uncoated cream paper,",
  "with fine riso grain, a little ink misregistration, and a third tone only where the two inks overprint.",
  "Mid-century modern poster sensibility (Saul Bass, Olle Eksell, a smart magazine spot illustration): simple geometric forms and everyday physical objects,",
  "one idea, drawn large and confidently cropped, with generous empty paper around it. Matte and tactile.",
].join(" ");
/** Said after the subject, as hard rules. The words here must never appear in the subject part of a prompt. */
export const AVOID = [
  "No text of any kind: no letters, numbers, words, captions, signage, labels, logos or watermarks, not even fake or blurred ones.",
  "No human faces; if a person is needed, only hands or a faceless flat silhouette.",
  "No robots, glowing brains, circuit boards, network nodes, holograms, light bulbs, rockets, gears, clouds with arrows, floating screens, laptops or phones as the subject.",
  "No neon, glow, lens flare, 3D render, photorealism, glossy plastic, dark sci-fi backdrop, or purple and blue-purple gradients.",
].join(" ");
/** Clichés an idea's own words can drag into the picture; the context we pass is scrubbed of them. */
export const CLICHES = /\b(ai|a\.i\.|llm|llms|gpt|chatgpt|neural|robots?|bots?|brains?|circuits?|holograms?|glowing|neon|futuristic|cyber\w*|agents?|agentic|machine learning|ml)\b/gi;

export type CoverIdea = {
  id: string; title: string; pitch?: string; row?: string; customer?: string; problem?: string; offer?: string; price?: string;
  how?: { name: string; role: string }[]; ingredients?: string[]; mvp?: string[];
};

const CATS: [string, RegExp][] = [
  ["content", /\b(video|clips?|reels?|shorts|podcast|newsletter|content|posts?|dub\w*|captions?|youtube|tiktok|voice|music|audio)\b/i],
  ["automations", /\b(automat\w*|scrap\w*|workflow|alerts?|monitor\w*|pipeline|done-for-you|leads?)\b/i],
  ["saas", /\b(subscription|saas|dashboard|per month|monthly|\/mo)\b/i],
  ["weekend", /\bweekend\b/i],
];
/** The idea's category: the feed row it came from, else a guess from its words. Picks the palette (and the card's placeholder). */
export function categoryOf(x: Pick<CoverIdea, "row" | "title" | "pitch" | "offer">): string {
  if (x.row && PALETTES[x.row]) return x.row;
  const text = `${x.title} ${x.pitch ?? ""} ${x.offer ?? ""}`;
  return CATS.find(([, re]) => re.test(text))?.[0] ?? "money";
}

/** Concrete, printable objects for common mechanisms: hints, not orders (the painter may find a better one). */
const MOTIFS: [RegExp, string][] = [
  [/\b(clips?|reels?|shorts|highlights?)\b/i, "a long film strip being snipped into short pieces by a large pair of scissors"],
  [/\b(dub\w*|captions?|subtitles?|translat\w*)\b/i, "one paper speech bubble passing through a hand-cranked printing press and coming out as two"],
  [/\b(tenders?|bids?|contracts?|procurement)\b/i, "a lighthouse beam picking out one envelope in a sea of envelopes"],
  [/\b(alerts?|monitor\w*|watch\w*)\b/i, "a brass bell on a string tied to a fishing float"],
  [/\b(scrap\w*|collect\w*|harvest\w*|aggregat\w*)\b/i, "a wide fishing net lifting a catch of small paper shapes"],
  [/\b(osint|investigat\w*|audit\w*|due diligence)\b/i, "one thread pulled out of a tangled ball of yarn, leading to a small key"],
  [/\b(reports?|readings?|personali[sz]ed|bespoke)\b/i, "a tailor's tape measure wrapped around something that is usually one-size-fits-all"],
  [/\b(human design|bodygraph|astrolog\w*|horoscope|charts?|birth)\b/i, "a hand-drawn star map where a few stars are joined by simple lines, next to a compass"],
  [/\b(telegram|whatsapp|messag\w*|chat)\b/i, "a paper plane delivering a folded note"],
  [/\b(newsletters?|emails?|digest)\b/i, "a stack of envelopes tied with string"],
  [/\b(video|film|youtube|tiktok)\b/i, "a vintage film camera on a tripod"],
  [/\b(podcast|voice|audio|music)\b/i, "a big old-fashioned microphone with sound drawn as concentric rings"],
  [/\b(course|coach\w*|teach\w*|lesson\w*|learn\w*)\b/i, "stepping stones crossing a stream"],
  [/\b(shops?|stores?|local business\w*|small business\w*|restaurants?|cafes?)\b/i, "a small shopfront with a striped awning"],
  [/\b(hebrew|russian|israel\w*|multilingual)\b/i, "two different paper cut-out shapes fitting together like puzzle pieces"],
  [/\b(daily|briefing|morning)\b/i, "a folded morning newspaper next to a coffee cup, seen from above"],
  [/\b(templates?|kits?|packs?)\b/i, "a neat set of rubber stamps in a wooden tray"],
];
export function motifsFor(x: CoverIdea, n = 2): string[] {
  const text = `${x.title} ${x.pitch ?? ""} ${x.offer ?? ""} ${(x.how ?? []).map((h) => h.role).join(" ")}`;
  return MOTIFS.filter(([re]) => re.test(text)).slice(0, n).map(([, m]) => m);
}
/** Words that feed the picture, scrubbed of clichés and quotes (a quoted phrase tempts the model to letter it). */
export function scrub(s: unknown, n = 220): string {
  return String(s ?? "")
    .replace(/\b(ai|llm|gpt)[- ](powered|generated|driven|based|assisted)\b/gi, "$2")
    .replace(/\(?\b[\w-]+(\.[\w-]+)*\.(com|il|io|ai|app|org|net|co|me)\b[^\s)]*\)?/gi, "") // domains and links
    .replace(CLICHES, "")
    .replace(/["“”«»]/g, "").replace(/(^|\s)['‘]([^'’]{1,80})['’]/g, "$1$2")
    .replace(/\s+([,.;:])/g, "$1").replace(/([,.;:])\1+/g, "$1").replace(/\s+/g, " ").trim().slice(0, n);
}

/** The whole prompt for one idea: house style, its palette, the mechanism as a metaphor brief, then the hard rules and the output path. */
export function coverPrompt(x: CoverIdea, outPng: string): { prompt: string; category: string; subject: string } {
  const category = categoryOf(x);
  const p = PALETTES[category];
  const mech = scrub(x.offer || (x.how ?? []).map((h) => h.role).slice(0, 2).join("; ") || x.pitch, 260);
  const motifs = motifsFor(x);
  const subject = [
    `The business, for context only (draw none of these words): ${scrub(x.pitch || x.title, 240)}`,
    x.customer ? `Who it serves: ${scrub(x.customer, 160)}.` : "",
    x.problem ? `Their problem: ${scrub(x.problem, 160)}.` : "",
    mech ? `What they get: ${mech}.` : "",
    "The picture: before drawing, decide on ONE concrete physical visual metaphor for the change this business makes for that customer (their problem becoming what they get), built from everyday objects, the way a clever magazine cover would show it.",
    "It must be specific to this business: someone who sees it among twenty other covers should be able to guess which business it belongs to. Skip the first obvious symbol (a generic magnifying glass, map, globe, chart, target, puzzle, key or handshake). Two or three objects at most, understandable without words.",
    motifs.length ? `Possible starting points, only if nothing sharper comes to mind: ${motifs.join("; ")}.` : "",
  ].filter(Boolean).join("\n");
  const prompt = [
    `Generate one landscape 16:9 illustration (generate at your native landscape size, e.g. 1536x1024; do not upscale or add borders).`,
    `Style: ${HOUSE_STYLE}`,
    `Palette: ${p.name} (${p.inks.join(" and ")}) on cream paper (${p.paper}); nothing else but their overprint and the paper.`,
    subject,
    `Composition: keep the whole main subject inside the central square of the frame (the middle two thirds of the width), so a square crop keeps it whole; calm empty paper to the left and right.`,
    `Rules: ${AVOID}`,
    `Save the final PNG to ${outPng} and reply with only that absolute path.`,
  ].join("\n\n");
  return { prompt, category, subject };
}

// ── painting: `codex exec`, prompt on stdin (the skill's one rule: -i is variadic and would swallow a trailing prompt) ──
const BIN_DIRS = () => {
  let nvm: string[] = [];
  try { nvm = readdirSync(`${HOME}/.nvm/versions/node`).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => `${HOME}/.nvm/versions/node/${v}/bin`); } catch {}
  return [...(process.env.PATH ?? "").split(":"), `${HOME}/.local/bin`, `${HOME}/.bun/bin`, ...nvm, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
};
export const findBin = (name: string) => BIN_DIRS().map((d) => `${d}/${name}`).find((p) => existsSync(p));

/** Paints one cover with Codex into outPng. Throws with a short reason when no image came back. */
export async function codexPaint(prompt: string, outPng: string, signal: AbortSignal, timeoutMs = 8 * 60_000): Promise<void> {
  const codex = process.env.DECK_CODEX_BIN || findBin("codex");
  if (!codex) throw new Error("Codex (codex) isn't installed here");
  const work = dirname(outPng);
  const started = Date.now();
  // codex is a node script under nvm: its own directory goes first on PATH so a launchd service finds `node`.
  const env = { ...process.env, PATH: `${dirname(codex)}:${BIN_DIRS().join(":")}`, NO_COLOR: "1" };
  const p = Bun.spawn([codex, "exec", "-C", work, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--ephemeral", "-c", 'model_reasoning_effort="low"'],
    { cwd: work, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env });
  const kill = () => { try { p.kill(9); } catch {} };
  signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  signal.removeEventListener("abort", kill);
  if (existsSync(outPng) && statSync(outPng).size > 1000) return;
  // It painted but didn't copy: take the one image it made during this run (only if exactly one, never someone else's).
  const made = recentImages(started);
  if (made.length === 1) { await Bun.write(outPng, Bun.file(made[0])); return; }
  if (signal.aborted) throw new Error("stopped");
  if (Date.now() - started >= timeoutMs) throw new Error("Codex took too long");
  const why = `${err}\n${out}`.split("\n").map((l) => l.trim()).filter((l) => /error|limit|login|auth|denied|refus/i.test(l)).pop();
  throw new Error(`Codex returned no image (exit ${code})${why ? `: ${why.slice(0, 160)}` : ""}`);
}
function recentImages(since: number): string[] {
  const root = `${HOME}/.codex/generated_images`;
  const out: string[] = [];
  try {
    for (const d of readdirSync(root)) {
      const dir = `${root}/${d}`;
      if (statSync(dir).mtimeMs < since - 1000) continue;
      for (const f of readdirSync(dir)) if (/\.png$/i.test(f) && statSync(`${dir}/${f}`).mtimeMs >= since - 1000) out.push(`${dir}/${f}`);
    }
  } catch {}
  return out;
}

// ── resizing: ffmpeg (libwebp) or cwebp; no npm dependencies ──
export const MAIN = { w: 960, h: 540 }, THUMB = 320, MAX_BYTES = 150_000;
/** PNG width and height straight from the IHDR chunk (cwebp needs them to crop). */
export function pngSize(buf: Uint8Array): { w: number; h: number } | undefined {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return;
  const v = new DataView(buf.buffer, buf.byteOffset);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}
export function imageTool(): "ffmpeg" | "cwebp" | undefined {
  const ff = findBin("ffmpeg");
  if (ff) {
    const r = Bun.spawnSync([ff, "-hide_banner", "-encoders"], { stdout: "pipe", stderr: "ignore" });
    if (/libwebp/.test(r.stdout.toString())) return "ffmpeg";
  }
  return findBin("cwebp") ? "cwebp" : undefined;
}
/** A centered crop to w:h, scaled to exactly w×h, as WebP at quality q. */
async function toWebp(tool: "ffmpeg" | "cwebp", src: string, dst: string, w: number, h: number, q: number) {
  let cmd: string[];
  if (tool === "ffmpeg") {
    const r = `${w}/${h}`;
    cmd = [findBin("ffmpeg")!, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1",
      "-vf", `crop=w=min(iw\\,ih*${r}):h=min(ih\\,iw/(${r})),scale=${w}:${h}:flags=lanczos`, "-c:v", "libwebp", "-quality", String(q), "-compression_level", "6", dst];
  } else {
    const size = pngSize(new Uint8Array(await Bun.file(src).arrayBuffer()));
    if (!size) throw new Error("cwebp needs a PNG");
    const cw = Math.min(size.w, Math.round((size.h * w) / h)), ch = Math.min(size.h, Math.round((size.w * h) / w));
    cmd = [findBin("cwebp")!, "-quiet", "-q", String(q), "-m", "6", "-crop", String(Math.floor((size.w - cw) / 2)), String(Math.floor((size.h - ch) / 2)), String(cw), String(ch), "-resize", String(w), String(h), src, "-o", dst];
  }
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0 || !existsSync(dst)) throw new Error(`${tool} failed: ${err.trim().slice(0, 160)}`);
}
/** The card cover (960×540) and the square thumb (320×320), each under MAX_BYTES (quality steps down if needed). */
export async function makeCovers(src: string, base: string, tool = imageTool()): Promise<{ main: number; thumb: number }> {
  if (!tool) throw new Error("No image tool: install ffmpeg (with libwebp) or cwebp");
  const sizes = { main: 0, thumb: 0 };
  for (const [k, dst, w, h] of [["main", `${base}.webp`, MAIN.w, MAIN.h], ["thumb", `${base}_thumb.webp`, THUMB, THUMB]] as const) {
    for (const q of [72, 58, 44]) {
      await toWebp(tool, src, dst, w, h, q);
      sizes[k] = statSync(dst).size;
      if (sizes[k] <= MAX_BYTES) break;
    }
  }
  return sizes;
}

// ── not fighting the user for Codex ──
/** Is someone else's Codex busy? Any `codex exec` outside our own process tree, or a Codex process working the CPU. */
export function codexBusy(ps: string, ownPid = process.pid, cpu = 20): boolean {
  const rows = ps.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: +m[1], ppid: +m[2], cpu: +m[3], cmd: m[4] }));
  const mine = new Set([ownPid]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  return rows.some((r) => {
    if (mine.has(r.pid)) return false;
    const [exe, arg1 = ""] = r.cmd.split(/\s+/);
    const isCodex = /(^|\/)codex$/.test(exe) || (/(^|\/)node$/.test(exe) && /(\/bin\/codex|codex\.js)$/.test(arg1));
    if (!isCodex) return false;
    return / exec(\s|$)/.test(r.cmd) || r.cpu >= cpu;
  });
}
export function readPs(): string {
  try { return Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,pcpu=,command="], { stdout: "pipe", stderr: "ignore" }).stdout.toString(); } catch { return ""; }
}
export const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
