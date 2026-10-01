"use strict";
// A pane can be reused for a different agent. Keep the entire identity, never fall back to another session.
function aetherIdentity(r) {
  return r?.sessionId && !r.hist ? { key: r.key, sessionId: r.sessionId, machine: r.machine, agent: r.agent, cwd: r.cwd, project: r.project } : null;
}
function aetherMatches(r, target) {
  return !!target && !!aetherIdentity(r) && ["key", "sessionId", "machine", "agent", "cwd", "project"].every((k) => r[k] === target[k]);
}
function aetherStatus(r, connected) {
  if (!r) return { kind: "missing", label: "Session unavailable", story: "This island is keeping its place. Choose an available session to continue." };
  if (!connected) return { kind: "offline", label: "Disconnected", story: "The island is resting. Reconnect to see what changed." };
  const states = {
    working: ["working", "Working", "Aether is tending the garden. Work is moving forward."],
    blocked: ["blocked", "Needs you", "The workshop is sleeping. Your agent is waiting for input."],
    done: ["done", "Turn complete", "The garden has bloomed. Read what your agent finished."],
    idle: ["idle", "Resting", "Aether is resting beside the workshop, ready for your next reply."],
  };
  const [kind, label, story] = states[r.status] || ["idle", "Status unknown", "Open the conversation to check on your agent."];
  return { kind, label, story };
}
function aetherEntries(messages) {
  return (messages || []).filter((m) => ["assistant", "user"].includes(m.role) && typeof m.text === "string" && m.text.trim()).slice(-6);
}
function aetherTime(at) {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
