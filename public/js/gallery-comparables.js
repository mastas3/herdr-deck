// Gallery: "What similar founders did" in an idea's panel and its starter kit. The server matches the idea to founder
// cards from the Founder Library (src/library-strategy.ts) and sends what those founders sold, the revenue they claim,
// how they got their first customers, what failed and when the video came out; every line links to its moment.
// Revenue is always shown as a claim. The strategy check says when this plan's price or channel is far from theirs.
const GAL_CH = { reddit: "Reddit", x_twitter: "X", tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", linkedin: "LinkedIn", facebook_groups: "Facebook groups", product_hunt: "Product Hunt", hacker_news: "Hacker News", seo: "SEO", content_blog: "Blog", newsletter: "Newsletter", cold_email: "Cold email", cold_calls: "Cold calls", door_to_door: "Door to door", in_person: "In person", friends_network: "Network", existing_audience: "Own audience", communities: "Communities", paid_ads: "Paid ads", partnerships: "Partners", affiliates: "Affiliates", app_store: "App store", marketplace: "Marketplace", word_of_mouth: "Word of mouth", press: "Press", influencers: "Influencers", cold_dms: "Cold DMs", other: "Other" };
const galAt = (m, label) => (m?.link ? `<a class="ltime" href="${esc(m.link)}" target="_blank" rel="noopener" title="Watch from ${esc(m.at || "the start")}">${ICON.play ?? ""}${esc(label ?? (m.at || "video"))}</a>` : "");

/** The panel section: counts across comparables, the strategy check, then one card per founder. */
function galCompHTML(c) {
  const r = c?.comparables;
  if (!r) return S.gal.full.has(c?.id) ? `<p class="hint">No founder in the library is close enough to this idea yet. Add channels in Discover → Library → Sources.</p>` : "";
  const checks = r.checks?.length ? `<div class="galcheck" role="note"><b>Strategy check</b>${r.checks.map((x) => `<p>${esc(x)}</p>`).join("")}</div>` : "";
  const sum = r.summary?.length ? `<ul class="galcsum">${r.summary.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `${checks}${sum}<div class="galcomps">${r.items.map((x, i) => galCompCard(x, i)).join("")}</div>
    <p class="hint">From founder interviews in your Founder Library. Revenue and prices are what they said on camera, not verified.</p>`;
}
function galCompCard(x, i) {
  const f = x.first?.find((y) => y.channel !== "other") ?? x.first?.[0];
  const when = x.published ? `<span class="galcwhen${x.old ? " old" : ""}">${esc(x.published)}${x.old ? ` · ${esc(x.old)}` : ""}</span>` : "";
  return `<article class="galcomp" style="--i:${i}">
    <header><a class="gname" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>${when}</header>
    ${x.sells ? `<p class="galcsells">${esc(x.sells)}${x.customer ? ` <span class="hint">for ${esc(x.customer)}</span>` : ""}</p>` : ""}
    <div class="lclaims">${x.revenue ? `<span class="lclaim"><b>Claimed revenue</b> “${esc(x.revenue.text)}” ${galAt(x.revenue)}</span>` : ""}${x.price ? `<span class="lclaim"><b>Price</b> “${esc(x.price.text)}” ${galAt(x.price)}</span>` : ""}${x.ttfr ? `<span class="lclaim"><b>First revenue</b> “${esc(x.ttfr.text)}” ${galAt(x.ttfr)}</span>` : ""}</div>
    ${f ? `<p class="galctac"><span class="dtag">${esc(GAL_CH[f.channel] ?? "Other")}</span> ${esc(f.text)} ${galAt(f)}</p>` : ""}
    ${x.failed?.[0] ? `<p class="galcfail"><b>What failed</b> ${esc(x.failed[0].text)} ${galAt(x.failed[0])}</p>` : ""}
    ${x.match?.length ? `<p class="hint galcwhy">Comparable: ${esc(x.match.join(" · "))}</p>` : ""}
  </article>`;
}
/** The kit's own copy (as found when the kit was written), for its Comparables tab. */
function galKitCompHTML(k) {
  const cs = k.comparables;
  if (!cs?.items?.length) return `<p class="hint">No founder in the library was close enough when this kit was written.</p>`;
  return galCompHTML({ comparables: cs });
}
