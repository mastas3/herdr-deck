// Founder Library: playbooks, written from the founder cards by counting, not by a model. Each one states how many
// cards it rests on, gives patterns with counts, and quotes example cards with a link to the moment in the video.
// Numbers are the founders' own claims; the playbooks say so. Files: <library>/playbooks/<name>.md.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fmtT, linkAt, type Card, type Channel, type Item } from "./library-extract";
import { fmtPublished, oldLabel } from "./library-dates";

export type PlaybookInfo = { name: string; file: string; title: string; cards: number; at: number };
type Playbook = { name: string; title: string; cards: number; md: string };

const CH_LABEL: Record<string, string> = {
  reddit: "Reddit", x_twitter: "X / Twitter", tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", linkedin: "LinkedIn", facebook_groups: "Facebook groups",
  product_hunt: "Product Hunt", hacker_news: "Hacker News", seo: "SEO", content_blog: "Blog / content", newsletter: "Newsletter", cold_email: "Cold email", cold_calls: "Cold calls",
  door_to_door: "Door to door", in_person: "In person / events", friends_network: "Friends and network", existing_audience: "An existing audience", communities: "Online communities",
  paid_ads: "Paid ads", partnerships: "Partnerships", affiliates: "Affiliates", app_store: "App store search", marketplace: "Marketplaces (Etsy, Amazon, Fiverr…)", word_of_mouth: "Word of mouth",
  press: "Press", influencers: "Influencers and creators", cold_dms: "Cold DMs", other: "Other",
};
const BT_LABEL: Record<string, string> = { saas: "SaaS", mobile_app: "Mobile apps", ecommerce: "E-commerce", service_agency: "Services and agencies", info_product: "Courses and info products", marketplace: "Marketplaces", content_media: "Content and media", local_business: "Local businesses", newsletter: "Newsletters", community: "Communities", hardware: "Hardware", other: "Other" };
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "0%");
const name = (c: Card) => c.business ?? c.title;
/** " (Mar 2024)" or " (Jun 2020, older)": when the video came out, so a stale tactic reads as one. */
const when = (c: Card) => (c.date ? ` (${fmtPublished(c.date)}${oldLabel(c.date) ? ", older" : ""})` : "");
const at = (c: Card, t: number | null | undefined) => `[${t ? fmtT(t) : "video"}](${linkAt(c.url, t)})`;
const rev = (c: Card) => (c.revenue ? ` · claimed revenue “${c.revenue.quote ?? c.revenue.text}”${c.revenue.src === "title" ? " (title)" : ""} ${at(c, c.revenue.t)}` : "");
const one = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s).replace(/\n/g, " ");
const header = (title: string, n: number, what: string) => `# ${title}\n\n_Generated ${new Date().toISOString().slice(0, 10)} from ${n} ${what} in the herdr deck Founder Library. Counts are founders who said it on camera; revenue and prices are their own claims, unverified. Every example links to the moment it was said._\n`;
function tally<T>(xs: T[], key: (x: T) => string[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) for (const k of new Set(key(x))) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}
const byRevenue = (a: Card, b: Card) => (b.revenue?.perMonth ?? 0) - (a.revenue?.perMonth ?? 0) || (b.views ?? 0) - (a.views ?? 0);

function firstCustomers(cards: Card[]): Playbook {
  const fs = cards.filter((c) => c.kind === "founder_story" && c.first.length);
  const out = [header("Getting the first 10 customers", fs.length, "founder stories that say how the first customers came")];
  out.push("## Where the first customers came from\n", "| Channel | Founders | Share |", "|---|---:|---:|");
  const t = tally(fs, (c) => c.first.map((x) => x.channel ?? "other"));
  for (const [ch, xs] of t) out.push(`| ${CH_LABEL[ch] ?? ch} | ${xs.length} | ${pct(xs.length, fs.length)} |`);
  out.push("");
  for (const [ch, xs] of t.filter(([ch]) => ch !== "other").slice(0, 10)) {
    out.push(`## ${CH_LABEL[ch] ?? ch} (${xs.length})\n`);
    for (const c of [...xs].sort(byRevenue).slice(0, 5)) {
      const it = c.first.find((x) => x.channel === ch)!;
      out.push(`- **${name(c)}**${when(c)}${c.sells ? ` (${one(c.sells, 80)})` : ""}: ${one(it.text)} ${at(c, it.t)}${rev(c)}`);
    }
    out.push("");
  }
  const multi = fs.filter((c) => new Set(c.first.map((x) => x.channel)).size > 1).length;
  out.push(`## Pattern notes\n`, `- ${multi} of ${fs.length} founders (${pct(multi, fs.length)}) used more than one channel for their first customers.`);
  const byType = tally(fs, (c) => [c.btype]).slice(0, 5);
  for (const [bt, xs] of byType) {
    const top = tally(xs, (c) => c.first.map((x) => x.channel ?? "other")).filter(([ch]) => ch !== "other").slice(0, 3);
    if (top.length) out.push(`- ${BT_LABEL[bt] ?? bt} (${xs.length}): ${top.map(([ch, ys]) => `${CH_LABEL[ch]} ${ys.length}`).join(", ")}.`);
  }
  return { name: "first-10-customers", title: "Getting the first 10 customers", cards: fs.length, md: out.join("\n") + "\n" };
}

