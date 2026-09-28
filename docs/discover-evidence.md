# Discover evidence rules

Discover is a research queue. It cannot know that an idea will succeed. Claude proposes problem
hypotheses and small experiments; stored evidence and owner reviews determine what appears on the shortlist.

## New leads

- Opening Discover reads saved state. Public collection and model calls require an explicit search.
- Collected posts must have a public URL, a known publication date within 90 days, a nonempty problem
  excerpt, and a corpus collected within seven days. Exact normalized text, source IDs and URLs are
  deduplicated. This is conservative sampling, not a count of independent customers.
- At most six briefs enter one Claude call, taking different configured audiences in turn. The model
  can skip every brief. Only source IDs supplied with that brief can appear on the resulting card.
- Original excerpts and dates are retained. Unknown dates are excluded from new generation and shown
  as unknown on old cards. Source relevance remains unreviewed; grouping and problem wording still
  involve interpretation. No keyword-match fallback, trend substitution, Jev score, invented price or
  predicted payment date promotes an idea.
- Search gaps and an empty result are visible. This sampling does not establish market size or coverage.

## Stages and shortlist

| Stage | Required record |
| --- | --- |
| Untested idea | Default, including legacy high-scoring cards |
| Problem documented | Buyer and problem specified; current owner reviews of both; an owner-reviewed observed problem claim supported by at least two independent current customer-source groups with known publication dates; no material contradiction or current opposing evidence |
| Buyers interested | A recorded buying-signal experiment passes its predeclared criteria |
| Customers paid | A paid-pilot experiment passes using paying-customer counts |
| Customers returned | A repeat-use experiment passes using repeat-payment counts |

Source access, review expiry, source changes and buyer/problem pivots use the shared Opportunities
notebook rules. Sources sharing a publisher or duplicate text do not inflate independence. Source
age uses the claim's limit where supplied; buyer/problem reviews expire after 90 days.

Experiments are planned before results are recorded. Results require a denominator and a reference;
the shared notebook determines pass/fail/inconclusive from the saved criteria. Counts are never summed
across experiments because participants may overlap. Results are owner-reported, not verified with
a payment provider. Passing a test does not predict a successful business.

The shortlist contains at most five non-concept cards with no unresolved material objections or failed
tests for the current buyer/problem/mechanism. Cards with a failed test remain accessible, even after
a later pass; the failure is not erased. Ordering uses stage, last notebook update and title, never an
AI quality score. Earlier experiments remain in the notebook after a pivot but no longer establish the
new idea's stage.

## Persistence and compatibility

Discover's Evidence & tests tab and Opportunities use the same record. First open links/imports the
idea and its excerpts as unverified model claims; later opens preserve user edits. Reviewed card
snapshots live in `gallery/tracked.json` and saved snapshots in `gallery/saved.json`, outside dated cache
pruning. Generation uses separate `gallery-evidence-YYYY-MM-DD.json` files. Existing cards, kits and
legacy lab output remain available; their old confidence fields are omitted from the Discover API.

Core code: `src/ideagen/problem-gallery.ts`, `src/discover-evidence.ts`, `src/gallery-server.ts`.
Regression coverage: `test/discover-evidence.test.ts` and `test/discover-evidence-ui.test.ts`.
