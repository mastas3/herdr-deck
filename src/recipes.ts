// Recipes: reusable prompts sent to one or many sessions. Stored as editable JSON.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export type Recipe = { id: string; label: string; prompt: string; hint?: string; agents?: string[] };

const FILE = `${homedir()}/.config/herdr-deck/recipes.json`;

export const DEFAULT_RECIPES: Recipe[] = [
  { id: "status", label: "Status in one line", hint: "What are you doing, what's left?", prompt: "In one or two lines: what are you working on right now, and what's left before it's done?" },
  { id: "test", label: "Run tests & report", hint: "Honest pass/fail summary", prompt: "Run this project's tests, typecheck and build now. Report honestly: what passed, what failed (with the key error lines), and anything you couldn't run." },
  { id: "review", label: "Review your diff", hint: "Bugs, leftovers, edge cases", prompt: "Review your uncommitted diff (git diff) for bugs, leftover debug code and missed edge cases. Fix what's clearly wrong, then list anything you're unsure about." },
  { id: "commit", label: "Commit the finished work", hint: "Clear message, nothing unrelated", prompt: "Commit the finished, verified work on {branch} with a clear message. Leave unrelated or unfinished changes out and tell me what you left out." },
  { id: "handoff", label: "Write a handoff note", hint: "Saved as HANDOFF.md", prompt: "Write a short handoff note in HANDOFF.md at the repo root: the goal, what's done, what's left, how to verify, and gotchas. Keep it under 40 lines." },
  { id: "wrap", label: "Wrap up", hint: "Finish, verify, summarise, stop", prompt: "Finish the step you're on, verify it actually works, then stop and summarise what changed and what remains." },
  { id: "unstick", label: "Step back", hint: "For a session going in circles", prompt: "You seem to be repeating attempts. Stop, list what you've tried and what each result showed, name the most likely root cause, and propose one different next step before doing anything." },
  { id: "continue", label: "Continue", prompt: "Continue." },
  { id: "compact", label: "Compact context", hint: "Claude's /compact", prompt: "/compact", agents: ["claude"] },
];

export function loadRecipes(): Recipe[] {
  try {
    if (existsSync(FILE)) {
      const r = JSON.parse(readFileSync(FILE, "utf8"));
      if (Array.isArray(r)) return r.filter((x) => x && typeof x.id === "string" && typeof x.prompt === "string" && typeof x.label === "string");
    }
  } catch {}
  return DEFAULT_RECIPES;
}

export function saveRecipes(list: Recipe[]) {
  const clean = list
    .filter((x) => x && String(x.label ?? "").trim() && String(x.prompt ?? "").trim())
    .slice(0, 60)
    .map((x, i) => ({
      id: String(x.id || `r${Date.now().toString(36)}${i}`).replace(/[^\w-]/g, "").slice(0, 40) || `r${i}`,
      label: String(x.label).trim().slice(0, 60),
      prompt: String(x.prompt).trim().slice(0, 4000),
      ...(x.hint ? { hint: String(x.hint).trim().slice(0, 80) } : {}),
      ...(Array.isArray(x.agents) && x.agents.length ? { agents: x.agents.map(String) } : {}),
    }));
  writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

/** Fills {project}, {branch}, {title} from the session the recipe is sent to. */
export function fillRecipe(prompt: string, row: { project?: string; branch?: string; title?: string }) {
  return prompt
    .replaceAll("{project}", row.project ?? "this project")
    .replaceAll("{branch}", row.branch ?? "the current branch")
    .replaceAll("{title}", row.title ?? "this task");
}
