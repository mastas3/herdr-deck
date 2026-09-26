"use strict";
// Markdown for agent messages (escaped first), with an agent's options turned into pickable choice cards.
// ── markdown (safe: escaped first) ───────────────────────────────────────
const PATHISH = /^(?:~\/|\/|\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]*[\w@.+-])+\/?(?::\d+(?::\d+)?)?$/;
const looksLikePath = (c) => PATHISH.test(c) && (/^(~\/|\/)/.test(c) || /\.\w{1,8}(:\d+)*$/.test(c)) && !/^\w+:\/\//.test(c);
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // local file links, "[name](</abs/path>)" or "[name](/abs/path)": show the name, the path on hover
    .replace(/\[([^\]\n]+)\]\((?:&lt;)?((?:~|\/|\.{1,2}\/)[^\s)]*?)(?:&gt;)?\)/g, '<a class="fpath" data-path="$2" title="$2">$1</a>')
    // [[wiki-page]] links into the personal wiki
    .replace(/\[\[([\w.-]+)(?:\|([^\]\n]+))?\]\]/g, (_, name, label) => `<a class="fpath" data-path="wiki:${name}" title="Wiki: ${name}">${label ?? name}</a>`)
    // bare paths in prose: ~/… or an absolute home path
    .replace(/(^|[\s(])((?:~|\/Users\/[\w.-]+|\/home\/[\w.-]+)\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])/g, '$1<a class="fpath" data-path="$2" title="$2">$2</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => { const c = codes[Number(i)]; return looksLikePath(c.replace(/&amp;/g, "&")) ? `<code class="fpath" data-path="${c}" title="Open ${c}">${c}</code>` : `<code>${c}</code>`; });
}
/**
 * Choices an agent offers ("(a) … (b) …", "A) …", or a numbered list right after a question) become cards
 * you can pick with one click. Returns null when the lines aren't a clean, sequential set of 2+ options.
 */
