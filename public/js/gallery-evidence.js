// Evidence, not model confidence. The notebook is shared with Opportunities and can be opened inside Discover.
const galEvidenceDate = (at) => at ? new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "date unknown";
function galEvidenceChanged() { if (S.gal) { S.gal.full.clear(); S.gal.at = 0; } }
function galProofBadge(c) {
  const p = c.proof;
  return `<span class="galstage" data-stage="${esc(p?.stage || "concept")}">${esc(p?.label || "Untested idea")}</span>`;
}
function galProofLine(c) {
  const p = c.proof;
  if (!p) return '<p class="galproof">Evidence has not been reviewed.</p>';
  const notes = [`${p.reviewedSources} reviewed problem source${p.reviewedSources === 1 ? "" : "s"}`];
  if (p.failedTests) notes.push(`${p.failedTests} failed test${p.failedTests === 1 ? "" : "s"}`);
  if (p.objections) notes.push(`${p.objections} unresolved objection${p.objections === 1 ? "" : "s"}`);
  if (p.plannedTests) notes.push(`${p.plannedTests} planned test${p.plannedTests === 1 ? "" : "s"}`);
  return `<p class="galproof">${esc(notes.join(" · "))}</p>`;
}
function galEvidenceIntro(d) {
  const hasShortlist = d?.lanes?.some(l => l.id === "reviewed" && l.ideas.length);
  const running = d?.job?.running;
  const errors = (d?.coverage ?? []).map(q => `<li>${esc(q.audience)}: ${q.errors.map(esc).join("; ")}</li>`).join("");
  return `<div class="galevidencehead"><p class="galkick">Problems → evidence → buyer tests</p><h2>${hasShortlist ? "A shortlist with evidence attached." : "Nothing has earned a place on the shortlist yet."}</h2>
    <p>${hasShortlist ? "Stages come from source reviews and recorded tests. They do not predict success." : "Review a problem lead or an earlier idea. A confident pitch and a source link are not enough."}</p>
    <details class="galsearch" data-galsearch><summary>Find new problem leads</summary><p>Search public posts for the configured audiences, then send collected excerpts to Claude to suggest up to six small tests. No confidence scores, customer messages or purchases.</p><label><input type="checkbox" data-galconsent> Use public research services and Claude for this search.</label><button class="btn primary" data-galfind${running ? " disabled" : ""}>${running ? "Search in progress…" : "Find problem leads"}</button><p class="hint" data-galsearcherror role="alert"></p></details>
    ${d?.note ? `<p class="hint">${esc(d.note)}</p>` : ""}${errors ? `<details class="galcoverage"><summary>Gaps in the last source collection</summary><ul>${errors}</ul></details>` : ""}</div>`;
}
async function galFindProblems(root) {
  const error = root.querySelector("[data-galsearcherror]");
  if (!root.querySelector("[data-galconsent]").checked) { error.textContent = "Check the box to start this public search and model call."; return; }
  const button = root.querySelector("[data-galfind]"); button.disabled = true; error.textContent = "";
  try { S.gal.data = await api("/api/ideas", { consent: true, force: true }, 20_000); await galLoad(); }
  catch (e) { if (error.isConnected) error.textContent = e.message; else toast(e.message, true); }
  finally { if (button.isConnected) button.disabled = false; }
}
async function galOpenEvidence(id, section = "demand") {
  try {
    const linked = await api("/api/ideas/dossier", { id });
    const r = await api("/api/opportunities/item", { id: linked.id });
    oAccept(r.item); S.opp.selected = r.item.id; S.opp.section = section;
    S.gal.sheet?.dlg.close(); S.disc.tab = "evidence"; store("discTab", "evidence");
    renderDiscover(); opportunitiesLoad(); $("dbody").scrollTop = 0;
  } catch (e) { toast(e.message, true); }
}
function galEvidenceDetails(c) {
  const p = c.proof, r = p?.latestTest;
  const unknowns = p?.unknowns?.length ? p.unknowns : c.unknowns?.length ? c.unknowns : ["Does this problem affect the proposed buyer?", "Are existing or free alternatives good enough?", "Can you reach buyers, and will they pay for this offer?"];
  return galSec("What has been checked", `<p>${p?.stage === "concept" ? "This is still a hypothesis. No reviewed problem or successful buyer test has established a later stage." : "The stage reflects saved source reviews or owner-reported experiment results. It is not a prediction."}</p>
    <p>${p?.independentGroups ?? 0} independent groups of reviewed problem sources. Documenting a problem requires current sources, buyer and problem reviews, and no unresolved contrary evidence.</p>
    ${r ? `<div class="galtest"><h4>Latest recorded test · ${esc(r.outcome)}</h4><p>${esc(r.offer)}</p><dl class="galstats"><div><dt>People in test</dt><dd>${r.denominator}</dd></div><div><dt>Target actions</dt><dd>${r.successes}</dd></div><div><dt>Paying customers</dt><dd>${r.payingCustomers}</dd></div><div><dt>Paid again</dt><dd>${r.repeatPayments}</dd></div></dl><p>${esc(r.segment)} · ${esc(r.channel)} · ${esc(galEvidenceDate(r.observedAt))}</p><p class="hint">${esc(r.provenance)}. Counts are for this test only.</p></div>` : '<p class="hint">No customer test results recorded for the current idea.</p>'}
    <button class="link" data-galevidence="experiments">${r ? "See all tests and their references" : "Set the offer and pass/fail conditions before testing"} →</button>`)
    + galSec("Questions that could rule it out", `<ul>${unknowns.map(x => `<li>${esc(x)}</li>`).join("")}</ul><button class="link" data-galevidence="alternatives">Check alternatives and counterevidence →</button>`);
}
