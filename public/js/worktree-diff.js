"use strict";
// A worktree's diff against its base, drawn in the worktree dialogs: the commits, then one line per file (+/−), and
// a file's changes when you open it. The lines come from the server already parsed (src/git-diff.ts, the same parser
// as the Files plugin's Changes tab), so this works whether or not Files is on.
const WT_BADGE = { M: "changed", A: "added", D: "deleted", R: "renamed", U: "conflict" };

function wtDiffHTML(d) {
  const s = d.status, n = d.files.length + (d.more ?? 0);
  const commits = s.commits.length ? `<details class="wtd-commits"${s.commits.length <= 5 ? " open" : ""}><summary>${s.ahead} commit${s.ahead === 1 ? "" : "s"} on ${esc(s.branch)} not in ${esc(s.base)}</summary><ul>${s.commits.map((c) => `<li><span class="mono">${esc(c.sha)}</span> ${esc(c.subject)} <span class="hint">${esc(agoText(c.at))}</span></li>`).join("")}${s.ahead > s.commits.length ? `<li class="hint">and ${s.ahead - s.commits.length} older</li>` : ""}</ul></details>` : "";
  const files = n ? `<div class="wtd-files">${d.files.map((f) => {
    const i = f.path.lastIndexOf("/");
    const nums = f.bin ? `<span class="hint">binary</span>` : `<span class="cx-a">+${f.add ?? 0}</span> <span class="cx-d">−${f.del ?? 0}</span>`;
    return `<section class="wtd-f" data-p="${esc(f.path)}"${f.old ? ` data-old="${esc(f.old)}"` : ""}><button type="button" class="wtd-h" aria-expanded="false" title="${esc(f.old ? `${f.old} → ${f.path}` : f.path)}"><span class="wtd-b" data-st="${esc(f.st)}" title="${WT_BADGE[f.st] ?? ""}">${esc(f.st)}</span><span class="wtd-p"><span class="hint">${esc(i > 0 ? f.path.slice(0, i + 1) : "")}</span>${esc(f.path.slice(i + 1))}</span><span class="wtd-n">${nums}</span></button><div class="wtd-lines" hidden></div></section>`;
  }).join("")}${d.more ? `<p class="hint">${d.more} more files not listed.</p>` : ""}</div>` : "";
  const sum = n ? `${n} file${n === 1 ? "" : "s"} · <span class="cx-a">+${d.add}</span> <span class="cx-d">−${d.del}</span> <span class="hint">· ${esc(s.branch)} against ${esc(s.base)}</span>` : `<span class="hint">No committed changes on ${esc(s.branch)} that ${esc(s.base)} doesn’t have.</span>`;
  return `<p class="wtd-sum">${sum}</p>${commits}${files}`;
}

function wtLinesHTML(lines) {
  if (!lines.length) return `<p class="hint">No line changes (only the mode or the name).</p>`;
  return lines.map(([k, t, a, b]) => k === "@" ? `<div class="dl dhunk">${esc(t)}</div>` : k === "!" ? `<div class="dl dnote">${esc(t)}</div>`
    : `<div class="dl" data-k="${k === "+" ? "a" : k === "-" ? "d" : "c"}"><span class="dn">${a ?? ""}</span><span class="dn">${b ?? ""}</span><span class="dt">${esc(t) || " "}</span></div>`).join("");
}

/** Opening a file loads its lines once; closing just hides them. */
async function wtDiffClick(e, r) {
  const h = e.target.closest(".wtd-h");
  if (!h) return;
  const sec = h.closest(".wtd-f"), box = sec.querySelector(".wtd-lines");
  const open = h.getAttribute("aria-expanded") !== "true";
  h.setAttribute("aria-expanded", String(open));
  box.hidden = !open;
  if (!open || box.dataset.loaded) return;
  box.innerHTML = `<p class="hint">Loading…</p>`;
  try {
    const { lines } = await api("/api/worktree", { op: "file", key: r.key, path: sec.dataset.p, old: sec.dataset.old });
    box.innerHTML = wtLinesHTML(lines);
    box.dataset.loaded = "1";
  } catch (x) { box.innerHTML = `<p class="hint">${esc(x.message)}</p>`; }
}