const OPT_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:\(([a-hA-H1-9])\)|([a-hA-H1-9])[).:]|Option ([A-Ha-h1-9])[:.)]?)(?:\*\*)?\s+(.+)$/;
function parseChoices(lines, start, afterQuestion) {
  const opts = [];
  const labelOf = (l) => { const m = l?.match(OPT_RE); return m ? { label: (m[1] ?? m[2] ?? m[3]).toLowerCase(), text: m[4] } : null; };
  let i = start;
  for (;;) {
    const o = labelOf(lines[i]);
    if (!o) break;
    const want = opts.length ? String.fromCharCode(opts[opts.length - 1].label.charCodeAt(0) + 1) : null;
    if (want ? o.label !== want : !/^[a1]$/.test(o.label)) break;
    if (/^\d$/.test(o.label) && !afterQuestion) return null; // a plain numbered list stays a list
    const body = [o.text];
    i++;
    const next = String.fromCharCode(o.label.charCodeAt(0) + 1);
    // An option runs until the next option's label (even across blank lines); the last one ends at a blank line.
    let j = i;
    while (j < lines.length && j - i < 40 && labelOf(lines[j])?.label !== next) j++;
    const until = j < lines.length && labelOf(lines[j])?.label === next ? j : (() => { let k = i; while (k < lines.length && lines[k].trim() && !OPT_RE.test(lines[k])) k++; return k; })();
    for (; i < until; i++) if (lines[i].trim()) body.push(lines[i]);
    opts.push({ label: o.label, body });
    if (until >= lines.length || labelOf(lines[until])?.label !== next) break;
  }
  return opts.length >= 2 ? { opts, end: i } : null;
}
const DECIDE = /\b(pick|choose|choice|options?|ways?\b|paths?|approach(?:es)?|alternatives?|directions?|decide|decision|go with|prefer|should (?:i|we)|would you like|want me to|which (?:one|option|way|path|approach|of these|do you|would you|should))\b/i;
const ASKS = /\?\s*\**\s*$|\b(pick one|choose|which (?:one|do you|would you)|prefer|your call|let me know which|tell me which)\b/i;
/** Title = a leading **bold** phrase, else the first sentence; the rest describes it. */
function splitOption(body) {
  const first = body[0];
  const bold = first.match(/^\*\*(.+?)\*\*[\s:—–.-]*(.*)$/);
  let title, restFirst;
  if (bold) { title = bold[1]; restFirst = bold[2]; }
  else {
    const plainFirst = first.replace(/\*\*/g, "");
    const cut = plainFirst.search(/(?<=[.!?])\s|\s[—–-]\s|:\s|;\s/);
    title = cut > 0 && cut < 100 ? plainFirst.slice(0, cut) : plainFirst.length <= 100 ? plainFirst : plainFirst.slice(0, 90).replace(/\s+\S*$/, "") + "…";
    restFirst = cut > 0 && cut < 100 ? plainFirst.slice(cut).replace(/^\s*[—–:;-]?\s*/, "") : plainFirst.length <= 100 ? "" : plainFirst;
  }
  return { title: title.replace(/[\s,;:.—–-]+$/, ""), rest: [restFirst, ...body.slice(1)].filter((x) => x && x.trim()) };
}
function choicesHTML(opts, question) {
  return `<div class="choices">${question ? `<div class="cq">${inline(question)}</div>` : ""}${opts.map((o) => {
    const { title, rest } = splitOption(o.body);
    const rec = /recommend|\bpreferred\b/i.test(o.body[0]);
    const lab = o.label.toUpperCase();
    const clean = title.replace(/\s*\((my )?recommend(ed|ation)\)/i, "");
    return `<div class="choice${rec ? " rec" : ""}" data-choice="${esc(o.label)}" data-title="${esc(clean)}"><span class="cl">${esc(lab)}</span><div class="cb"><div class="ct">${inline(clean)}${rec ? '<span class="rp">Recommended</span>' : ""}</div>${rest.length ? `<div class="cd">${rest.map(inline).join("<br>")}</div>` : ""}</div><button class="btn primary cs" data-choose="${esc(o.label)}" tabindex="-1">Choose ${esc(lab)}</button></div>`;
  }).join("")}<div class="chint">Click an option to put it in your reply · <b>Choose</b> sends it</div></div>`;
}
function diffHTML(code) {
  return `<pre class="diff"><code>${code.replace(/\n$/, "").split("\n").map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "hunk" : ""}">${esc(l)}</span>`).join("\n")}</code></pre>`;
}
function md(text) {
  const out = [];
  const src = String(text ?? "");
  const langs = [...src.matchAll(/^```([^\n]*)\n/gm)].map((m) => m[1].trim().toLowerCase());
  const parts = src.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  for (let p = 0; p < parts.length; p++) {
    if (p % 2 === 1) { const lang = langs[(p - 1) / 2] ?? ""; out.push(lang === "diff" || lang === "patch" ? diffHTML(parts[p]) : `<pre><code>${esc(parts[p].replace(/\n$/, ""))}</code></pre>`); continue; }
    const lines = parts[p].split("\n");
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const prevHTML = out[out.length - 1] ?? "";
      const prevText = prevHTML.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      const intro = prevText.split(/(?<=[.!?:])\s+/).pop() ?? "";
      const decisive = /\?\s*$/.test(intro) || (DECIDE.test(intro) && /[:?]\s*$/.test(intro));
      const ch = OPT_RE.test(l) ? parseChoices(lines, i, decisive) : null;
      if (ch) {
        const outro = lines.slice(ch.end).find((x) => x.trim()) ?? "";
        const rec = ch.opts.some((o) => /recommend/i.test(o.body[0]));
        const numeric = /^\d$/.test(ch.opts[0].label);
        if (decisive || (!numeric && (rec || ASKS.test(outro)))) {
          // The question moves into the card group, so the options read as answers to it.
          // A short question/lead-in paragraph moves into the card group so the options read as answers to it.
          let q = "";
          if (/[?:]\s*\**\s*$/.test(prevText) && (prevText === intro || prevText.length < 140) && /^<(p|h\d)>/.test(prevHTML)) { out.pop(); q = prevText.replace(/\*\*/g, ""); }
          out.push(choicesHTML(ch.opts, q));
          i = ch.end;
          continue;
        }
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")) {
        const row = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = row(l);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`);
        continue;
      }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${q.map(inline).join("<br>")}</blockquote>`);
        continue;
      }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d+[.)]/.test(l);
        const items = [];
        while (i < lines.length && (/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const ln = lines[i++];
          if (/^\s*([-*•]|\d+[.)])\s+/.test(ln)) items.push(ln.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
          else items[items.length - 1] += "\n" + ln.trim();
        }
        const check = (x) => { const c = x.match(/^\[( |x|X)\]\s+/); return c ? `<span class="ck${c[1] !== " " ? " on" : ""}"></span>${inline(x.slice(c[0].length)).replace(/\n/g, "<br>")}` : inline(x).replace(/\n/g, "<br>"); };
        const task = items.some((x) => /^\[( |x|X)\]\s/.test(x));
        out.push(`<${ordered ? "ol" : "ul"}${task ? ' class="tasks"' : ""}>${items.map((x) => `<li>${check(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*([-*•]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
  }
  return out.join("");
}
/** Light markdown for short prose (briefs, recaps). */
const mdLite = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code class="mono" style="font-size:.86em">$1</code>').replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