const MODEL_OF = (s: string) => (/life ?time|one[- ]time|once/i.test(s) ? "one-time" : /\/ ?(mo|month)|a month|per month|monthly|\/ ?(yr|year)|a year|annual|per year/i.test(s) ? "subscription" : /per (user|seat)|usage|credit/i.test(s) ? "usage" : "other");
function pricing(cards: Card[]): Playbook {
  const ps = cards.filter((c) => c.price);
  const out = [header("Pricing that worked", ps.length, "founder cards that state a price")];
  const models = tally(ps, (c) => [MODEL_OF(`${c.price!.text} ${c.price!.quote ?? ""}`)]);
  out.push("## Pricing models\n", "| Model | Cards | Share |", "|---|---:|---:|", ...models.map(([m, xs]) => `| ${m} | ${xs.length} | ${pct(xs.length, ps.length)} |`), "");
  for (const [bt, xs] of tally(ps, (c) => [c.btype])) {
    out.push(`## ${BT_LABEL[bt] ?? bt} (${xs.length})\n`);
    for (const c of [...xs].sort(byRevenue).slice(0, 8)) out.push(`- **${name(c)}**${when(c)}: “${c.price!.quote ?? c.price!.text}” ${at(c, c.price!.t)}${rev(c)}`);
    out.push("");
  }
  const both = ps.filter((c) => /month/i.test(c.price!.text) && /year/i.test(c.price!.text)).length;
  out.push("## Pattern notes\n", `- ${both} of ${ps.length} offer both monthly and yearly prices.`);
  return { name: "pricing-that-worked", title: "Pricing that worked", cards: ps.length, md: out.join("\n") + "\n" };
}

function distribution(cards: Card[]): Playbook {
  const fs = cards.filter((c) => c.first.length || c.growth.length);
  const out = [header("Distribution channels by business type", fs.length, "cards that name a first-customer or growth channel")];
  for (const [bt, xs] of tally(fs, (c) => [c.btype])) {
    out.push(`## ${BT_LABEL[bt] ?? bt} (${xs.length})\n`);
    const t = tally(xs, (c) => [...c.first, ...c.growth].map((x) => x.channel ?? "other")).filter(([ch]) => ch !== "other").slice(0, 6);
    for (const [ch, ys] of t) {
      const ex = [...ys].sort(byRevenue)[0];
      const it = [...ex.first, ...ex.growth].find((x) => x.channel === ch)!;
      out.push(`- **${CH_LABEL[ch]}**: ${ys.length} of ${xs.length} (${pct(ys.length, xs.length)}). e.g. ${name(ex)}: ${one(it.text, 120)} ${at(ex, it.t)}`);
    }
    out.push("");
  }
  return { name: "distribution-by-business-type", title: "Distribution channels by business type", cards: fs.length, md: out.join("\n") + "\n" };
}

