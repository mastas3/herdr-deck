// Founder Library: adding a public web page (a case study, a founder's blog post). Fetched once, when you add it:
// robots.txt is honoured for our user agent and for "*", nothing behind a login is fetched (no cookies are sent, and
// a 401/403 or a login form stops it), one request per site every few seconds, and only the page's text is kept,
// with its link.
import type { Page } from "./library-cards";
import { parseSource } from "./library-config";

export const UA = "herdr-deck-library/1.0 (personal research; fetches single pages you add)";
const MAX_BYTES = 3_000_000;
const PER_HOST_MS = 5000;
const lastHit = new Map<string, number>();

type Rule = { allow: boolean; path: string };
/** The rules that apply to us in a robots.txt: our own group if there is one, else "*". */
export function robotsRules(txt: string, agent = "herdr-deck-library"): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | undefined, lastWasAgent = false;
  for (const raw of String(txt ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.rules.push({ allow: false, path: val });
    if (key === "allow" && val) cur.rules.push({ allow: true, path: val });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().startsWith(a)));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}
/** robots.txt matching: the longest matching rule wins, Allow on a tie; `*` and a trailing `$` are supported. */
export function robotsAllows(rules: Rule[], path: string): boolean {
  let best: Rule | undefined;
  for (const r of rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
    if (!re.test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
const decode = (s: string) => s.replace(/&(#x?[\da-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
/** The readable text of an HTML page: the article (or main, or body) without scripts, menus, headers and footers. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/tr|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).split("\n").map((l) => l.replace(/[ \t\f\v]+/g, " ").trim()).filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
  return { title, text };
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
export async function fetchPage(url: string, f: FetchImpl = fetch, now = Date.now): Promise<Page> {
  const u = new URL(url);
  const host = u.host;
  const wait = (lastHit.get(host) ?? 0) + PER_HOST_MS - now();
  if (wait > 0) await Bun.sleep(wait);
  lastHit.set(host, now());
  const headers = { "user-agent": UA, accept: "text/html,text/plain;q=0.9" };
  // robots.txt: missing (404) means allowed; unreachable (5xx, timeout) means we don't know, so we don't fetch.
  const rb = await f(`${u.origin}/robots.txt`, { headers, redirect: "follow", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!rb || rb.status >= 500) throw new Error(`Couldn't read ${host}/robots.txt, so the page wasn't fetched`);
  if (rb.ok && !robotsAllows(robotsRules(await rb.text()), u.pathname + u.search)) throw new Error(`${host} asks bots not to fetch that page (robots.txt)`);
  const r = await f(url, { headers, redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(20_000) } as RequestInit);
  // A redirect to a private or local address is refused like a link to one.
  if (r.url && parseSource(r.url).type === "invalid") throw new Error("That page redirects to a private address");
  if (r.status === 401 || r.status === 403) throw new Error("That page needs a login or blocks bots, so it wasn't fetched");
  if (!r.ok) throw new Error(`${host} answered ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`That link is ${type.split(";")[0] || "not a web page"}, not a page of text`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("That page is too big (over 3 MB)");
  const raw = new TextDecoder().decode(buf);
  const { title, text } = /text\/plain/i.test(type) ? { title: u.pathname.split("/").pop() || host, text: raw } : htmlToText(raw);
  if (/<input[^>]+type=["']password["']/i.test(raw) && text.length < 1500) throw new Error("That page is a login form, so it wasn't kept");
  if (text.length < 200) throw new Error("That page has almost no text (it may need JavaScript or a login)");
  return { url: r.url || url, title: title || host, site: host.replace(/^www\./, ""), text: text.slice(0, 200_000), fetchedAt: now() };
}
