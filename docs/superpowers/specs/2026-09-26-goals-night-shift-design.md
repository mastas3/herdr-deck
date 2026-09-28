# Goals and Night shift

Status: draft for review · 2026-09-26 · Spec 3 of 3. Needs worktrees (spec 1) and autopilot (spec 2).
Two milestones: **A. Goals** (run now), then **B. Night shift** (run later, within plan limits).

## Why

The deck manages sessions, but what you care about is outcomes. Today turning "ship offline mode" into
parallel agents means: plan it, open N tabs, make worktrees, paste prompts, watch each one, re-run tests, send
failures back, merge. A **goal** makes that one flow: you state the outcome, a planner agent splits it into
tasks, you approve the plan, and the deck runs each task in its own worktree, checks it, and brings back
branches ready to merge. **Night shift** runs goals while you sleep, within your Claude and Codex limits, with
a morning digest.

## Success

- From "New goal" to tasks running is under a minute of your time: type the outcome, skim the plan, approve.
- Every finished task has a branch and either a passing check or a clear "unverified" or "failed" mark.
- A night goal queued at 23:00 has, by 07:30, a digest saying what finished, what failed, what's stuck on
  which prompt, and what's waiting on limits. No session was blocked all night on a prompt autopilot could have
  answered.
- The deck never merges, pushes, or uses bypass-permission modes on its own.

## Non-goals (v1)

Automatic merge to main or push; goals spanning several repos (one repo per goal in v1); a task depending on
more than one other task; cost accounting beyond what rows already show.

## Model (`~/.config/herdr-deck/goals/<id>.json`, written atomically)

```ts
type Goal = {
  id: string; slug: string; title: string;
  outcome: string;        // what you typed
  done: string;           // definition of done (planner proposes, you can edit)
  machine: string; repo: string; base: string;      // one repo per goal; base branch/commit
  when: "now" | "night";
  status: "planning" | "plan-ready" | "queued" | "running" | "integrating" | "ready" | "stopped" | "failed";
  planner?: { sessionKey: string; sessionId?: string; agent: string };
  tasks: Task[];
  integration?: Task;     // added automatically once every task is ready
  createdAt: number; log: { at: number; text: string }[];
};
type Task = {
  id: string; title: string; prompt: string;
  agent: "claude" | "codex" | "either"; model?: string; effort?: string;
  after?: string;         // one task id: branch from its branch, start when it's ready
  status: "queued" | "starting" | "running" | "checking" | "ready" | "unverified" | "failed" | "blocked" | "paused-limit" | "lost" | "cancelled";
  worktree?: string; branch?: string;      // goal/<slug>/<task-id>
  sessionKey?: string; sessionId?: string; agentUsed?: string;
  attempts: number;       // send-backs after failed checks (max 2)
  check?: { state: string; cmd?: string; tail?: string[] };
  resumeAt?: number; startedAt?: number; endedAt?: number; note?: string;
};
```

Sessions are re-found after a deck restart by `machine + sessionId`, not by row key.

## Milestone A: Goals

### A1. Planning

New goal dialog: outcome, repo (the project list), machine, when (now or tonight), planner agent. The deck
starts a **read-only planner session** in the repo: Claude with `--permission-mode plan`, Codex with
`-s read-only`. The fixed prompt says: explore, don't implement; split the work into 2–8 tasks that can each
be done on its own in its own worktree off `<base>` in under about an hour; a task may name one task it must
come after; propose a definition of done; **end your final message with one fenced block tagged `goal-plan`**
containing JSON matching this schema (inlined in the prompt).

When the planner's turn ends, `parsePlan(text)` reads the last `goal-plan` block from the transcript and checks
it: 2–8 tasks, unique ids, `after` pointing at a real task with no cycles, a non-empty prompt. If it's invalid,
the deck sends one follow-up with the errors. If it's still invalid, the goal goes to `failed`, which means
"planning failed: open the planner". The planner writes no files, so it's safe in plan mode.

**Plan review (you):** the Goals view shows the plan. You can edit titles, prompts and agents, delete tasks, and
edit the definition of done, then **Approve** (→ `queued`) or **Ask the planner to change it** (sends your note
and waits for a new block).

### A2. Running tasks (`src/goals.ts` + a pure scheduler)

- `nextActions(goals, rows, limits, settings, now) → Action[]` is pure and runs every 15 s on the hub. Actions:
  `start`, `check`, `sendBack`, `resume`, `markLost`, `integrate`.
- **start:** `createWorktree(repo, "<goal-slug>-<task-id>", base or the `after` task's branch)` on branch
  `goal/<slug>/<task-id>`, then `startSession` in it with the task prompt plus a fixed footer: "You're one task
  of a larger goal (<title>). Stay within this task. Commit your work on this branch when done. Don't push,
  don't merge, and don't touch other branches or worktrees." Claude starts with `acceptEdits`, Codex with
  `-s workspace-write`. **Never bypass modes.** The worktree trust prompt is answered by autopilot's built-in
  trust rule. Remote machines use the existing forwarding to `/api/new`.
