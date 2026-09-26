// A stand-in for the jev kit module (~/.local/share/jev-kit/bin/jev.mjs) with just what the deck imports,
// so the in-process transport tests run everywhere, CI included. The checks follow the kit's contract.
// The key comes from TYPESAFE_API_KEY only: never a file.
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isProb = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
class JevError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

export function deepRedact(value) {
  if (typeof value === "string") return value.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]");
  if (Array.isArray(value)) return value.map(deepRedact);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /(?:^|[_-])(secret|api[_-]?key|token|password)(?:$|[_-])/i.test(k) ? "[REDACTED]" : deepRedact(v)]));
  return value;
}

export function resolveKey() {
  const key = (process.env.TYPESAFE_API_KEY || "").trim();
  return key ? { key, source: "env:TYPESAFE_API_KEY", path: null, problem: null } : { key: null, source: null, path: null, problem: "no key found" };
}

export function validateQuestions(questions) {
  const bad = (why) => { throw new JevError("invalid_input", { why }); };
  if (!isObject(questions) || !Object.keys(questions).length) bad("questions must be a non-empty object");
  for (const [id, q] of Object.entries(questions)) {
    if (!ID_RE.test(id)) bad(`bad question id ${id}`);
    if (!isObject(q) || !["noul", "choice", "score"].includes(q.type) || !q.instructions) bad(`bad question ${id}`);
    if (q.type === "choice" && (!isObject(q.criteria) || Object.keys(q.criteria).length < 2)) bad(`choice ${id} needs >=2 criteria`);
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) bad(`score ${id} needs 2-10 levels`);
  }
}

const sumsToOne = (probs, keys) => isObject(probs) && Object.keys(probs).length === keys.length && keys.every((k) => isProb(probs[k])) && Math.abs(keys.reduce((s, k) => s + probs[k], 0) - 1) <= 0.01;
export function validateAnswers(questions, body, model) {
  const bad = (why) => { throw new JevError("invalid_response", { why }); };
  if (!isObject(body) || typeof body.model !== "string") bad("missing model");
  if (body.model !== model) bad(`model mismatch: ${body.model}`);
  if (!isObject(body.answers)) bad("missing answers");
  for (const [id, q] of Object.entries(questions)) {
    const a = body.answers[id];
    if (!isObject(a) || a.type !== q.type) bad(`answer ${id} missing or wrong type`);
    if (q.type === "noul" && !isProb(a.noul)) bad(`answer ${id} noul`);
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (!keys.includes(a.choice) || !sumsToOne(a.probabilities, keys) || !isProb(a.confidence)) bad(`answer ${id} choice`);
    }
    if (q.type === "score" && (!sumsToOne(a.probabilities, q.criteria.map((_, i) => String(i))) || !isProb(a.confidence))) bad(`answer ${id} score`);
  }
  return body;
}
