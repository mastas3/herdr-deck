// Studio: a compact "Comparables" line on each build card. The server attaches the founders most like the build
// (src/studio.ts buildComps, from the Founder Library); this wraps the page's build renderer to show them, each linked
// to the moment it was said, with the strategy check when the build's price or channel is far from theirs.
function stCompsHTML(c) {
  if (!c?.items?.length) return "";
  const item = (x) => `<a class="stcomp" href="${esc(x.link)}" target="_blank" rel="noopener" title="${esc(x.tactic ?? "")}"><b>${esc(x.name)}</b>${[x.revenue ? `claims “${x.revenue}”` : "", x.channel, x.published ? `${x.published}${x.old ? ", older" : ""}` : ""].filter(Boolean).map((b) => `<span>${esc(b)}</span>`).join("")}</a>`;
  return `<div class="stcomps"><p class="stcomph">${ICON.book ?? ""}Comparables <span class="hint">founders most like this, from your library</span></p><div class="stcompl">${c.items.map(item).join("")}</div>${c.checks?.length ? `<p class="stcheck">${esc(c.checks.join(" "))}</p>` : ""}</div>`;
}
if (typeof stBuildHTML === "function") {
  const stBuildBase = stBuildHTML;
  try {
    stBuildHTML = function (x, key, nb) {
      const html = stBuildBase(x, key, nb);
      const extra = stCompsHTML(x?.comps);
      return extra ? html.replace('<div class="stacts">', `${extra}<div class="stacts">`) : html;
    };
  } catch {} // a renderer that can't be wrapped just shows builds without the line
}
