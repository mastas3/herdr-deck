// Project pages: "Plan the next milestone" includes what comparable founders did for that kind of milestone (first
// paying customer, growth, launch), from the Founder Library (src/journey-comparables.ts). The page asks for it when
// a project opens; a Plan press that beats the answer waits for it (a second at most), so the prompt always has it
// when the library does. Without a library the prompt is the page's own.
const jComps = new Map(); // project → { p: Promise, v?: result }
function jCompsLoad(project) {
  if (!project) return Promise.resolve();
  let e = jComps.get(project);
  if (!e) {
    e = { p: api("/api/journey/comparables", { project }).then((v) => { e.v = v; }).catch(() => { jComps.delete(project); }) };
    jComps.set(project, e);
  }
  return e.p;
}
if (typeof jPlanPrompt === "function") {
  const jPlanBase = jPlanPrompt;
  try {
    jPlanPrompt = function (j) {
      const base = jPlanBase(j), c = jComps.get(j?.project)?.v;
      return c?.text ? `${base}\n\n${c.text}` : base;
    };
  } catch {} // a prompt builder that can't be wrapped keeps the page's own prompt
}
if (typeof renderJourney === "function") {
  const jRenderBase = renderJourney;
  try { renderJourney = function (...a) { const r = jRenderBase(...a); if (S.mode === "project" && S.jp?.name) jCompsLoad(S.jp.name); return r; }; } catch {}
}
// Plan pressed before the comparables arrived: hold that click until they do, then let it through.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.('[data-jact="plan"]');
  const p = S.jp?.name;
  if (!b || b.dataset.jcompsReady || !p || jComps.get(p)?.v) return;
  e.stopPropagation(); e.preventDefault();
  Promise.race([jCompsLoad(p), new Promise((r) => setTimeout(r, 1200))]).then(() => { b.dataset.jcompsReady = "1"; b.click(); delete b.dataset.jcompsReady; });
}, true);
