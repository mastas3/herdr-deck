# Model picker: provider and model comboboxes on every model choice

Date: 2026-09-29 · Status: design approved by the user in chat (2026-09-29), written spec awaiting review

## Why

The deck lets you choose a model in four places, and each one is a different plain control. New session has a text box
with a `<datalist>` and one chip. Codex task settings, Research and Studio each have a `<select>`. OpenCode is
connected to four providers with 998 models between them (nano-gpt 602, openrouter 385, opencode 8, abliteration-ai
3), and today they are one flat, unlabelled list you can only search by typing a raw `provider/model` ID.

The user asked to show **every provider OpenCode is connected to, with its models**, in beautiful searchable
comboboxes, and to give the **other AI providers the deck has** the same comboboxes.

## Decisions (user, 2026-09-29)

| Question | Decision |
|---|---|
| How far does it go? | **Pickers only.** Studio, Research and the Mixer still run only Claude Code and Ollama. OpenCode as a headless engine is out of scope. |
| Layout | **Linked Provider + Model** comboboxes: pick a provider (with its model count), then search only its models. An "All providers" entry searches everything. A provider with one choice (Claude, Codex) shows as a fixed label. |
| Screens | New session dialog, Codex task settings, Research, Studio engine. |
| Row details | Name, raw model ID, context window, price or a Free badge, reasoning badge. |
| Recents | The **last 5 used** models are pinned as a "Recent" group at the top, kept per browser. |
| Custom IDs | A **"Use 'x'"** row lets you type an ID that is not listed, **only where the server takes any ID** (see "Screens"). |
| Phone | The open list is a **bottom sheet**. |

## Non-goals

- Running Studio, Research or the Mixer on OpenCode models (a new runner in `src/model-run.ts`).
- Logging in to a provider from the deck (`opencode providers login` stays in the terminal).
- Agents with no model list today (Gemini, Cursor, Copilot and the rest): New session keeps whatever it shows for them.
- Any change to what is sent to an agent. Values keep their current form, so saved preferences (`opts:<kind>`) still work.

## Catalog (server): `src/model-catalog.ts`

Feeds New session for `claude`, `codex` and `opencode`. The other three screens already have their models in their own
payloads and build the same shape in their page code, so **core never imports plugin code**.

Shape (the same on the server and in every page adapter):

```
Provider = { id, label, models: Model[], off? }
Model    = { v, l?, ctx?, price?: { in, out }, free?, reasoning?, efforts?: string[], note? }
```

- `note` (a short label such as "private") and `off` (a reason the provider cannot be chosen) are set only by page code.
- `v` is exactly what the agent gets today: `fable` for Claude, a Codex slug, `provider/model` for OpenCode.
- **OpenCode:** run `opencode models --verbose` and group by `providerID`. The output is one `provider/model` line at
  column 0 followed by a pretty-printed JSON object, 998 records in about 1.1 MB, and it takes about 1.8 s (plain
  `opencode models` is about 1 s). Only providers OpenCode is connected to are listed, so "connected" needs no extra
  check. Fields used: `name`, `limit.context`, `cost.input` and `cost.output` (USD per million tokens; a Claude Sonnet
  4.5 record reads 3 and 15), `capabilities.reasoning`. `free` is both costs being 0. Provider labels come from a small
  map (`openrouter` → OpenRouter, `nano-gpt` → NanoGPT, `opencode` → OpenCode Zen, `abliteration-ai` →
  abliteration.ai) and fall back to the ID with dashes turned into spaces.
- **IDs:** a line is a model ID when it has no spaces and contains a `/`. Today's filter (`^[\w.-]+\/[\w.:/@-]+$`) drops
  238 of the 998 models, all OpenRouter's `~anthropic/…-latest` style aliases, so this is also a fix.
- **Cache:** kept in memory for 10 minutes, and once it is stale the old list is served while a background refresh runs,
  so opening the dialog never waits 1.8 s. The first call after startup is started from `server.ts`'s startup order
  (the `create*` factories build functions only). The process is spawned, never run inline, with the existing 15 s
  timeout.
