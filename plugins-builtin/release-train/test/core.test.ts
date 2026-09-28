// Release train's pure logic: checking a project, reading git log output, the deploy brief.
import { expect, test } from "bun:test";
import { checkProject, isPattern, LOG_FORMAT, parseLog, promoteBrief } from "../release-core";

const base = { name: "Dialer", repo: "~/work/dialer", stages: [{ name: "QA", ref: "qa" }, { name: "Staging", ref: "origin/staging", health: "https://s.example/health" }, { name: "Prod", ref: "v*", deploy: "make deploy-prod" }] };

test("checkProject: names, safe refs, http health, 2–6 stages, agent default", () => {
  const p = checkProject(base);
  expect(p).toMatchObject({ id: "dialer", agent: "codex", stages: [{ ref: "qa" }, { ref: "origin/staging", health: "https://s.example/health" }, { ref: "v*", deploy: "make deploy-prod" }] });
  expect(() => checkProject({ ...base, name: "" })).toThrow("name");
  expect(() => checkProject({ ...base, stages: [{ name: "QA", ref: "--exec=x" }, { name: "B", ref: "b" }] })).toThrow("isn’t a branch");
  expect(() => checkProject({ ...base, stages: [{ name: "QA", ref: "qa", health: "file:///etc/passwd" }, { name: "B", ref: "b" }] })).toThrow("http");
  expect(() => checkProject({ ...base, stages: [{ name: "QA", ref: "qa" }] })).toThrow("2 to 6");
  expect(isPattern("v*")).toBe(true);
});

test("parseLog reads the fields and skips junk", () => {
  const line = ["a".repeat(40), "aaaaaaa", "Fix hold bug", "Dana", "1700000000"].join("\x1f");
  expect(LOG_FORMAT.split("\x1f")).toHaveLength(5);
  expect(parseLog(`${line}\nwarning: x\n`)).toEqual([{ sha: "a".repeat(40), short: "aaaaaaa", subject: "Fix hold bug", author: "Dana", at: 1700000000000 }]);
});

test("the brief lists the commits, the deploy step, the checks after, and says to ask first", () => {
  const p = checkProject(base);
  const c = (n: number) => ({ sha: String(n).repeat(40).slice(0, 40), short: `c${n}`, subject: `change ${n}`, author: "Dana", at: 0 });
  const b = promoteBrief({ project: p, from: p.stages[1], to: p.stages[2], fromHead: c(1), commits: [c(1), c(2)], more: 3 });
  expect(b).toStartWith("Promote Dialer from Staging to Prod.");
  expect(b).toContain("5 commits go out:\n- c1 change 1 (Dana)\n- c2 change 2 (Dana)\n…and 3 more");
  expect(b).toContain("`make deploy-prod`");
  expect(b).toContain("stop to ask me if anything looks risky");
  const q = promoteBrief({ project: p, from: p.stages[0], to: p.stages[1], commits: [], more: 0 });
  expect(q).toContain("No commits are waiting");
  expect(q).toContain("There is no deploy command set for Staging");
  expect(q).toContain("check https://s.example/health answers");
});
