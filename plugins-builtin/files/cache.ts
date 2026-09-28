// A short-lived cache per folder: a tab that asks twice in a few seconds (open a folder, then another) runs git once.
// Promises are cached, so two requests at the same moment share one run; a failure is forgotten at once.
export function ttlCache<T>(ms: number, max = 200) {
  const m = new Map<string, { at: number; v: Promise<T> }>();
  function get(key: string, make: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = m.get(key);
    if (hit && now - hit.at < ms) return hit.v;
    const v = make();
    m.set(key, { at: now, v });
    v.catch(() => { if (m.get(key)?.v === v) m.delete(key); });
    if (m.size > max) {
      for (const [k, e] of m) if (now - e.at >= ms) m.delete(k);
      while (m.size > max) m.delete(m.keys().next().value!);
    }
    return v;
  }
  return Object.assign(get, { clear: () => m.clear(), size: () => m.size });
}