- **Fallbacks:** if verbose fails or does not parse, use plain `opencode models` IDs with no details. If OpenCode is
  missing or times out, return an empty provider list plus a short reason string the page can show.
- **Claude:** one provider, Anthropic, with the four aliases the dialog has now (`fable`, `opus`, `sonnet`, `haiku`).
- **Codex:** one provider, OpenAI, from `~/.codex/models_cache.json` with each model's reasoning efforts, as
  `codexChoices()` reads it today.
- **API:** `/api/new-options` keeps `choices.<kind>.models` (flat, unchanged) and adds `choices.<kind>.providers`.

## Component (page): `public/js/model-search.js`, `public/js/model-picker.js`, `public/css/model-picker.css`

New core files, each under 400 lines, listed in `public/assets.json` (the scripts after `js/format.js` so every screen
can use them, the stylesheet after `css/menus.css` so `phone.css` can override it). No dependencies, no build step, and
top-level names prefixed `mp`/`model` so `test/assets.test.ts` finds no clash.

- `model-search.js` is pure (no DOM): `modelSearch`, `modelMarks`, `modelRecent` and the row formatters. Tests run the
  whole file through `new Function`.
- `model-picker.js` is the DOM part. Three of the four screens rebuild their markup with `innerHTML` (Studio's bar is
  re-patched by `mixPatch`), so the picker is a registry plus a string, not a mounted widget:
  `modelPickerSet(id, { providers, value, onChange, allowCustom, allowDefault, recentKey, hint })` registers or updates
  a picker, `modelPickerHTML(id)` returns its markup (the Provider and Model buttons), and one delegated listener on
  `document` opens the list. When you choose, the picker updates its own buttons in place and calls `onChange(value)`;
  the screen does what it did before. `modelPickerMount(el, id)` draws one into a screen's slot and redraws in place (keeping keyboard focus) when it is
  already there, `modelPickerPick(id, v)` chooses a value as a user would, and `modelPickerValue(id)` and
  `modelPickerDrop(id)` read and remove one.
- The open list is a `popover="auto"` element (top layer) appended inside the trigger's closest `<dialog>`, or the
  body, so it is not clipped by a scrolling dialog and is not inert inside a modal one.

- **Behaviour:** the ARIA combobox pattern (`role="combobox"`, `listbox`, `option`, `aria-activedescendant`). ↑ ↓
  move, Home and End jump, Enter picks, Esc closes and restores the shown value, typing filters. Choosing a provider
  moves focus to Model. "All providers" shows the provider next to each result.
- **Search:** a pure function `modelSearch(models, query)`. Every word of the query must match the name or the ID.
  Ranking: name prefix first, then a word-start match, then an ID substring last. The matched text is highlighted.
- **Speed:** at most 60 rows are drawn, with an "N more, keep typing" footer, so 998 models stay instant.
- **Rows:** the name, the raw ID in a small mono font, and badges for context (`200k`, `1M`), price (`$3 / $15`) or Free,
  and Reasoning (with efforts where the agent has them). A missing detail is skipped, never shown as a blank.
- **Recent:** the last 5 chosen values, per picker, stored in `localStorage` under `recentKey` (read and written in
  try/catch, and the picker works without it). They show as a "Recent" group above the results when the query is empty.
- **Custom:** with `allowCustom`, a "Use 'x'" row appears when the query matches no ID exactly.
- **Default:** with `allowDefault`, a first "Default" row means "the agent's own default" (the empty string).
- **Look:** colours, radii and type come from `css/tokens.css`, so light and dark both work. Selected and hover rows follow
  the deck's existing menu styling. Motion respects `prefers-reduced-motion`.
- **Phone:** at phone width the open list is a bottom sheet with a 16px search field (so iOS does not zoom) and rows of
  at least 44px. It sits above the keyboard, closes by tapping the scrim, and stays in the visible viewport.