- **Done:** the task's row reports `done` and its turn is over, so the deck runs proof of done in the
  worktree. Approvals resolve through `mainRepoOf`, so a repo approved once covers all its worktrees; a repo
  never approved asks you once. **Pass** → `ready`. **Fail** → `sendBack` with the last 40 lines ("The check
  `<cmd>` failed. Fix it, then commit."), up to 2 times, then `failed`. **No check found** → `unverified`.
- **Blocked:** the row sits `blocked` for more than 20 minutes (autopilot didn't handle it) → `blocked`, with
  the prompt text saved in `note`. It doesn't take up a running slot.
- **Limit hit mid-task:** the last message matches the agent's usage-limit wording (captured as fixtures, like
  autopilot's) → `paused-limit` with `resumeAt` = the reset time from `usage()` + 2 min. Then `resume` sends
  "Continue where you left off."
- **Session closed or gone** → `lost`, which offers **Re-run** (a fresh worktree) or **Resume** (the existing
  resume path).
- **Concurrency:** at most `maxRunning` (default 2) running tasks per machine, across goals.

### A3. Integration

When every task is `ready` or `unverified`, the scheduler adds an **integration task**: a new worktree on
`goal/<slug>` from `base`, with the prompt "merge these branches in this order: …, resolve conflicts,
run `<check>`, commit, and report what each branch did." Its check result is the goal's proof. Then the goal
is `ready` and shows the branch, a diff stat against `base`, the check result, and **Copy merge command**,
**Open integration session** and, after you've merged, **Clean up worktrees** (removes clean worktrees and
the `goal/<slug>/*` branches, and confirms first). The deck never merges into your base branch itself.

### A4. UI

Client code goes in `public/js/goals*.js` (listed in `public/assets.json`, each file under 400 lines, split like
`gallery-*.js`). `app.js` only gets the view registration and the row chip hook.

- A **Goals** view (key `w` — `o` already opens a card in the Inbox; in the view list next to Inbox, History and Discover, and in ⌘K): goal cards with
  title, status, a progress bar by task state, and "next: …" text. Opening one shows the definition of done,
  the plan or task list (each task links to its session, branch and check), and the goal log.
- Rows get a small goal chip ("◎ offline-mode · 2/5"), and the list can group by goal (a third grouping next
  to priority and project).
- Stop goal: cancels queued tasks, sends Esc to running ones, and keeps worktrees.
- Works on the phone: Goals is a list, and a goal opens full screen, like a session.

## Milestone B: Night shift

### B1. When

`when: "night"` goals only start tasks inside the **night window** (default 23:30–07:00 local; Settings →
Night shift). `now` goals ignore the window. Tasks already running are never interrupted when the window ends.
New ones simply stop starting.

### B2. Limits (`usage()` in `src/connections.ts`)

Before starting or resuming a task, `pickAgent(task, limits, settings)`:

- Claude is usable if 5-hour use is under 85% and weekly under 90% (both settings). The same for Codex's
  primary and secondary windows.
- `agent: "either"` takes whichever is usable, preferring the one with more room.
- Neither usable → `wait until` the earliest reset (this shows in the goal: "waiting for Claude limits, resets
  02:40").
- Limit data older than 2 hours with nothing running counts as unknown: start **one** task, then read again.

### B3. Staying awake and quiet

- While a night goal has queued or running tasks inside the window, the hub holds a sleep lock: macOS
  `caffeinate -i -w <deck pid>`, Linux `systemd-inhibit --what=idle:sleep` if present. It's released as soon
  as nothing is left. Night shift shows a warning if the Mac is on battery (`pmset -g batt`) or the lid-closed
  case applies ("keep it plugged in with the lid open").
- Push alerts for night-goal sessions are held during the window (so is the "needs you" push). Everything goes
  into the digest. One exception: the hard-stop push "Night shift stopped: <reason>" (the deck is failing to
  start sessions or create worktrees).

### B4. Morning digest (`buildDigest` in `src/automations.ts`)

A **Night shift** section above waiting/finished/running/idle. Per goal: ready tasks (branch + check),
failed (last lines), blocked (on which prompt, with a one-tap answer via the Inbox), waiting for limits (with
the reset time), and not started. The integration status comes first when it exists. Delivered as today (push
+ digest card), at the digest time.

## Errors

- Worktree creation fails → the task is `failed` with git's message. Other tasks continue.
- The planner or a task session can't be started (herdr down, the node unreachable) → retried with backoff
  (1, 5, 15 min). Three failures → the goal is `stopped` with the hard-stop push.
- Deck restart: goals load from disk, sessions are re-found by `sessionId`, a missing one is `lost`, and the
  sleep lock is taken again if needed.

## Testing

- `test/goals-plan.test.ts`: `parsePlan` (valid, several blocks so the last one wins, bad JSON, cycles, bad
  `after`, too many or too few tasks).
- `test/goals-scheduler.test.ts`: `nextActions` with synthetic goals and rows and a fake clock: concurrency
  per machine, `after` ordering, done → check → ready / send-back / failed, blocked after 20 min not holding a
  slot, lost sessions, integration being added once, the night window, limit picking and waiting, stale limits
  allowing one probe.
- `test/automations.test.ts`: digest with the night-shift section; alerts held for night-goal sessions.
- Limit-hit detection on captured fixtures.