// Themes are keyword groups over what founders said failed or they regret. A line can fall in more than one.
const FAIL_THEMES: [string, RegExp][] = [
  ["Built before checking anyone wanted it", /validat|nobody (wanted|used|cared)|no one (wanted|used)|no demand|without talking|didn.t talk|built (it )?first|in a vacuum|no customers/i],
  ["No distribution or marketing plan", /distribut|marketing|no traffic|couldn.t get (users|customers)|nobody knew|audience/i],
  ["Too big or too complex a product", /too (big|complex|many features|broad|horizontal)|overbuil|over-engineer|perfect|horizontal|scope/i],
  ["Wrong customer or market", /wrong (market|customer|niche)|market (was )?too small|niche|b2c|consumers? don.t pay|pivot/i],
  ["Pricing too low or free", /too cheap|free (plan|tier|users)|underpric|pric(e|ing) (was )?too low|didn.t charge/i],
  ["Co-founder and team problems", /co-?founder|partner(ship)? (broke|split)|hire|hired too|team/i],
  ["Money ran out or spent too much", /ran out of (money|cash)|burn|spent too much|debt|funding|raised/i],
  ["Quit too early or gave up", /gave up|quit|stopped|abandon|lost motivation|too early/i],
  ["Launched to silence: no traction", /no one cared|nobody cared|no traction|plateau|didn.t (blow up|take off|get users)|did not result|no users|bounce rate|hard to scale/i],
  ["Too slow: the day job, or years of building", /full[- ]time job|day job|safe job|delayed|took (me )?(\d+|two|three) (years|months)|wasted time|months trying/i],
  ["Too many ideas at once", /shiny object|too many (products|ideas)|next \d+ products|every sort of|jumping between/i],
  ["A product people couldn't use or didn't like", /quality|too hard|hard to (use|understand)|confus|unsellable|didn.t like/i],
  ["Earlier businesses that didn't work", /\b(agency|drop ?shipping|clothing|e-?commerce|newsletter|candle|vending|resell|game|consulting|app called|business)\b.*\b(fail|didn.t|did not|no one|nobody|stopped|shut|never)|\bfailed\b|didn.t work|did not work|flopped/i],
];
function failures(cards: Card[]): Playbook {
  const items = cards.flatMap((c) => c.failed.map((f) => ({ c, f })));
  const out = [header("Why businesses failed / what founders regret", new Set(items.map((x) => x.c.id)).size, "cards where founders talk about what failed or what they regret")];
  const themed = FAIL_THEMES.map(([label, re]) => [label, items.filter(({ f }) => re.test(f.text))] as const).filter(([, xs]) => xs.length).sort((a, b) => b[1].length - a[1].length);
  out.push("## Themes\n", "| Theme | Mentions |", "|---|---:|", ...themed.map(([l, xs]) => `| ${l} | ${xs.length} |`), `| (no theme matched) | ${items.filter(({ f }) => !FAIL_THEMES.some(([, re]) => re.test(f.text))).length} |`, "");
  for (const [label, xs] of themed) {
    out.push(`## ${label} (${xs.length})\n`);
    for (const { c, f } of xs.slice(0, 6)) out.push(`- **${name(c)}**${when(c)}: ${one(f.text)} ${at(c, f.t)}`);
    out.push("");
  }
  return { name: "failures-and-regrets", title: "Why businesses failed / what founders regret", cards: new Set(items.map((x) => x.c.id)).size, md: out.join("\n") + "\n" };
}

function traits(cards: Card[]): Playbook {
  const fs = cards.filter((c) => c.kind === "founder_story");
  const top = fs.filter((c) => (c.revenue?.perMonth ?? 0) >= 10_000);
  const rest = fs.filter((c) => !top.includes(c));
  const out = [header("Common traits of the successful ones", fs.length, "founder stories")];
  out.push(`"Successful" here means the founder claims at least $10K a month (${top.length} cards); the comparison group is the other ${rest.length} founder stories (lower or no stated revenue).\n`);
  const n = (g: Card[], f: (c: Card) => boolean) => g.filter(f).length;
  const row = (label: string, f: (c: Card) => boolean) => `| ${label} | ${n(top, f)} (${pct(n(top, f), top.length)}) | ${n(rest, f)} (${pct(n(rest, f), rest.length)}) |`;
  out.push("| Trait | ≥ $10K/month | Others |", "|---|---:|---:|",
    row("Solo founder", (c) => /\bsolo|alone|by myself|one[- ]person|just me\b/i.test(c.team?.text ?? "")),
    row("Says time to first revenue", (c) => !!c.ttfr),
    row("States a price", (c) => !!c.price),
    row("Used 2+ channels for first customers", (c) => new Set(c.first.map((x) => x.channel)).size > 1),
    row("Talks about an earlier failure", (c) => c.failed.length > 0),
    ...tally(top, (c) => c.first.map((x) => x.channel ?? "other")).filter(([ch]) => ch !== "other").slice(0, 4).map(([ch]) => row(`First customers via ${CH_LABEL[ch]}`, (c) => c.first.some((x) => x.channel === ch))), "");
  out.push("## Business types among them\n", ...tally(top, (c) => [c.btype]).map(([bt, ys]) => `- ${BT_LABEL[bt] ?? bt}: ${ys.length}`), "");
  out.push("## Lessons they repeat\n");
  for (const c of [...top].sort(byRevenue).slice(0, 12)) if (c.lessons[0]) out.push(`- **${name(c)}**${when(c)}${rev(c)}: ${one(c.lessons[0].text)} ${at(c, c.lessons[0].t)}`);
  return { name: "traits-of-successful-founders", title: "Common traits of the successful ones", cards: fs.length, md: out.join("\n") + "\n" };
}

