// Turns a raw terminal read into the few lines that say what a pane is doing,
// dropping agent chrome (input boxes, status bars, spinners, borders).

const CHROME: RegExp[] = [
  /^[\s─━═│┃╹╻▀▄█▌▐░▒▓⠀-⣿╭╮╯╰┌┐└┘├┤┬┴┼·•]*$/u, // borders, braille spinners, empty boxes
  /^\s*[❯›>]\s*$/u, // empty prompts
  /ctrl\+p commands/,
  /bypass permissions|shift\+tab to cycle|auto-accept edits/,
  /Context \d+% used|weekly \d+% left/,
  /Ask Codex to do anything/,
  /^\s*(▣\s+)?Build · /u,
  /^\s*~\/\S*:\S*\s*$/, // OpenCode footer "~/dir:branch"
  /^\s*[─━]{3,}/u, // rules with a label inside
  /^\s*Remote Control\s*$/,
  /new task\? \/clear to save/,
  /^[✻✢✳✶*·] \w+ for [\dhms ]+(· done .*)?$/u, // "✻ Brewed for 6m 25s · done 3:55 PM"
  /MCP (client for|startup)|MCP server failed|handshaking with MCP|server failed: con/,
  /^\s*↑\/↓ to select/,
  /^\s*(Opus|Sonnet|Haiku|Fable) [\d.]+\b.*(Weekly|Session|main)/,
  /Remote Control disconnected/,
  /Tip: /,
  /\/limit-reset to reset/,
  /Update installed · Restart/,
  /How is Claude doing this session/,
  /1: Bad\s+2: Fine/,
  /disable recaps in \/config/,
  /^\s*\(base\)\s*$/,
  /^\s*╰─❯\s*\S*\s*\d\d:\d\d\s*$/u,
];

export function cleanTail(text: string, keep = 4): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "").replace(/^\s*[┃│]\s?/u, "  ");
    if (!line.trim()) continue;
    if (CHROME.some((re) => re.test(line))) continue;
    out.push(line.length > 220 ? line.slice(0, 219) + "…" : line);
  }
  return out.slice(-keep).map((l) => l.replace(/^\s{2,}/, "  "));
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "login", "nu", "tmux"]);

/** A pane with no agent whose foreground is just the shell is an empty pane. */
export function isShellOnly(foreground: { name?: string; argv0?: string }[] | undefined): boolean {
  if (!foreground || foreground.length === 0) return true;
  return foreground.every((p) => SHELLS.has(p.name ?? "") || SHELLS.has(p.argv0 ?? ""));
}
