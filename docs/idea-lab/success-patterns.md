# What successful small businesses have in common

A checklist distilled from public evidence, used as an explicit rubric by the idea engine (`src/ideagen/success.ts`):
Jev answers one yes/no question per pattern for each idea, and the pre-mortem names which pattern an idea breaks.
Numbers below are quoted from the sources, not ours.

| # | Pattern | What it looks like in an idea | Evidence |
|---|---|---|---|
| 1 | **A painful problem people already spend money or hours on** | The buyer already pays for a tool, a person or a workaround; the idea quotes them | CB Insights' post-mortems put "no market need" first, at 42% of 101 failed startups ([CB Insights report](https://s3-us-west-2.amazonaws.com/cbi-content/research-reports/The-20-Reasons-Startups-Fail.pdf)). Profitable indie products serve "a narrow group of businesses willing to pay $100, $500 or several thousand dollars per year" ([Steal What Works](https://stealwhatworks.com/blogs/news/indie-hackers-still-making-money)). HN side-project post-mortems: "Most people believe they'll return it in time and won't invest in this type of insurance" ([HN](https://news.ycombinator.com/item?id=25580637)) |
| 2 | **A narrow buyer you can name and reach** | One segment, one place where they gather; not "creators" or "everyone" | "Never clearly defined who the user is and what problems they solve" is a recurring failure on [HN](https://news.ycombinator.com/item?id=25580637); winners target micro-segments larger competitors ignore ([Alignify on Indie Hackers](https://alignify.co/insights/indie-hackers)). But not too narrow: "Anything limited to one city has too low a user base to sustain" ([HN](https://news.ycombinator.com/item?id=25580637)) |
| 3 | **Distribution the founder already has** | A community, audience, customer list or channel the builder controls today | RightBlogger reached about $2,000 MRR almost immediately on the founder's existing blog/YouTube audience; Launch Fast's founder "had access to a community" of Amazon sellers ([Steal What Works](https://stealwhatworks.com/blogs/news/indie-hackers-still-making-money)). Follower count alone correlates only ~0.26 with revenue; direct customer access matters more ([Steal What Works](https://stealwhatworks.com/blogs/news/indie-hackers-still-making-money)). "You can't wait for users to come to you. You have to go out and get them" ([Paul Graham, Do Things That Don't Scale](https://paulgraham.com/ds.html)) |
| 4 | **Founder-market fit: knowledge or data others lack** | Uses the builder's own corpus, archive, engine or community standing | Winners bring "direct access to customers, strong niche knowledge, useful proprietary data, a product buried deep inside a workflow" ([Steal What Works](https://stealwhatworks.com/blogs/news/indie-hackers-still-making-money)); Launch Fast "was built in about 48 hours, but [the founder] already understood Amazon sellers" (same) |
| 5 | **Small first product, fast time to value** | A one-time sale or a narrow tool that works on day one; recurring later | Rob Walling's stair step: first "a one-time sale, single channel product", repeat, then recurring revenue ([robwalling.com](https://robwalling.com/essays/2015/03/26/the-stair-step-method-of-bootstrapping), [MicroConf](https://microconf.com/latest/the-stairstep-approach-to-bootstrapping)) |
| 6 | **Price anchored to the value, not to cost** | A price a business would expense or a person would pay for the outcome; not $2/month | Businesses fail from charging too little far more often than too much ([Kalzumeus, "You can probably stand to charge more"](https://www.kalzumeus.com/2006/08/14/you-can-probably-stand-to-charge-more/); [with Ramit Sethi](https://www.kalzumeus.com/2012/09/21/ramit-sethi-and-patrick-mckenzie-on-why-your-customers-would-be-happier-if-you-charged-more/)) |
| 7 | **Not hostage to a fad, a platform or a giant** | Survives an algorithm change; not competing head-on with a free big-company feature | Acquirers of 40+ bootstrapped SaaS avoid "software [that] will get you more followers for XYZ social platform" ([Indie Hackers AMA](https://www.indiehackers.com/post/we-ve-acquired-40-bootstrapped-businesses-in-6-years-and-run-a-growing-portfolio-of-saas-products-ama-3f640f44fc)); HN post-mortems list company-sponsored free alternatives and technology shifts ([HN](https://news.ycombinator.com/item?id=25580637)) |
| 8 | **Customers keep using it** | A repeated job (weekly, per client, per episode), not a one-off curiosity | "Customers are regularly engaged and using your SaaS product is a powerful signal" ([Indie Hackers AMA](https://www.indiehackers.com/post/we-ve-acquired-40-bootstrapped-businesses-in-6-years-and-run-a-growing-portfolio-of-saas-products-ama-3f640f44fc)) |

Patterns 5 and 8 pull in different directions on purpose: start with a one-time sale that proves the pain, then find
the repeated job. The pre-mortem uses them together ("a one-off report nobody re-buys" → "a monthly transit note").

## How the engine uses it

- **Jev**: one noul per pattern ("Does this idea have a buyer who already spends money or hours on the problem?" …),
  averaged into a 0–1 pattern score shown on the card and used when the pre-mortem decides between an idea and its
  revised version.
- **Pre-mortem**: every idea that survives judging gets its three most likely failure reasons, each tied to a pattern
  it breaks and to evidence when there is some (a pain post, a trend signal, a competitor price from a research report
  or the founder-story library). The revised version fixes the biggest one and is judged the same way; the better one
  stays, and the card shows "Why this could fail → how this version fixes it".
- **Rubric**: the same eight lines go into the rubric prompt (r3) for future runs.