const BORING = /cleaning|laundr|plumb|hvac|roof|landscap|pressure wash|junk|moving|storage|car wash|vending|pest|pool|window|dental|clinic|salon|barber|gym|restaurant|food truck|bakery|coffee|print|sign|trades?|mechanic|electrician|contractor|construction|real estate|rental|parking|laundromat|daycare|home service|b2b service|distribution|wholesale|manufactur/i;
function boring(cards: Card[]): Playbook {
  const bs = cards.filter((c) => c.btype === "local_business" || c.source === "CodieSanchezCT" || BORING.test(`${c.sells ?? ""} ${c.customer ?? ""} ${c.business ?? ""}`));
  const out = [header("Boring businesses that print money", bs.length, "cards about unglamorous businesses (local services, trades, physical products and the software sold to them)")];
  for (const c of [...bs].sort(byRevenue).slice(0, 25)) {
    out.push(`### ${name(c)}${when(c)}${c.sells ? ` — ${one(c.sells, 100)}` : ""}\n`);
    const lines = [c.customer ? `- Customer: ${c.customer}` : "", c.revenue ? `- Claimed revenue: “${c.revenue.quote ?? c.revenue.text}” ${at(c, c.revenue.t)}` : "", c.price ? `- Price: “${c.price.quote ?? c.price.text}” ${at(c, c.price.t)}` : "",
      ...c.first.slice(0, 2).map((x: Item) => `- First customers (${CH_LABEL[x.channel as Channel] ?? "other"}): ${one(x.text)} ${at(c, x.t)}`), c.lessons[0] ? `- Lesson: ${one(c.lessons[0].text)} ${at(c, c.lessons[0].t)}` : "", `- Source: [${one(c.title, 90)}](${c.url})`];
    out.push(...lines.filter(Boolean), "");
  }
  return { name: "boring-businesses", title: "Boring businesses that print money", cards: bs.length, md: out.join("\n") + "\n" };
}

export const PLAYBOOKS = [firstCustomers, pricing, distribution, failures, traits, boring];
const ORDER = ["first-10-customers", "pricing-that-worked", "distribution-by-business-type", "failures-and-regrets", "traits-of-successful-founders", "boring-businesses"];
export function buildPlaybooks(cards: Card[]): Playbook[] { return PLAYBOOKS.map((f) => f(cards)); }

export async function writePlaybooks(dir: string, cards: Card[]): Promise<PlaybookInfo[]> {
  const d = `${dir}/playbooks`;
  mkdirSync(d, { recursive: true });
  for (const p of buildPlaybooks(cards)) {
    const tmp = `${d}/${p.name}.md.${process.pid}.tmp`;
    writeFileSync(tmp, p.md);
    renameSync(tmp, `${d}/${p.name}.md`);
  }
  return listPlaybooks(dir);
}
export function listPlaybooks(dir: string): PlaybookInfo[] {
  const d = `${dir}/playbooks`;
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => ORDER.includes(f.slice(0, -3))); } catch { return []; } // notes kept alongside aren't playbooks
  return files.map((f) => {
    const md = readFileSync(`${d}/${f}`, "utf8");
    return { name: f.slice(0, -3), file: `${d}/${f}`, title: md.match(/^# (.+)$/m)?.[1] ?? f, cards: Number(md.match(/from (\d+) /)?.[1] ?? 0), at: statSync(`${d}/${f}`).mtimeMs };
  }).sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
}
export function readPlaybook(dir: string, n: string): string {
  if (!/^[\w-]+$/.test(n)) return "";
  try { return readFileSync(`${dir}/playbooks/${n}.md`, "utf8"); } catch { return ""; }
}
