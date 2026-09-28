# Autopilot: rules that answer permission prompts

Status: draft for review · 2026-09-26 · Spec 2 of 3 (uses `worktree.ts` from spec 1; Goals' night shift depends on it)

## Why

Most interruptions are the same safe permission prompt asked for the hundredth time: `bun test`,
`git diff`, `ls`, an edit inside the repo. Each one blocks an agent until you look. Claude Code's own
"don't ask again" only covers Claude, is spread across settings files, and you can't see it or take it back
from the deck. Autopilot is a set of rules you approve, per machine and project, that the deck uses to answer
those prompts for you. Every answer is logged, and you can revoke a rule or pause everything from your phone.
Without it, Night shift (spec 3) would stall on the first prompt.

## Principles

1. **You approve rules. The deck never approves prompts on its own.** Learning only *suggests* rules. Nothing
   is auto-answered until you've accepted a rule.
2. **Allow once, never "always".** Autopilot picks the agent's one-time "Yes". A rule you revoke in the deck
   really stops working, because nothing was saved into the agent's own settings.
3. **A hard floor no rule can override** (see below).
4. **When unsure, do nothing.** If the command, the tool or the "Yes" option can't be parsed confidently, the
   prompt goes to you as it does today.
5. **Honest undo.** A command that ran can't be un-run. Undo means revoke or pause, and the log shows exactly
   what was run.
6. **Jev can only make autopilot more careful, never less.** Its risk rating can stop an auto-answer or strengthen
   a suggestion, but it never approves anything and never makes a rule. When Jev is off, over its daily cap or
   unsure, autopilot behaves exactly as described without it (§3a).

## Scope (v1)

- Only `kind: "prompt"` decisions (terminal permission and confirmation prompts) from Claude Code and Codex.
  OpenCode only if its prompts parse cleanly from fixtures.
- Not questions, not "done" reviews: those need judgment.
- Built-in rule: trust worktree folders the deck created itself (needed by Goals).

## Design

### 1. Reading the prompt (`src/autopilot.ts`, new)

```ts
type Ask = { agent: string; tool: "bash" | "edit" | "write" | "fetch" | "mcp" | "trust" | "other";
             subject: string;   // the command, the file path (relative to the repo), the MCP tool name, the folder
             root: string;      // mainRepoOf(checkoutOf(cwd)): a worktree matches its repo's rules
             machine: string;
             yes?: Option };    // the allow-once option, if identified
askFromPrompt(row: Row, d: Decision, screen: string[]): Ask | undefined
```

- Per-agent screen parsers read the block above the menu ("Bash command / `bun test` / Do you want to
  proceed?", "Edit file `src/x.ts`", Codex's "Would you like to run the following command? `$ …`").
  **The plan starts by capturing real prompts from the installed Claude Code and Codex versions as test
  fixtures.** Formats are never guessed.
- `yes` is the first option whose title starts with Yes, Allow or Proceed and does *not* mention "don't ask
  again", "always", "all" or "session". No such option: no autopilot.

### 2. Rules (`~/.config/herdr-deck/autopilot.json`)

```ts
type Rule = { id: string; machine: string; root: string; tool: Ask["tool"]; pattern: string;
              source: "learned" | "manual" | "builtin"; on: boolean; createdAt: number; lastUsedAt?: number; uses: number };
type AutopilotState = { on: boolean; pausedUntil?: number; rules: Rule[]; dismissed: string[] /* suggestion keys */ };
```

Matching:

- **bash:** `pattern` is a command prefix by whole words: `bun test` matches `bun test` and
  `bun test test/x.ts`, but not `bun testx`. **A command matches only if it's a single simple command**:
  anything with `&&`, `||`, `;`, `|`, `>`, `<`, `$(`, backticks or a line break never matches, whatever the
  rule says.
- **edit/write:** `pattern` is a folder prefix relative to the repo root (`src/`, or `` for the whole repo).
  The target must resolve inside the session's checkout.
- **mcp:** the exact tool name. **fetch:** the exact domain.
- **trust (built-in):** the folder is one the deck made with `createWorktree`.

The file is written atomically (temp file + rename). This spec pulls `discover.ts`'s `writeJson` out into a
shared `src/jsonfile.ts` so Goals can use it too.

### 3. The hard floor

`floor(ask)` returns a reason and always wins. It blocks: `rm` with `-r`/`-f`, `git push`,
`git reset --hard`, `git clean`, `git checkout -- .`/`git restore .`, `--force`/`-f` on git, `sudo`,
`curl`/`wget` piped anywhere, `chmod`/`chown`, `kill`/`pkill`, `launchctl`/`systemctl`, publish and deploy
commands (`npm publish`, `vercel`, `fly deploy`, …), SQL `DROP`/`DELETE`/`TRUNCATE`, any path outside the
session's checkout, and anything touching `.env*`, `~/.ssh`, `~/.aws`, keychains or `*.pem`/`*.key`. It's a
readable list in the code with a test for each entry.

### 3a. Jev as a brake

Every terminal permission prompt already gets a Jev risk rating when the risk feature is on
(`Decision.jev.risk`: `read_only` | `reversible` | `irreversible`, with its probability `riskP`, in
`src/decisions.ts`).

- **Brake:** if a rule matches but Jev rates the prompt `irreversible` with `riskP ≥ 0.5`, don't answer. The
  prompt goes to you as a normal prompt, and the card says why: "Autopilot held this: Jev rates it
  irreversible (0.82)". It's logged as `held` with the rule id.
- **Waiting for Jev:** Jev answers in about 0.3–0.5 s, inside the 2 s settle time below. If the rating is still
  `pending` then, wait up to 1 more second. If there's still no rating (Jev off, over its cap, failed, or
  `skipped`), treat it as no rating and continue as if Jev didn't exist.
- A `read_only` or `reversible` rating changes nothing: the rule decides. Jev never answers a prompt that has
  no matching rule.

### 4. Answering (hub, `src/server.ts`)

Decisions are already built on the hub for every machine (`rebuildDecisions`, with the screen fetched from the
right machine), so autopilot runs there, once:

1. After `rebuildDecisions`, for each new `prompt` decision: skip it if autopilot is off or paused, the session
   is opted out, `askFromPrompt` fails, the floor blocks it, or no rule matches.
2. Wait 2 s (up to 3 s while Jev's rating is pending, §3a), then rebuild that one decision. If its signature
   changed, stop. If the Jev brake applies, stop and log `held`. (The push alert's grace period is 5 s, so an
   auto-answered prompt never pushes. A held one alerts as usual.)
3. Send `yes.keys` through the same `/api/keys` path people use, so remote forwarding and recording behave
   the same way.
4. Append `{ at, ruleId, key, machine, project, agent, tool, subject, keys }` to
   `~/.config/herdr-deck/autopilot-log.jsonl`, bump `uses`/`lastUsedAt`, and broadcast.
5. If the same session gets the same prompt again within 60 s, three times in a row, stop answering it, turn
   the rule off for that session, and push "Autopilot stopped: <session> keeps asking <subject>". This catches
   loops.

If the hub is down, nothing is auto-answered: prompts wait as they do today.

### 5. Learning (`~/.config/herdr-deck/answers.jsonl`)

Today answers are only recorded through Jev (`recordOutcome`), and only when Jev ran. Add
`autopilot.learn(d, choice, via)` right next to both calls (server.ts: the `/api/send`/`/api/keys` block and
`/api/decide`). For prompt decisions it logs `{ at, machine, root, agent, tool, subject, choice: "yes" | "always" | "no" | "other", via, risk?, riskP? }`
(the Jev rating on screen at the time, when there was one).
It runs whether or not Jev is installed.

**Suggestions:** a candidate pattern is the tool plus the command's first word (or first two when the first is
a runner like `bun`, `npm`, `git`, `cargo`, `go`, `python`, `uv`) for bash, or the file's top folder for
edits. It's suggested when, in the last 30 days, you allowed it at least 3 times in that project, never
denied it, it passes the floor, and it isn't dismissed. Only yes and always count as allows. Suggestions
appear as a card at the top of the Inbox: "You've allowed `bun test` in herdr-deck 5 times. Let autopilot
allow it here?" with **Allow here** / **Not now** / **Never suggest**.

**Jev and suggestions.** Jev's ratings from the answer log only ever add to or hold back a suggestion. They
never create a rule:

- **Strong suggestion:** allowed 10 or more times (and never denied) and the latest Jev rating is `read_only`
  with `riskP ≥ 0.9`. The card goes first and shows why: "Allowed 12 times · Jev: read-only (0.94). Make this a
  rule?"
- **Held back:** if any logged ask for the pattern was rated `irreversible` at 0.5 or above, don't suggest it.
  A rule can still be made by hand through "Always allow here…", and the brake in §3a still applies to it.
- With no Jev ratings, suggestions follow the basic threshold above, unchanged.

**Manual:** every prompt card in the Inbox gets a quiet "Always allow here…" link that opens the rule prefilled
from this prompt, with an editable pattern and the floor check shown live.

### 6. UI

New client code goes in `public/js/autopilot.js` (listed in `public/assets.json`, under 400 lines), not
`app.js`. `app.js` only gets the small hooks it needs (a row badge, the Inbox header slot).

- **Row and board:** a small "auto" badge with a count when autopilot answered in that session in the last
  hour. Tapping it shows those entries.
- **Inbox header:** an Autopilot switch ("on · 12 rules · 34 answers today"), plus **Pause 1 h** and
  **Pause until tomorrow**. Also in ⌘K and on the phone.
- **Settings → Autopilot…:** rules grouped by machine and project (toggle, edit pattern, delete, uses, last
  used), the last 100 log entries, and per-session opt-outs.
- The session menu gets "Never autopilot this session".

## Testing

- `test/autopilot.test.ts`: `askFromPrompt` on the captured fixtures (Claude bash, edit and MCP, Codex command,
  the trust prompt); picking `yes` (skipping "don't ask again"); rule matching (prefix by words, compound
  commands never match, edits outside the checkout); every floor entry; the suggestion threshold (3 allows, 0
  denies, the 30-day window, dismissed); loop cut-off.
- Jev: the brake holds at `irreversible ≥ 0.5` and not at 0.49; `read_only`/`reversible` don't change a
  decision; `pending` waits at most 1 s, then carries on with no rating; `skipped`/off/over the cap behaves
  exactly like no Jev; strong suggestions (10+ allows, `read_only ≥ 0.9`); a suggestion held back by any
  irreversible rating; Jev never answers a prompt that has no rule.
- The engine takes `rows()`, `decision()`, `sendKeys()`, `now()` and a file directory as dependencies, so it's
  tested like `Automations`, with no live deck.