- **One provider:** the Provider button is replaced by a plain label, so Claude and Codex look like part of the same family.
- **Provider change:** picking a provider only filters the Model list (which opens straight away); the value changes only when
  a model is chosen, so dismissing the list never discards a choice. The Provider button shows the provider of the current
  value.

## Screens

Each screen keeps its state and its API. Only the control changes.

| Screen | Today | Change | Custom IDs |
|---|---|---|---|
| New session (`public/js/new-session.js`, `index.html`) | `nModel` input, `nModelList` datalist, `nModelSugg` chips | the picker per agent kind; `renderCmd` and the `opts:<kind>` storage are unchanged | **Yes**, the server passes `-m` through |
| Codex task settings (`public/js/codex-task-actions.js`) | `<select name="model">` | the picker (provider OpenAI); the effort list still follows the chosen model | **No**, the server rejects a model outside the installed list; the task's current model stays listed |
| Research (`plugins-builtin/research/research.js`) | `<select name="model">` (Default, Sonnet, Opus) | the picker (provider Anthropic; Default, Sonnet, Opus, Haiku, Fable) | **No**, the server accepts only `sonnet`, `opus`, `haiku`, `fable` or empty |
| Studio engine (`plugins-builtin/discover/js/studio.js`) | `<select data-steng>` | the picker with providers Claude (Haiku, Sonnet), Ollama (installed models, marked private) and Templates; values stay `claude:haiku`, `ollama:<x>`, `template` | **No** |

Studio disables a Claude engine when Claude Code is not installed, and the picker keeps that: the provider shows as
unavailable with the reason, and its models cannot be chosen.

## Errors and edge cases

- OpenCode missing, slow or empty: the New session provider box shows a short hint, and typing an ID still works.
- A saved model that is no longer listed: shown as a custom value with a "not in the list" note, never silently reset.
- A provider with no models: dimmed, with "No models".
- A search with no match: "Nothing matches" and, where allowed, the "Use 'x'" row.
- A remote machine's dialog: options come from that machine's `/api/new-options` through the existing forwarding, so the
  list is the remote's own OpenCode.

## Tests and verification

- `test/model-catalog.test.ts`: the verbose parser (grouping, labels, price units, Free, missing fields), the fallback to
  plain IDs, the empty result when OpenCode is missing, and the stale-while-revalidate cache with an injected runner.
- `test/model-picker.test.ts`: `modelSearch` (ranking, word starts, the 60-row cap), `modelMarks` (highlights and escaping),
  `modelRecent` and the row formatters. `model-search.js` is pure, so the test runs the whole file through `new Function`,
  as `test/keymap.test.ts` does with a block of `keymap.js`.
- `bun test` (also checks file sizes and name clashes) must pass before the commit.
- `bin/ui-snapshot.mjs` before and after: New session, Codex settings, Research and Studio on desktop and phone, with
  `bin/ui-compare.mjs` showing only the intended differences and zero page errors.
- A real click-through on an isolated test deck on port 4799 (see the "Test deck isolation" memory), against this
  machine's real OpenCode: pick a provider, search, pick a model, and check the command preview and a started session.
- Keyboard-only and screen-reader labels checked on the combobox.

## Files

- New: `src/model-catalog.ts`, `public/js/model-search.js`, `public/js/model-picker.js`, `public/css/model-picker.css`,
  `test/model-catalog.test.ts`, `test/model-picker.test.ts`.
- Changed: `src/http/new-session.ts` (uses the catalog), `public/assets.json`, `public/index.html`,
  `public/js/new-session.js`, `public/js/codex-task-actions.js`, `plugins-builtin/research/research.js`,
  `plugins-builtin/discover/js/studio.js`, `plugins-builtin/discover/js/studio-actions.js`,
  `plugins-builtin/discover/css/studio.css`, `bin/ui-snapshot.mjs` (new views), and `public/css/menus.css` where the old
  chips and `select` styles go.
