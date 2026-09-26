"use strict";
// ── Opportunities: a hypothesis, its evidence and the next buyer test ─────────
S.opp = { loaded: false, loading: false, items: [], industries: [], filters: { mode: '', industry: '', stage: '' }, selected: null, section: 'summary', create: false, busy: false, error: '', jobs: [], timer: null, calcTimer: null, calcSeq: 0 };
const OMODES = [['assets', 'Use my advantages'], ['markets', 'Explore new markets'], ['novel', 'Novel solutions']];
const OSTAGES = [['concept', 'Concept'], ['research-ready', 'Research-ready'], ['buying-signal', 'Buying signal'], ['paid-pilot', 'Paid pilot'], ['repeat-use', 'Repeat use / renewal']];
const OSECTIONS = [['summary', 'Overview'], ['demand', 'Demand & sources'], ['alternatives', 'Alternatives'], ['economics', 'Economics'], ['revenue', 'Revenue streams'], ['experiments', 'Experiments']];
const oLabel = (options, value) => options.find((x) => x[0] === value)?.[1] || value || 'Not specified';
const oOptions = (options, value, empty) => `${empty ? `<option value="">${esc(empty)}</option>` : ''}${options.map((x) => `<option value="${esc(x[0])}"${x[0] === value ? ' selected' : ''}>${esc(x[1])}</option>`).join('')}`;
const oIndustries = () => (S.opp.industries || []).map((x) => typeof x === 'string' ? [x, x.replace(/-/g, ' ')] : [x.id, x.label || x.name || x.id]);
const oStage = (stage) => `<span class="opstage" data-stage="${esc(stage || 'concept')}">${esc(oLabel(OSTAGES, stage || 'concept'))}</span>`;
const oDate = (date) => { const d = new Date(date); return date && Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not recorded'; };
const oMoney = (n, currency = 'USD') => { if (n == null || !Number.isFinite(Number(n))) return 'Not estimated'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n)); } catch { return `${Number(n).toFixed(0)} ${esc(currency)}`; } };
const oFriendly = (value) => { let text = String(value || ''); for (const [key, label] of OECONFIELDS) text = text.replaceAll(key, label.toLowerCase()); return text; };
const oText = (value) => typeof value === 'string' ? value : value?.text || value?.summary || value?.note || '';
const oSafeLink = (url, label) => { try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) return esc(label || url); return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(label || u.hostname)} ↗</a>`; } catch { return esc(label || 'No source link'); } };
function oField(name, label, value = '', opts = {}) {
  const occurrence = S.opp.fieldNames?.[name] || 0;
  if (S.opp.fieldNames) S.opp.fieldNames[name] = occurrence + 1;
  const id = `op-${name.replace(/[^a-z0-9]/gi, '-')}${occurrence ? '-' + occurrence : ''}`;
  const attrs = `id="${id}" name="${esc(name)}" class="inp"${opts.required ? ' required' : ''}`;
  return `<label class="opfield${opts.wide ? ' wide' : ''}" for="${id}"><span>${esc(label)}</span>${opts.options ? `<select ${attrs}>${oOptions(opts.options, value, opts.empty)}</select>` : opts.rows ? `<textarea ${attrs} rows="${opts.rows}" maxlength="${opts.maxlength || 6000}">${esc(value)}</textarea>` : `<input ${attrs} type="${opts.type || 'text'}" value="${esc(value ?? '')}"${opts.type === 'number' ? ` step="${opts.step || 'any'}"${opts.min != null ? ` min="${opts.min}"` : ''}${opts.max != null ? ` max="${opts.max}"` : ''}` : ` maxlength="${opts.maxlength || 1000}"`}>`}${opts.hint ? `<small>${esc(opts.hint)}</small>` : ''}</label>`;
}
function oForm(kind, html, submit = 'Save changes') { return `<form data-opform="${kind}" class="opform"><div class="opfields">${html}</div><p data-opformerror class="operror" role="alert" hidden></p><div class="opactions"><button class="btn primary" type="submit">${esc(submit)}</button><span class="hint" data-opformstatus role="status"></span></div></form>`; }
function oAccept(item) { if (!item) return; const i = S.opp.items.findIndex((x) => x.id === item.id); if (i < 0) S.opp.items.unshift(item); else S.opp.items[i] = item; }
async function opportunitiesLoad() {
  const o = S.opp;
  if (o.loading) return;
  o.loading = true; o.error = '';
  try { const r = await api('/api/opportunities', {}); o.items = r.items || []; o.industries = r.industries || []; o.jobs = r.jobs || []; o.loaded = true; }
  catch (e) { o.error = e.message; }
  finally { o.loading = false; opportunitiesPatch(); opportunitiesPoll(); }
}
function opportunitiesPoll() {
  clearTimeout(S.opp.timer);
  if (S.mode !== 'opportunities') return;
  const running = (S.opp.jobs || []).some((j) => ['queued', 'running'].includes(j.state)) || S.opp.items.some((x) => ['queued', 'running'].includes(x.researchJob?.state));
  if (running) S.opp.timer = setTimeout(opportunitiesLoad, 2500);
}
function opportunitiesPatch(force = false) {
  const root = $('opportunities');
  if (!root || S.mode !== 'opportunities') return;
  // Background jobs may refresh results, but never replace unfinished input.
  if (!force && root.querySelector('form[data-dirty="true"]')) {
    const status = root.querySelector('[data-opbackground]');
    if (status) status.textContent = 'Research updates available. Save your changes to see them.';
    return;
  }
  const focused = document.activeElement?.closest?.('#opportunities') ? document.activeElement : null;
  const focusId = focused?.id;
  const opened = [...root.querySelectorAll('details[open]')].map((d) => d.dataset.opdetails).filter(Boolean);
  root.innerHTML = opportunitiesBody();
  for (const key of opened) root.querySelector(`details[data-opdetails="${CSS.escape(key)}"]`)?.setAttribute('open', '');
  if (focusId) $(focusId)?.focus({ preventScroll: true });
}
function renderOpportunities() {
  setHTML($('mTitle'), 'Opportunities');
  if ($('opportunities') && $('dbody')._mode === 'opportunities') return opportunitiesPatch();
  modeHTML(`<header class="vh"><h2>${ICON.bulb}Opportunities</h2><p>An evidence notebook for new products, buyer experiments and revenue.</p></header>` + opportunitiesView());
}
function opportunitiesView() {
  if (!S.opp.loaded && !S.opp.loading) queueMicrotask(opportunitiesLoad);
  else opportunitiesPoll();
  return `<section id="opportunities" aria-label="Business opportunities">${opportunitiesBody()}</section>`;
}
function opportunitiesBody() {
  const o = S.opp; o.fieldNames = {};
  const selected = o.items.find((x) => x.id === o.selected);
  const jobs = o.jobs.filter((j) => ['running', 'queued', 'error'].includes(j.state)).slice(-4);
  if (selected) return opportunityDossier(selected);
  const matches = o.items.filter((x) => Object.entries(o.filters).every(([k, v]) => !v || x[k] === v));
  const visible = o.more ? matches : matches.slice(0, 8);
  return `<div class="opintro"><div><p class="opeyebrow">Opportunity notebook</p><h3>Good questions.<br>Better businesses.</h3><p>Explore beyond what you already build. Keep the evidence, economics and next buyer test together.</p></div><button class="btn primary" data-opaction="create">${ICON.plus} Add a concept</button></div>
    <p class="hint" data-opbackground role="status"></p><div class="opfilters">${[['industry', 'Industry', oIndustries()], ['mode', 'Exploration', OMODES], ['stage', 'Evidence stage', OSTAGES]].map(([k, label, options]) => `<label for="op-filter-${k}"><span>${label}</span><select class="inp" id="op-filter-${k}" data-opfilter="${k}">${oOptions(options, o.filters[k], 'All ' + (k === 'mode' ? 'modes' : k === 'stage' ? 'stages' : 'industries'))}</select></label>`).join('')}</div>
    ${o.error ? `<p class="operror" role="alert">${esc(o.error)} <button class="link" data-opaction="refresh">Try again</button></p>` : ''}
    ${jobs.map(opportunityJob).join('')}
    ${o.create ? opportunityCreateForm() : ''}
    <details class="opdiscover" data-opdetails="generate"><summary>Explore with an agent <span>Choose a market and a direction</span></summary>${opportunityGenerateForm()}</details>
    <div class="oplisthead"><h4>${matches.length ? `Your shortlist <span>${visible.length} of ${matches.length}</span>` : 'Your opportunity notebook'}</h4><button class="link" data-opaction="import"${o.busy ? ' disabled' : ''}>Import from Discover</button></div>
    ${!o.loaded && !o.error ? '<p class="opempty" role="status"><span class="spin"></span> Opening your opportunity notebook…</p>' : !matches.length ? `<div class="opempty"><h4>${o.items.length ? 'No opportunities match these filters.' : 'Start with a problem worth solving.'}</h4><p>${o.items.length ? 'Try another industry, exploration mode or evidence stage.' : 'Add your own concept, explore a new market with an agent, or bring in saved ideas. Each starts as an unverified hypothesis.'}</p>${o.items.length ? '<button class="btn" data-opaction="clearfilters">Clear filters</button>' : '<button class="btn" data-opaction="create">Add your first concept</button>'}</div>` : `<div class="oplist">${visible.map(opportunityCard).join('')}</div>`}
    ${matches.length > visible.length ? `<button class="btn opmore" data-opaction="more">Explore all ${matches.length} opportunities</button>` : ''}
    <p class="opfootnote">Research-ready means the homework is documented. Purchase and renewal evidence have their own stages.</p>`;
}
function opportunityCard(x) {
  const primary = x.revenue?.valuePattern ? x.revenueRecommendation?.primary : null;
  const freshest = Math.max(0, ...(x.sources || []).map((s) => Number(s.fetchedAt) || 0));
  const unknown = oText(x.unknowns?.[0]) || oFriendly(x.readiness?.missing?.[0]) || 'Buyer willingness to pay has not been tested.';
  return `<article class="opcard"><div class="opcardmeta">${oStage(x.stage)}<span>${esc(oLabel(oIndustries(), x.industry))}</span><span>${esc(oLabel(OMODES, x.mode))}</span></div><button class="opopen" data-opopen="${esc(x.id)}"><h4>${esc(x.title)}</h4><span aria-hidden="true">↗</span></button><p class="opbuyer">${esc(x.buyer || 'Buyer not specified')}</p><p>${esc(x.problem || x.summary || 'Define the problem to investigate.')}</p><dl class="opcardfacts"><div><dt>Revenue hypothesis</dt><dd>${esc(primary?.label || primary?.model || primary?.name || 'Choose a value pattern')}</dd></div><div><dt>Biggest unknown</dt><dd>${esc(unknown)}</dd></div></dl><div class="opcardfoot"><span>${x.sources?.length || 0} sources · ${freshest ? 'Last checked ' + esc(oDate(freshest)) : 'Not researched'}</span><button class="link" data-opopen="${esc(x.id)}">Open dossier →</button></div></article>`;
}
function opportunityCreateForm() {
  return `<section class="opeditor"><div class="opsectionhead"><h4>A product hypothesis</h4><button class="link" data-opaction="closecreate">Close</button></div>${oForm('create', oField('title', 'Working title', '', { required: true, wide: true }) + oField('buyer', 'Who pays?', '', { required: true, hint: 'A specific role, team or customer segment.' }) + oField('industry', 'Industry', S.opp.filters.industry || oIndustries()[0]?.[0], { options: oIndustries() }) + oField('mode', 'Exploration mode', S.opp.filters.mode || 'markets', { options: OMODES }) + oField('problem', 'What costly or frustrating job do they face?', '', { required: true, rows: 3, wide: true }) + oField('mechanism', 'How could the product solve it?', '', { rows: 2, wide: true }), 'Create concept')}</section>`;
}
function opportunityGenerateForm() {
  return oForm('generate', oField('mode', 'Direction', S.opp.filters.mode || 'markets', { options: OMODES }) + oField('industry', 'Industry to explore', S.opp.filters.industry || oIndustries()[0]?.[0], { options: oIndustries() }) + `<p class="hint wide">New markets start with buyers and problems. Novel solutions explore a different mechanism; neither mode assumes demand or claims that no alternatives exist.</p><label class="opcheck wide"><input type="checkbox" name="consent" required> Send this direction to the configured agent to generate concepts. “Use my advantages” also includes a sanitized inventory of project and tool names. Generated claims remain unverified.</label>`, 'Generate concepts');
}
function opportunityJob(job) {
  const running = ['running', 'queued'].includes(job.state);
  return `<div class="opjob${job.state === 'error' ? ' operror' : ''}" role="status">${running ? '<span class="spin"></span>' : ''}<span>${esc(job.error || job.message || `Research ${job.state}`)}</span>${running ? `<button class="link" data-opcancel="${esc(job.id)}">Cancel</button>` : ''}</div>${['error', 'cancelled'].includes(job.state) ? `<details class="opedit" data-opdetails="retry-${esc(job.id)}"><summary>Retry this ${job.kind === 'generate' ? 'generation' : 'research'} job</summary>${oForm('retry', `<input type="hidden" name="job" value="${esc(job.id)}"><label class="opcheck wide"><input type="checkbox" name="consent" required> Send the same sanitized brief to the configured agent / public research services again. Existing evidence stays saved.</label>`, 'Retry job')}</details>` : ''}`;
}
function opportunityDossier(x) {
  const section = S.opp.section;
  const job = x.researchJob || S.opp.jobs.find((j) => j.itemId === x.id && j.kind === 'research');
  return `<div class="opback"><button class="link" data-opaction="back">← Opportunities</button><span>Saved ${esc(oDate(x.updatedAt))} · version ${Number(x.version) || 1}</span></div><header class="opdossierhead"><div class="opcardmeta">${oStage(x.stage)}<span>${esc(oLabel(oIndustries(), x.industry))}</span><span>${esc(oLabel(OMODES, x.mode))}</span></div><h3 tabindex="-1" id="op-dossier-title">${esc(x.title)}</h3><p>${esc(x.summary || x.problem)}</p></header>
    ${job ? opportunityJob(job) : ''}
    <p class="hint" data-opbackground role="status"></p><nav class="opsections" aria-label="Dossier sections">${OSECTIONS.map(([k, l]) => `<button data-opsection="${k}" aria-pressed="${section === k}">${l}</button>`).join('')}</nav>
    <div class="opsection" id="op-section">${section === 'summary' ? opportunitySummary(x) : section === 'demand' ? opportunityDemand(x) : section === 'alternatives' ? opportunityAlternatives(x) : section === 'economics' ? opportunityEconomics(x) : section === 'revenue' ? opportunityRevenue(x) : opportunityExperiments(x)}</div>`;
}
function opportunitySummary(x) {
  const missing = (x.readiness?.missing || []).map(oFriendly);
  return `<div class="opoverview"><div><p class="opeyebrow">The demand thesis</p><dl class="opdefinition"><dt>Buyer</dt><dd>${esc(x.buyer || 'Not specified')}</dd><dt>Problem</dt><dd>${esc(x.problem || 'Not specified')}</dd><dt>Proposed mechanism</dt><dd>${esc(x.mechanism || 'Not specified')}</dd><dt>Measurable outcome</dt><dd>${esc(x.outcome || 'Not specified')}</dd></dl></div><aside class="opreadiness"><h4>${x.readiness?.ready ? 'Research coverage complete' : 'Homework still to do'}</h4><p>${x.readiness?.independentGroups || 0} independent source groups</p>${missing.length ? `<ul>${missing.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p>Review the underlying claims before deciding what to test.</p>'}<button class="btn" data-opsection="demand">Review evidence</button></aside></div>
    ${(x.unknowns || []).length ? `<section class="opnotice"><h4>Uncertainties to resolve</h4><ul>${x.unknowns.map((u) => `<li>${esc(oText(u))}</li>`).join('')}</ul></section>` : ''}
    <details class="opedit" data-opdetails="summary"><summary>Edit the product hypothesis</summary>${oForm('summary', oField('title', 'Working title', x.title, { required: true, wide: true }) + oField('buyer', 'Buyer / budget owner', x.buyer, { required: true }) + oField('industry', 'Industry', x.industry, { options: oIndustries() }) + oField('mode', 'Exploration mode', x.mode, { options: OMODES }) + oField('summary', 'Summary', x.summary, { rows: 2, wide: true }) + oField('problem', 'Problem', x.problem, { required: true, rows: 3, wide: true }) + oField('mechanism', 'Proposed mechanism', x.mechanism, { rows: 2, wide: true }) + oField('outcome', 'Customer outcome', x.outcome, { rows: 2, wide: true }) + oField('unknowns', 'Biggest uncertainties — one per line', (x.unknowns || []).map(oText).join('\n'), { rows: 3, wide: true }) + oField('notes', 'Feasibility / build plan notes', x.notes, { rows: 4, wide: true }))}</details>`;
}
function opportunityDemand(x) {
  return `<div class="opsectionhead"><div><h4>Follow the evidence</h4><p class="hint">A retrieved source is a lead. Review the exact claim and contradictory evidence before treating it as observed.</p></div></div>
    <details class="opdiscover" data-opdetails="research"><summary>Research public sources <span>Bounded, opt-in source collection</span></summary>${oForm('research', `<p class="hint wide">The agent will search for the buyer, problem, closest alternatives, pricing and objections. Source failures and unanswered questions stay visible. No messages are sent to customers.</p><label class="opcheck wide"><input type="checkbox" name="deep"> Deep research: competitors, pricing, channels and counterevidence (uses Claude)</label><label class="opcheck wide"><input type="checkbox" name="consent" required> Send sanitized buyer, problem and product terms to public research services and, for deep research, the configured Claude agent. Do not include private customer information.</label>`, 'Research this opportunity')}</details>
    <h4 class="opsubhead">Claims <span>${(x.claims || []).length}</span></h4>${(x.claims || []).length ? x.claims.map((c) => `<article class="opclaim"><span class="opstatus">${esc(c.status || 'unknown')}</span><p>${esc(c.text || c.statement)}</p><small>${esc(c.notes || c.reviewNotes || '')}</small><div class="opsourcelinks">${(c.sourceIds || c.supportingSourceIds || []).map((id) => { const s = (x.sources || []).find((s) => s.id === id); return s ? oSafeLink(s.url, s.title || s.publisher || s.url) : `<span>Missing source ${esc(id)}</span>`; }).join(' · ')}</div>${c.opposingSourceIds?.length ? `<p class="opsourcelinks"><strong>Counterevidence:</strong> ${c.opposingSourceIds.map((id) => { const source = x.sources.find((s) => s.id === id); return source ? oSafeLink(source.url, source.title || source.url) : esc(id); }).join(' · ')}</p>` : ''}<details class="opedit" data-opdetails="claim-${esc(c.id)}"><summary>Review or revise this claim</summary>${opportunityClaimForm(x, c)}</details></article>`).join('') : '<p class="opblank">No claims recorded. Add a precise statement and its basis.</p>'}
    <details class="opedit" data-opdetails="claim"><summary>Add a claim</summary>${opportunityClaimForm(x)}</details>
    <h4 class="opsubhead">Source notebook <span>${(x.sources || []).length}</span></h4>${(x.sources || []).length ? `<ol class="opsources">${x.sources.map((s) => `<li><div>${oSafeLink(s.url, s.title || s.publisher || s.url)} <span class="opstatus">${esc(s.accessState || s.access || 'unreviewed')}</span></div><p>${esc(s.excerpt || s.locator || 'No excerpt recorded.')}</p>${opportunitySourceCaveat(s)}<small>Retrieved ${esc(oDate(s.fetchedAt || s.retrievedAt))}${s.publishedAt ? ` · Published ${esc(oDate(s.publishedAt))}` : ''} · Group: ${esc(s.independenceGroup || 'not assigned')}</small>${s.error ? `<p class="operror">${esc(s.error)}</p>` : ''}<details class="opedit" data-opdetails="source-${esc(s.id)}"><summary>Review or update this source</summary>${opportunitySourceForm(s)}</details></li>`).join('')}</ol>` : '<p class="opblank">No sources yet. Record original URLs and dated excerpts, including evidence against the idea.</p>'}
    <details class="opedit" data-opdetails="source"><summary>Add a source</summary>${opportunitySourceForm()}</details>
    <details class="opedit" data-opdetails="review"><summary>Record a coverage review</summary>${opportunityReviewForm(x)}</details>
    ${(x.reviews || []).length ? `<div class="opreviews">${x.reviews.map((r) => `<p><strong>${esc(r.dimension || r.area || 'Review')}</strong> · ${esc(r.status || 'pending')}<br>${esc(r.notes || r.summary || '')}</p>`).join('')}</div>` : ''}
    ${(x.searches || []).length ? `<details class="opedit"><summary>Search scope &amp; failures</summary>${x.searches.map((s) => `<p><b>${esc(s.query || s.scope)}</b> · ${esc(oDate(s.at || s.searchedAt))}<br>${esc(s.error || s.notes || s.result || s.status || '')}</p>`).join('')}<p class="hint">No close match found in a search is not proof of global nonexistence.</p></details>` : ''}`;
}
const ODIMENSIONS = [['buyer', 'Buyer & budget'], ['problem', 'Problem & spending'], ['alternatives', 'Alternatives'], ['distribution', 'Distribution'], ['feasibility', 'Feasibility'], ['economics', 'Economics']];
const OCLAIMS = [['assumed', 'Assumed'], ['unknown', 'Unknown'], ['inferred', 'Inferred'], ['observed', 'Observed'], ['contradicted', 'Contradicted']];
function opportunitySourceCaveat(source) {
  return source.id?.startsWith('web-') && source.checkedBy === 'retrieval' ? '<small>Tool-returned text may be a generated summary. Check the original page before quoting it or marking claims observed.</small>' : '';
}
function opportunitySourceForm(source = {}) {
  return oForm('source', `<input type="hidden" name="id" value="${esc(source.id || '')}">` + oField('url', 'Original public URL', source.url || '', { type: 'url', required: true, wide: true }) + oField('title', 'Source title', source.title || '', { required: true }) + oField('kind', 'Source type', source.kind || 'customer', { options: [['customer', 'Customer evidence'], ['competitor', 'Competitor / alternative'], ['documentation', 'Technical documentation'], ['other', 'Other']] }) + oField('access', 'Access result', source.access || 'unverified', { options: [['unverified', 'Not checked yet'], ['opened', 'Page opened'], ['failed', 'Could not access']] }) + oField('excerpt', 'Checked excerpt or page locator (replace tool summaries)', source.excerpt || '', { rows: 3, wide: true, required: true }) + `<label class="opcheck wide"><input type="checkbox" name="attest" required> I am recording the actual source and access result, including limitations.</label>`, 'Add source');
}
function opportunitySourceChecks(x, name, title, selected = []) {
  return `<fieldset class="opchecks wide"><legend>${esc(title)}</legend>${(x.sources || []).length ? x.sources.map((s) => `<label><input type="checkbox" name="${name}" value="${esc(s.id)}"${selected.includes(s.id) ? ' checked' : ''}> ${esc(s.title || s.url)} <small>${esc(s.access || 'unverified')}</small></label>`).join('') : '<p class="hint">Add an original source first.</p>'}</fieldset>`;
}
function opportunityClaimForm(x, claim = {}) {
  return oForm('claim', `<input type="hidden" name="id" value="${esc(claim.id || '')}">` + oField('text', 'One specific claim', claim.text || '', { rows: 3, wide: true, required: true }) + oField('dimension', 'Research dimension', claim.dimension || 'problem', { options: ODIMENSIONS }) + oField('status', 'Evidence status', claim.status || 'assumed', { options: OCLAIMS }) + opportunitySourceChecks(x, 'supportingSourceIds', 'Supporting sources', claim.supportingSourceIds) + opportunitySourceChecks(x, 'opposingSourceIds', 'Opposing sources', claim.opposingSourceIds) + `<label class="opcheck wide"><input type="checkbox" name="attest" required> I reviewed whether these sources support or contradict this exact claim. Generated suggestions alone are not observed evidence.</label>`, 'Record reviewed claim');
}
function opportunityReviewForm(x) {
  return oForm('review', oField('dimension', 'Dimension reviewed', 'problem', { options: ODIMENSIONS }) + opportunitySourceChecks(x, 'sourceIds', 'Sources checked') + oField('notes', 'What is supported, what contradicts it, and what is still unknown?', '', { rows: 4, wide: true, required: true }) + `<label class="opcheck wide"><input type="checkbox" name="attest" required> I have checked the linked sources and recorded the material gaps.</label>`, 'Save coverage review');
}
function opportunityAlternatives(x) {
  const sources = (x.sources || []).filter((s) => s.kind === 'competitor');
  const claims = (x.claims || []).filter((c) => c.dimension === 'alternatives');
  return `<div class="opsectionhead"><div><h4>What do buyers do today?</h4><p class="hint">Compare direct products, services, manual workarounds and doing nothing. A public price is an offer, not proof of sales.</p></div></div>
    ${sources.length ? `<ul class="opsources">${sources.map((s) => `<li>${oSafeLink(s.url, s.title || s.url)} <span class="opstatus">${esc(s.access)}</span><p>${esc(s.excerpt || 'No pricing or workflow excerpt recorded.')}</p>${opportunitySourceCaveat(s)}<small>Checked ${esc(oDate(s.fetchedAt))}</small></li>`).join('')}</ul>` : '<p class="opblank">No alternatives documented yet. Search adjacent industries and broader descriptions of the job before concluding that a gap exists.</p>'}
    ${claims.map((c) => `<article class="opclaim"><span class="opstatus">${esc(c.status)}</span><p>${esc(c.text)}</p></article>`).join('')}
    <div class="opnotice"><h4>The proposed difference</h4><p>${esc(x.mechanism || 'Describe the different mechanism in Overview, then test whether the outcome matters to buyers.')}</p><p class="hint">Novelty, evidence of a painful problem, and validation of this product are separate questions.</p></div>
    <button class="btn" data-opsection="demand">Add competitor sources &amp; compare claims</button>`;
}
function opportunityExperiments(x) {
  return `<div class="opsectionhead"><div><h4>Let buyers change your mind.</h4><p class="hint">Define the offer, sample and decision rules before collecting results. Failed tests are useful evidence too.</p></div></div>
    ${(x.experiments || []).length ? x.experiments.map((e) => `<article class="opexperiment"><div class="opcardmeta">${oStage(e.kind)}<span>${esc(e.result?.outcome || e.status || e.state || 'Planned')}</span></div><h5>${esc(e.hypothesis)}</h5><dl class="opdefinition"><dt>Who / where</dt><dd>${esc(e.segment)} · ${esc(e.channel)}</dd><dt>Offer</dt><dd>${esc(e.offer)}</dd><dt>Success rule</dt><dd>${esc(opportunitySuccessText(e.successCriteria))}</dd><dt>Rejection rule</dt><dd>${esc(e.failureCriteria || 'Not recorded')}</dd><dt>Budget</dt><dd>${e.budget != null ? oMoney(e.budget, e.currency || 'USD') : 'Not recorded'}</dd></dl>${e.result ? `<div class="opnotice"><h5>Recorded outcome</h5><p>${esc(String(e.result.successes))} successes / ${esc(String(e.result.denominator))} participants · ${esc(e.result.payingCustomers ?? 0)} paying customers · ${oMoney(e.result.revenue ?? 0, e.currency || 'USD')} receipts${e.kind === 'repeat-use' ? ` · ${esc(e.result.repeatCustomers ?? 0)} returning customers · ${esc(e.result.repeatPayments ?? 0)} distinct returning customers paid again over ${esc(e.result.windowDays ?? 0)} days` : ''}</p><p>${esc(e.result.notes || '')}</p><small>Evidence: ${esc(e.result.evidenceReference)} · ${esc(oDate(e.result.observedAt))}</small></div>` : `<details class="opedit" data-opdetails="result-${esc(e.id)}"><summary>Record the observed result</summary>${opportunityResultForm(e)}</details>`}</article>`).join('') : '<p class="opblank">No buyer tests yet. Start with the cheapest experiment that can resolve your largest uncertainty.</p>'}
    <details class="opedit" data-opdetails="experiment"><summary>Plan a buyer experiment</summary>${oForm('experiment', oField('kind', 'Evidence to collect', 'buying-signal', { options: OSTAGES.slice(2) }) + oField('hypothesis', 'Testable hypothesis', '', { required: true, rows: 2, wide: true }) + oField('segment', 'Customer segment', x.buyer, { required: true }) + oField('channel', 'Recruitment channel', '', { required: true }) + oField('offer', 'Exact offer, price and terms', '', { required: true, rows: 3, wide: true }) + oField('minParticipants', 'Minimum participants', '', { type: 'number', min: 1, step: 1, required: true }) + oField('minSuccesses', 'Minimum successes', '', { type: 'number', min: 1, step: 1, required: true }) + oField('minNetRevenue', 'Minimum net receipts (optional)', '', { type: 'number', min: 0 }) + oField('minRepeatCustomers', 'Minimum returning paying customers (optional)', '', { type: 'number', min: 0, step: 1 }) + oField('failureCriteria', 'When should we reject or revise the hypothesis?', '', { required: true, rows: 2, wide: true }) + oField('budget', 'Maximum cash budget', '', { type: 'number', min: 0, required: true }) + oField('currency', 'Currency', 'USD', { maxlength: 3 }) + oField('startsAt', 'Planned start', '', { type: 'date' }) + oField('endsAt', 'Planned end', '', { type: 'date' }) + `<p class="hint wide">For a paid pilot, successes mean paying customers. For repeat use, count distinct returning customers who paid again, following a paid pilot for the same segment. This saves a plan; it does not contact customers, publish an offer or charge anyone.</p>`, 'Save experiment plan')}</details>`;
}
function opportunitySuccessText(c = {}) { return `At least ${c.minParticipants ?? '?'} participants, ${c.minSuccesses ?? '?'} successes${c.minSuccessRate != null ? `, ${Math.round(c.minSuccessRate * 100)}% conversion` : ''}${c.minNetRevenue != null ? `, ${c.minNetRevenue} net receipts` : ''}${c.minRepeatCustomers != null ? `, ${c.minRepeatCustomers} returning paying customers` : ''}.`; }
function opportunityResultForm(e) {
  return oForm('result', `<input type="hidden" name="experimentId" value="${esc(e.id)}">` + oField('denominator', 'Actual participants', '', { type: 'number', min: 0, step: 1, required: true }) + oField('successes', e.kind === 'paid-pilot' ? 'Paying customers meeting the offer terms' : e.kind === 'repeat-use' ? 'Returning paying customers meeting the terms' : 'Successful target actions', '', { type: 'number', min: 0, step: 1, required: true }) + oField('payingCustomers', 'Paying customers', '', { type: 'number', min: 0, step: 1 }) + oField('revenue', 'Actual receipts', '', { type: 'number', min: 0 }) + oField('refunds', 'Refunded amount', '', { type: 'number', min: 0 }) + oField('repeatCustomers', 'Returning customers', '', { type: 'number', min: 0, step: 1 }) + oField('repeatPayments', 'Returning customers who paid again (distinct)', '', { type: 'number', min: 0, step: 1 }) + oField('windowDays', 'Observation window (days)', '', { type: 'number', min: 1, step: 1 }) + oField('evidenceReference', 'Evidence reference', '', { required: true, wide: true, hint: 'A local receipt / cohort record reference. Do not paste customer secrets.' }) + oField('notes', 'Result, limitations and what happens next', '', { rows: 3, wide: true }) + `<label class="opcheck wide"><input type="checkbox" name="attest" required> These are actual observed results, not a forecast or an agent estimate.</label>`, 'Record actual result');
}
const OECON = [
  ['Offer & customer base', [['activeCustomers', 'Customers at launch', 'customers'], ['pricePerCustomer', 'Monthly price / job or usage-unit price', 'currency'], ['unitsPerCustomer', 'Usage units per customer per month', 'units'], ['setupFee', 'One-time setup charge', 'currency', 0], ['refundRate', 'Revenue refunded', '%', 0], ['paymentFeeRate', 'Payment processing rate', '%', 0], ['paymentFeeFixed', 'Fixed fee per payment', 'currency', 0]]],
  ['Acquisition & retention', [['cac', 'Cash acquisition cost per new customer', 'currency'], ['monthlyChurn', 'Monthly customer churn', '%'], ['newCustomersPerMonth', 'New paying customers after launch', 'customers / month'], ['startupCost', 'Startup cash before launch', 'currency']]],
  ['Delivery & founder capacity', [['variableCostPerCustomer', 'Cash delivery cost per customer / job / unit', 'currency'], ['fixedMonthlyCost', 'Fixed monthly cash overhead', 'currency / month'], ['founderHoursPerMonth', 'Fixed founder operating time', 'hours / month'], ['founderHourlyRate', 'Value of founder time', 'currency / hour'], ['hoursPerCustomer', 'Founder delivery / support time', 'hours / customer / month or job', 0], ['onboardingCost', 'Cash onboarding cost per new customer', 'currency', 0], ['onboardingHoursPerCustomer', 'Founder onboarding time', 'hours / new customer', 0], ['salesHoursPerNewCustomer', 'Founder sales time', 'hours / new customer', 0], ['availableHoursPerMonth', 'Total founder capacity', 'hours / month']]],
];
const OECONFIELDS = OECON.flatMap((g) => g[1]);
function opportunityEconomics(x) {
  const input = x.economics || {};
  const value = (key, fallback) => { const raw = input[key]; return raw && typeof raw === 'object' ? raw.value : raw ?? fallback ?? ''; };
  return `<div class="opsectionhead"><div><h4>Show the working.</h4><p class="hint">Conditional scenarios, not sales forecasts. Leave unknown inputs blank. Editing a measurement turns it into a planning assumption until it is checked again.</p></div></div>
    <div id="op-econ-results" aria-live="polite">${opportunityEconomicsResult(x.analysis)}</div>
    <form data-opform="economics" class="opform"><div class="opfields">${oField('model', 'Revenue model', input.model || 'subscription', { options: [['subscription', 'Subscription'], ['usage', 'Usage'], ['one-time', 'One-time purchase'], ['service', 'Paid service / pilot'], ['license', 'License']] })}${oField('currency', 'Currency', input.currency || 'USD', { maxlength: 3 })}${oField('billingPeriodMonths', 'Billing period', String(input.billingPeriodMonths || 1), { options: [['1', 'Monthly / per job'], ['12', 'Annual prepayment (subscription / license)']] })}<p class="hint wide">For annual billing, enter the monthly-equivalent price. The projection separates revenue from upfront cash receipts.</p></div>${OECON.map(([title, fields]) => `<fieldset class="opinputgroup"><legend>${title}</legend><div class="opfields">${fields.map(([key, label, unit, fallback]) => { const v = value(key, fallback); const a = input[key]; const basis = a && typeof a === 'object' ? a.basis || 'assumed' : v === '' ? 'unknown' : 'assumed'; return oField(key, label, v === '' || v == null ? '' : unit === '%' ? Number(v) * 100 : v, { type: 'number', min: 0, max: unit === '%' ? 100 : undefined, hint: `${unit} · ${basis}${a?.note ? ' · ' + a.note : ''}` }); }).join('')}</div></fieldset>`).join('')}<p data-opformerror class="operror" role="alert" hidden></p><div class="opactions"><button class="btn primary" type="submit">Save assumptions</button><span data-opformstatus class="hint" role="status">Calculations update as you edit. Save to keep changes.</span></div></form>
    <details class="opedit" data-opdetails="financial-evidence"><summary>Attach evidence to a financial input</summary><p class="hint">Use a dated invoice, measured cohort, pricing page or operating record. A competitor’s price supports a comparable offer; it does not establish what your own buyers will pay.</p>${oForm('financial-evidence', oField('inputKey', 'Financial input', 'pricePerCustomer', { options: OECONFIELDS.map(([key, label, unit]) => [key, `${label} (${unit})`]), wide: true }) + oField('basis', 'Basis', 'assumed', { options: [['assumed', 'Planning assumption'], ['observed', 'Measurement I checked'], ['unknown', 'Unknown — clear the number']] }) + oField('observedAt', 'Date checked', '', { type: 'date' }) + oField('note', 'Measurement or assumption basis and limitations', '', { rows: 3, wide: true, required: true }) + opportunitySourceChecks(x, 'sourceIds', 'Supporting sources (or describe a local record above)') + `<label class="opcheck wide"><input type="checkbox" name="attest" required> I checked the basis for this saved input. Marking it observed does not verify future performance.</label><p class="hint wide">Save your numerical inputs first. This updates the basis of the saved value; “Unknown” clears it.</p>`, 'Save input evidence')}</details>`;
}
function opportunityEconomicsResult(a) {
  if (!a) return '<p class="opblank">Enter explicit assumptions to calculate margins, acquisition payback, capacity and 12-month cash needs.</p>';
  const currency = a.currency || 'USD', money = (v) => oMoney(v, currency), s = a.steadyState || {}, u = a.unitEconomics || {}, p = a.projection || {};
  const number = (v, digits = 1) => v == null ? 'Unknown' : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(v);
  const labels = Object.fromEntries(OECONFIELDS.map((f) => [f[0], f[1]]));
  return `<section class="opcalculation"><div class="opsectionhead"><h5>Current scenario</h5><span class="opstatus">${a.missingInputs?.length ? 'Incomplete inputs' : 'Conditional arithmetic'}</span></div>${(a.errors || []).map((m) => `<p class="operror" role="alert">${esc(m)}</p>`).join('')}
    <dl class="opnumbers"><div><dt>Monthly revenue</dt><dd>${money(s.revenue)}</dd></div><div><dt>Monthly cash surplus</dt><dd>${money(s.cashSurplus)}</dd></div><div><dt>After founder time</dt><dd>${money(s.economicSurplus)}</dd></div><div><dt>Cash needed before break-even</dt><dd>${money(p.cashRequired)}</dd></div></dl>
    <div class="optablewrap"><table class="optable"><caption>Unit economics &amp; operating constraints</caption><tbody><tr><th scope="row">Cash contribution / customer or job</th><td>${money(u.cashContribution)}</td></tr><tr><th scope="row">Contribution after founder delivery time</th><td>${money(u.economicContribution)}</td></tr><tr><th scope="row">Simple acquisition payback, before churn</th><td>${number(u.simplePaybackMonths)}${u.simplePaybackMonths != null ? ' months' : ''}</td></tr><tr><th scope="row">12-month cohort contribution after acquisition</th><td>${money(u.cohort12MonthContributionAfterCAC)}</td></tr><tr><th scope="row">Break-even customers, including founder time</th><td>${number(s.economicBreakEvenCustomers, 0)}</td></tr><tr><th scope="row">Cost of acquiring initial customers</th><td>${money(s.initialAcquisitionCost)}</td></tr><tr><th scope="row">Fits founder capacity</th><td>${s.withinCapacity == null ? 'Unknown' : s.withinCapacity ? 'Yes, under these assumptions' : 'No — exceeds available hours'}</td></tr><tr><th scope="row">12-month ending cash</th><td>${money(p.endingCash)}</td></tr></tbody></table></div>
    ${a.missingInputs?.length ? `<p class="opnotice"><strong>Still unknown:</strong> ${a.missingInputs.map((k) => esc(labels[k] || k)).join(', ')}.</p>` : ''}
    ${(a.warnings || []).length ? `<ul class="opwarnings">${a.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <details class="opedit" data-opdetails="cashflow"><summary>12-month cash flow</summary><div class="optablewrap" tabindex="0" aria-label="Scrollable 12-month cash flow table"><table class="optable"><thead><tr><th scope="col">Month</th><th scope="col">Customers</th><th scope="col">Recurring revenue</th><th scope="col">One-time revenue</th><th scope="col">Cash receipts</th><th scope="col">Net cash</th><th scope="col">Cumulative cash</th><th scope="col">Capacity</th></tr></thead><tbody>${(p.months || []).map((m) => `<tr><th scope="row">${Number(m.month)}</th><td>${number(m.customers)}</td><td>${money(m.recurringRevenue)}</td><td>${money(m.oneTimeRevenue)}</td><td>${money(m.cashReceipts)}</td><td>${money(m.netCash)}</td><td>${money(m.cumulativeCash)}</td><td>${m.capacityExceeded == null ? '?' : m.capacityExceeded ? 'Exceeded' : 'Within limit'}</td></tr>`).join('')}</tbody></table></div></details>
    <details class="opedit" data-opdetails="sensitivity"><summary>What changes the result?</summary><p class="hint">One assumption changes at a time. These are arithmetic comparisons, not probabilities.</p><div class="optablewrap"><table class="optable"><thead><tr><th scope="col">Assumption</th><th scope="col">New value</th><th scope="col">Monthly surplus after founder time</th><th scope="col">Change</th></tr></thead><tbody>${(a.sensitivity || []).map((r) => `<tr><th scope="row">${esc(labels[r.input] || r.input)} · ${esc(r.direction)}</th><td>${r.input === 'monthlyChurn' ? number(r.value * 100) + '%' : number(r.value)}</td><td>${money(r.economicSurplus)}</td><td>${money(r.delta)}</td></tr>`).join('')}</tbody></table></div></details>
    <details class="opedit" data-opdetails="conventions"><summary>Assumptions &amp; calculation conventions</summary><ul>${(a.conventions || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul><dl class="opdefinition">${Object.entries(a.assumptions || {}).map(([k, v]) => `<dt>${esc(labels[k] || k)}</dt><dd>${v.value == null ? 'Unknown' : esc(String(v.value))} ${esc(v.unit || '')} · ${esc(v.basis || 'assumed')}${v.defaulted ? ' (default)' : ''}${v.note ? `<br>${esc(v.note)}` : ''}${v.sourceIds?.length ? `<br>Sources: ${v.sourceIds.map(esc).join(', ')}` : ''}</dd>`).join('')}</dl></details></section>`;
}
function opportunityEconomicsInput(form) {
  const old = S.opp.items.find((x) => x.id === S.opp.selected)?.economics || {};
  const data = new FormData(form), input = { model: data.get('model'), currency: String(data.get('currency') || 'USD').toUpperCase(), billingPeriodMonths: Number(data.get('billingPeriodMonths')) };
  for (const [key, , unit] of OECONFIELDS) {
    const entered = String(data.get(key) ?? '').trim();
    const value = entered === '' ? null : Number(entered) / (unit === '%' ? 100 : 1);
    const previous = old[key], oldValue = previous && typeof previous === 'object' ? previous.value : previous;
    input[key] = value === oldValue && previous != null ? previous : { value, basis: value == null ? 'unknown' : 'assumed', note: value == null ? 'Not yet measured or estimated.' : 'User-entered planning assumption; not validated.' };
  }
  return input;
}
async function opportunityCalculate(form) {
  const seq = ++S.opp.calcSeq, id = S.opp.selected;
  try { const r = await api('/api/opportunities/calculate', { economics: opportunityEconomicsInput(form) }); if (seq !== S.opp.calcSeq || id !== S.opp.selected || !$('op-econ-results')) return; $('op-econ-results').innerHTML = opportunityEconomicsResult(r.analysis); }
  catch (e) { if (seq !== S.opp.calcSeq || !form.isConnected) return; const el = form.querySelector('[data-opformstatus]'); if (el) el.textContent = e.message; }
}
function opportunityRevenue(x) {
  const input = x.revenue || {}, rec = x.revenue?.valuePattern ? x.revenueRecommendation : null;
  const patterns = [['urgent', 'Urgent result requiring hands-on delivery'], ['continuous', 'Continuous operational value'], ['episodic', 'Occasional jobs / variable processing'], ['finite', 'Finite deliverable'], ['embedded', 'Capability another business embeds'], ['transaction', 'Facilitating transactions'], ['audience', 'Audience with purchase intent']];
  const stream = (s, primary) => `<article class="opstream"><p class="opeyebrow">${primary ? 'Primary model to test' : 'Complementary stream'}</p><h5>${esc(s.label)}</h5><p>${esc(s.reason)}</p><dl class="opdefinition"><dt>Payer</dt><dd>${esc(s.payer)}</dd><dt>Charging unit</dt><dd>${esc(s.billingUnit)}</dd><dt>Price basis</dt><dd>${esc(s.priceBasis || 'Unknown — research comparables and test a specific offer.')}</dd><dt>What must be true</dt><dd><ul>${(s.prerequisites || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></dd><dt>Next experiment</dt><dd>${esc(s.experiment)}</dd></dl></article>`;
  return `<div class="opsectionhead"><div><h4>Charge for the value delivered.</h4><p class="hint">Recommendations are rule-based hypotheses. They depend on buyer behavior and need a real price test.</p></div></div>${rec?.primary ? stream(rec.primary, true) : '<p class="opblank">Describe the value pattern to get a revenue model hypothesis.</p>'}
    ${(rec?.complementary || []).map((s) => stream(s, false)).join('')}${rec?.validationPath?.length ? `<div class="opnotice"><h5>Validation path</h5><ol>${rec.validationPath.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}${(rec?.warnings || []).map((w) => `<p class="hint">${esc(w)}</p>`).join('')}
    <details class="opedit" data-opdetails="revenue"${!input.valuePattern ? ' open' : ''}><summary>Describe how the customer gets value</summary>${oForm('revenue', oField('valuePattern', 'Customer value pattern', input.valuePattern || 'urgent', { options: patterns, wide: true }) + oField('buyer', 'Payer', input.buyer || x.buyer, { required: true }) + oField('frequency', 'Usage frequency', input.frequency || 'unknown', { options: [['unknown', 'Unknown'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['occasional', 'Occasional'], ['one-off', 'One-off']] }) + [['handsOn', 'Delivery requires hands-on work'], ['newMarket', 'I am entering an unfamiliar market'], ['hasAudience', 'I have an established, reachable audience']].map(([key, label]) => `<label class="opcheck wide"><input type="checkbox" name="${key}"${input[key] ? ' checked' : ''}> ${label}</label>`).join('') + `<p class="hint wide">Repeat use is established by recorded experiments. Complementary streams are not automatically added together in the financial model.</p>`, 'Update revenue recommendation')}</details><button class="btn" data-opsection="economics">Model the economics</button>`;
}
function opportunityCurrent() { return S.opp.items.find((x) => x.id === S.opp.selected); }
function opportunityFormError(form, message) { const el = form.querySelector('[data-opformerror]'); if (el) { el.textContent = message; el.hidden = !message; } }
async function opportunitySubmit(form) {
  const kind = form.dataset.opform, data = new FormData(form), f = Object.fromEntries(data), item = opportunityCurrent(), id = item?.id;
  const button = form.querySelector('button[type="submit"]');
  if (button?.disabled) return;
  opportunityFormError(form, '');
  if (button) button.disabled = true;
  const status = form.querySelector('[data-opformstatus]'); if (status) status.textContent = 'Saving…';
  try {
    let r;
    if (kind === 'create') {
      r = await api('/api/opportunities/create', f); S.opp.selected = r.item.id; S.opp.section = 'summary'; S.opp.create = false;
    } else if (kind === 'generate') {
      r = await api('/api/opportunities/generate', { mode: f.mode, industry: f.industry, consent: f.consent === 'on' });
      if (r.job) { S.opp.jobs = S.opp.jobs.filter((j) => j.id !== r.job.id); S.opp.jobs.unshift(r.job); }
      for (const x of r.items || []) oAccept(x);
      toast('Concept generation started. Claims will remain unverified.');
    } else if (kind === 'retry') {
      r = await api('/api/opportunities/retry', { job: f.job, consent: f.consent === 'on' });
      if (r.job) S.opp.jobs.push(r.job);
    } else if (kind === 'summary') {
      const { unknowns, ...patch } = f;
      r = await api('/api/opportunities/update', { id, patch });
      const nextUnknowns = String(unknowns || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(nextUnknowns) !== JSON.stringify(item.unknowns || [])) r = await api('/api/opportunities/evidence', { id, attest: true, research: { unknowns: nextUnknowns } });
    } else if (kind === 'research') {
      r = await api('/api/opportunities/research', { id, consent: f.consent === 'on', deep: f.deep === 'on' });
      if (r.job) S.opp.jobs.unshift(r.job);
    } else if (kind === 'source') {
      r = await api('/api/opportunities/evidence', { id, attest: f.attest === 'on', research: { sources: [{ ...(f.id ? item.sources.find((s) => s.id === f.id) || { id: f.id } : {}), url: f.url, title: f.title, kind: f.kind, excerpt: f.excerpt, access: f.access, fetchedAt: Date.now() }] } });
    } else if (kind === 'claim') {
      r = await api('/api/opportunities/evidence', { id, attest: f.attest === 'on', research: { claims: [{ ...(f.id ? item.claims.find((c) => c.id === f.id) || { id: f.id } : {}), text: f.text, dimension: f.dimension, status: f.status, supportingSourceIds: data.getAll('supportingSourceIds'), opposingSourceIds: data.getAll('opposingSourceIds') }] } });
    } else if (kind === 'review') {
      r = await api('/api/opportunities/evidence', { id, attest: f.attest === 'on', research: { reviews: [{ dimension: f.dimension, sourceIds: data.getAll('sourceIds'), notes: f.notes }] } });
    } else if (kind === 'economics') {
      clearTimeout(S.opp.calcTimer); S.opp.calcSeq++;
      r = await api('/api/opportunities/update', { id, patch: { economics: opportunityEconomicsInput(form) } });
    } else if (kind === 'financial-evidence') {
      if (!OECONFIELDS.some(([key]) => key === f.inputKey)) throw new Error('Choose a financial input.');
      const existing = item.economics || {}, raw = existing[f.inputKey], value = raw && typeof raw === 'object' ? raw.value : raw;
      if (f.basis !== 'unknown' && (value == null || !Number.isFinite(Number(value)))) throw new Error('Enter and save a numerical value for this input first.');
      if (f.basis === 'observed' && data.getAll('sourceIds').some((id) => { const source = item.sources.find((s) => s.id === id); return !source || source.access !== 'opened' || !source.checkedBy; })) throw new Error('Open and review the selected sources before attaching them to an observed input.');
      if (f.basis === 'observed' && !f.observedAt) throw new Error('Record when you checked this measurement.');
      if (f.observedAt && Date.parse(f.observedAt) > Date.now()) throw new Error('A checked measurement cannot be dated in the future.');
      const economics = { ...existing, [f.inputKey]: { value: f.basis === 'unknown' ? null : Number(value), basis: f.basis, note: f.note, sourceIds: data.getAll('sourceIds'), ...(f.observedAt ? { observedAt: f.observedAt } : {}) } };
      r = await api('/api/opportunities/update', { id, patch: { economics } });
    } else if (kind === 'revenue') {
      r = await api('/api/opportunities/update', { id, patch: { buyer: f.buyer, revenue: { valuePattern: f.valuePattern, buyer: f.buyer, frequency: f.frequency, handsOn: f.handsOn === 'on', newMarket: f.newMarket === 'on', hasAudience: f.hasAudience === 'on' } } });
    } else if (kind === 'experiment') {
      const successCriteria = { minParticipants: Number(f.minParticipants), minSuccesses: Number(f.minSuccesses) };
      for (const k of ['minNetRevenue', 'minRepeatCustomers']) if (f[k] !== '') successCriteria[k] = Number(f[k]);
      const experiment = { kind: f.kind, hypothesis: f.hypothesis, segment: f.segment, channel: f.channel, offer: f.offer, successCriteria, failureCriteria: f.failureCriteria, budget: Number(f.budget), currency: f.currency };
      if (f.startsAt) { const today = new Date().toLocaleDateString('en-CA'); if (f.startsAt < today) throw new Error('Plan the experiment before collecting results. Choose today or a future start date.'); if (f.startsAt > today) experiment.startsAt = Date.parse(f.startsAt); }
      if (f.endsAt) experiment.endsAt = Date.parse(f.endsAt) + 86_399_999;
      r = await api('/api/opportunities/experiment', { id, experiment });
    } else if (kind === 'result') {
      const result = { evidenceReference: f.evidenceReference, notes: f.notes, observedAt: Date.now() };
      for (const key of ['denominator', 'successes', 'payingCustomers', 'revenue', 'refunds', 'repeatCustomers', 'repeatPayments', 'windowDays']) if (f[key] !== '') result[key] = Number(f[key]);
      r = await api('/api/opportunities/experiment/result', { id, experimentId: f.experimentId, result, attest: f.attest === 'on' });
    }
    if (r?.item) oAccept(r.item);
    form.dataset.dirty = 'false';
    if (status) status.textContent = 'Saved.';
    opportunitiesPatch(); opportunitiesPoll();
    if (!['generate', 'research'].includes(kind)) toast(kind === 'create' ? 'Concept added. Start with the largest uncertainty.' : 'Saved');
  } catch (e) { opportunityFormError(form, e.message); if (status) status.textContent = 'Review the error. Your input is still here.'; }
  finally { if (button?.isConnected) button.disabled = false; }
}
$('dbody').addEventListener('submit', (e) => {
  const form = e.target.closest('[data-opform]');
  if (!form) return;
  e.preventDefault();
  opportunitySubmit(form);
});
$('dbody').addEventListener('input', (e) => {
  const form = e.target.closest('[data-opform]');
  if (!form) return;
  form.dataset.dirty = 'true';
  if (form.dataset.opform === 'economics') { clearTimeout(S.opp.calcTimer); S.opp.calcTimer = setTimeout(() => opportunityCalculate(form), 350); }
});
$('dbody').addEventListener('change', (e) => {
  const filter = e.target.closest('[data-opfilter]');
  if (filter) { S.opp.filters[filter.dataset.opfilter] = filter.value; S.opp.more = false; opportunitiesPatch(true); }
});
$('dbody').addEventListener('click', async (e) => {
  if (S.mode !== 'opportunities') return;
  const t = e.target, open = t.closest('[data-opopen]'), section = t.closest('[data-opsection]'), cancel = t.closest('[data-opcancel]'), action = t.closest('[data-opaction]')?.dataset.opaction;
  if (!open && !section && !cancel && !action) return;
  if (action === 'discard') { opportunitiesPatch(true); return; }
  if ((open || section || ['back', 'closecreate', 'create'].includes(action)) && $('opportunities')?.querySelector('form[data-dirty="true"]')) {
    const notice = $('opportunities').querySelector('[data-opbackground]');
    if (notice) notice.innerHTML = 'Save your changes before switching views. <button class="link" data-opaction="discard">Discard edits</button>';
    return;
  }
  if (open) {
    try { const r = await api('/api/opportunities/item', { id: open.dataset.opopen }); oAccept(r.item); S.opp.selected = open.dataset.opopen; S.opp.section = 'summary'; opportunitiesPatch(true); $('op-dossier-title')?.focus(); $('dbody').scrollTop = 0; } catch (e) { toast(e.message, true); }
    return;
  }
  if (section) { S.opp.section = section.dataset.opsection; S.opp.calcSeq++; clearTimeout(S.opp.calcTimer); opportunitiesPatch(true); return; }
  if (action === 'create') { S.opp.create = true; opportunitiesPatch(true); $('op-title')?.focus(); return; }
  if (action === 'closecreate') { S.opp.create = false; opportunitiesPatch(true); return; }
  if (action === 'back') { S.opp.selected = null; opportunitiesPatch(true); $('dbody').scrollTop = 0; return; }
  if (action === 'more') { S.opp.more = true; opportunitiesPatch(true); return; }
  if (action === 'clearfilters') { S.opp.filters = { mode: '', industry: '', stage: '' }; opportunitiesPatch(true); return; }
  if (action === 'refresh') return opportunitiesLoad();
  if (action === 'import') {
    S.opp.busy = true; opportunitiesPatch();
    try { const r = await api('/api/opportunities/import', {}); for (const x of r.items || []) oAccept(x); toast(`Imported ${r.count || 0} saved ideas as unverified concepts.`); }
    catch (e) { toast(e.message, true); }
    finally { S.opp.busy = false; opportunitiesPatch(); }
    return;
  }
  if (cancel) {
    try { await api('/api/opportunities/cancel', { job: cancel.dataset.opcancel }); await opportunitiesLoad(); }
    catch (e) { toast(e.message, true); }
  }
});
// ── end Opportunities ──────────────────────────────────────────────────────
