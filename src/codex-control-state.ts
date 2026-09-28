export type CodexControlState = {
  ready: boolean; error?: string; status?: string; activeTurnId?: string; model?: string; effort?: string;
  requests: { id: string | number; method: string; params: any }[];
};

// Desktop snapshots use Immer patches. Reject unsafe paths and gaps instead of acting on stale state.
export function applyCodexPatches(state: any, patches: any[]) {
  for (const p of patches) {
    if (!Array.isArray(p.path) || !["add", "replace", "remove"].includes(p.op)) throw new Error("Unsupported Codex patch");
    if (p.path.some((k: any) => (typeof k !== "string" && typeof k !== "number") || ["__proto__", "prototype", "constructor"].includes(k))) throw new Error("Unsafe Codex patch");
    if (!p.path.length) { if (p.op === "remove") throw new Error("Invalid root patch"); state = p.value; continue; }
    let parent = state;
    for (const k of p.path.slice(0, -1)) {
      if (parent == null || !Object.hasOwn(parent, k)) throw new Error("Missing Codex patch parent");
      parent = parent[k];
    }
    if (!parent || typeof parent !== "object") throw new Error("Invalid Codex patch parent");
    const key = p.path.at(-1);
    if (Array.isArray(parent) && key !== "length") {
      if (!Number.isInteger(key) || key < 0 || key > parent.length) throw new Error("Invalid Codex array patch");
      if (p.op === "add") parent.splice(key, 0, p.value);
      else if (p.op === "remove") parent.splice(key, 1);
      else parent[key] = p.value;
    } else if (p.op === "remove") delete parent[key];
    else parent[key] = p.value;
  }
  return state;
}

export function codexControlState(state: any): CodexControlState {
  const turns: any[] = state.turnHistory?.kind === "canonical"
    ? Object.values(state.turnHistory.history?.entitiesByKey ?? {}) : state.turns ?? [];
  const active = turns.filter((t) => t.status === "inProgress").at(-1);
  const requests = (state.requests ?? []).filter((r: any) => r && (typeof r.id === "string" || typeof r.id === "number") && typeof r.method === "string")
    .map((r: any) => {
      const item = turns.flatMap((t) => t.items ?? []).find((i: any) => i.id === r.params?.itemId);
      return { id: r.id, method: r.method, params: { ...(item?.command ? { command: item.command } : {}), ...(item?.changes ? { changes: item.changes } : {}), ...r.params } };
    });
  // Async questions are assistant items, not blocking JSON-RPC requests. Reply through the normal turn path.
  const items = [...turns].sort((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0)).flatMap((t) => t.items ?? []);
  let question: any;
  for (const item of items) {
    if (item.type === "userMessage" || item.type === "steeringUserMessage") question = undefined;
    if (item.type === "agentMessage" && item.questions?.length) question = item;
  }
  if (question) requests.push({ id: `async:${question.id}`, method: "deck/asyncQuestion", params: {
    questions: question.questions.map((q: any, i: number) => ({ id: `q${i}`, question: q.title, options: q.options?.map((label: string) => ({ label })), isOther: true })),
  } });
  const busy = state.threadRuntimeStatus?.type === "active" || !!active;
  const blocked = requests.some((r: any) => r.params.isBlocking !== false) || state.threadRuntimeStatus?.activeFlags?.some((f: string) => /waiting/i.test(f));
  return { ready: true, requests, status: blocked ? "blocked" : busy ? "working" : "idle",
    activeTurnId: active?.turnId, model: state.latestModel || undefined, effort: state.latestReasoningEffort || state.latestThreadSettings?.effort || undefined };
}
