// These rules recommend what to test. They cannot establish willingness to pay.
export type ValuePattern = "continuous" | "episodic" | "finite" | "embedded" | "transaction" | "audience" | "urgent";
export type RevenueModel = "paid-service" | "subscription" | "usage" | "one-time" | "license-api" | "transaction-fee" | "sponsorship-affiliate";
export type RevenueInput = {
  valuePattern?: ValuePattern;
  buyer?: string;
  frequency?: "daily" | "weekly" | "monthly" | "occasional" | "one-off" | "unknown";
  handsOn?: boolean;
  newMarket?: boolean;
  validatedRepeatUse?: boolean;
  hasAudience?: boolean;
};
export type RevenueStream = {
  model: RevenueModel; label: string; payer: string; billingUnit: string; reason: string;
  prerequisites: string[]; experiment: string;
  priceRange: null; priceBasis: string;
};
export type RevenueRecommendation = {
  basis: "heuristic"; primary: RevenueStream | null; complementary: RevenueStream[];
  validationPath: string[]; warnings: string[];
};

const STREAMS: Record<RevenueModel, Omit<RevenueStream, "payer" | "reason" | "priceRange" | "priceBasis">> = {
  "paid-service": {
    model: "paid-service", label: "Fixed-scope paid pilot", billingUnit: "completed, agreed outcome",
    prerequisites: ["A reachable budget owner with an urgent job", "A fixed scope, delivery-time cap and acceptance criteria", "A price that covers delivery and acquisition"],
    experiment: "Offer a paid pilot to a predefined target-buyer sample. Record offers, payments, delivery hours, refunds and outcomes; choose success and rejection thresholds before starting.",
  },
  subscription: {
    model: "subscription", label: "Recurring subscription", billingUnit: "business, seat or asset per billing period",
    prerequisites: ["Repeated customer value during every billing period", "Observed repeat use and a retention test", "A measurable result that supports a recurring budget"],
    experiment: "Test a stated recurring price with target buyers, then observe paid use and renewal over a predefined window. An initial payment alone does not establish retention.",
  },
  usage: {
    model: "usage", label: "Per-job or usage pricing", billingUnit: "completed job or measured usage unit",
    prerequisites: ["A billable unit buyers understand", "Measured unit costs including failed jobs and retries", "Enough repeat demand to recover acquisition costs"],
    experiment: "Sell a small paid usage bundle. Record completion rate, retries, cost per unit, repeat purchases and refunds before selecting a minimum commitment.",
  },
  "one-time": {
    model: "one-time", label: "One-time purchase", billingUnit: "delivered product or package",
    prerequisites: ["A finite deliverable with clear acceptance criteria", "Acquisition cost recoverable from the purchase", "A bounded update, refund and support obligation"],
    experiment: "Offer the deliverable at a stated price to a predefined qualified audience; measure completed purchases, refunds and support time with the offer denominator.",
  },
  "license-api": {
    model: "license-api", label: "API or business license", billingUnit: "partner license, API unit or contracted volume",
    prerequisites: ["A partner willing to embed and pay for the capability", "Confirmed data rights and reliable integration access", "Support, security and service-level costs within the contract margin"],
    experiment: "Test a paid integration with one target partner under explicit usage and support limits. Measure integration cost, use and renewal intent under actual offer terms.",
  },
  "transaction-fee": {
    model: "transaction-fee", label: "Transaction fee", billingUnit: "completed, attributable transaction",
    prerequisites: ["Reachable supply and demand on both sides", "Control over payment or reliable fee attribution", "Positive contribution after payment, dispute and refund costs"],
    experiment: "Manually facilitate a bounded set of paid transactions. Measure both sides of the funnel, completed volume, fee collection, disputes and contribution per transaction.",
  },
  "sponsorship-affiliate": {
    model: "sponsorship-affiliate", label: "Sponsorship or affiliate revenue", billingUnit: "qualified placement or attributable purchase",
    prerequisites: ["Measured reachable audience and relevant purchase intent", "A willing sponsor or qualifying affiliate offer", "Disclosed commercial relationships and sustainable audience trust"],
    experiment: "Test one clearly disclosed placement with a real commercial partner. Measure attributable responses, conversions and audience response before forecasting revenue.",
  },
};

const make = (model: RevenueModel, payer: string, reason: string): RevenueStream => ({
  ...STREAMS[model], prerequisites: [...STREAMS[model].prerequisites], payer, reason,
  priceRange: null, priceBasis: "Not estimated. Research comparable offers and test a price with the target payer; no market price is inferred from this rule.",
});

export function recommendRevenueStreams(raw: RevenueInput = {}): RevenueRecommendation {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warnings = ["This recommendation is a testable business-model hypothesis, not demand validation.", "Complementary streams require their own adoption and incremental-cost model; do not add their potential revenue together."];
  const payer = typeof input.buyer === "string" && input.buyer.trim() ? input.buyer.trim().slice(0, 250) : "Target budget owner — identify before testing";
  const result: RevenueRecommendation = { basis: "heuristic", primary: null, complementary: [], validationPath: [], warnings };
  if (!input.valuePattern || !["continuous", "episodic", "finite", "embedded", "transaction", "audience", "urgent"].includes(input.valuePattern)) {
    warnings.push("Value frequency and customer benefit are unknown; no primary revenue model can be recommended yet.");
    result.validationPath = ["Identify the buyer, purchase trigger and whether value repeats.", "Research current spending and test an explicit paid offer."];
    return result;
  }
  const episodic = input.frequency === "occasional" || input.frequency === "one-off";
  let model: RevenueModel, reason: string;
  switch (input.valuePattern) {
    case "urgent":
      model = "paid-service"; reason = "A time-sensitive outcome supports testing a bounded paid result before standardizing delivery."; break;
    case "finite":
      model = "one-time"; reason = "The buyer receives a finite deliverable; a one-time price matches that value without assuming recurring demand."; break;
    case "embedded":
      model = "license-api"; reason = "Another business embeds the capability, so pricing should follow partner value, contracted access or metered use."; break;
    case "transaction":
      model = "transaction-fee"; reason = "Value is created by completing a transaction; a fee can align payment with that completed outcome."; break;
    case "audience":
      if (input.hasAudience !== true) {
        warnings.push("An established, measurable audience is required before recommending sponsorship or affiliate revenue.");
        result.validationPath = ["Measure the reachable audience and its relevant purchase intent.", "Verify a partner offer, attribution and likely workload before testing a paid placement."];
        return result;
      }
      model = "sponsorship-affiliate"; reason = "An existing audience can connect a relevant buyer with an attributable commercial offer; conversion still needs a test."; break;
    case "episodic":
      model = input.handsOn === true ? "paid-service" : "usage";
      reason = input.handsOn === true ? "Occasional jobs require hands-on delivery, so a fixed-scope fee can test the outcome and delivery cost." : "Demand arrives per job or varies by consumption; a per-unit offer matches the buying occasion.";
      break;
    default:
      if (episodic) {
        model = input.frequency === "one-off" ? "one-time" : "usage";
        reason = "The stated purchase frequency is episodic despite the continuous-value label; test an offer that matches when buyers actually need the result.";
        warnings.push("Value pattern and purchase frequency conflict. Check buyer behavior before assuming recurring revenue.");
      } else if ((input.newMarket === true || input.handsOn === true) && input.validatedRepeatUse !== true) {
        model = "paid-service";
        reason = "In an unfamiliar or hands-on workflow, a paid pilot can establish buyer value and repeatable delivery before a recurring commitment.";
      } else {
        model = "subscription";
        reason = "The workflow delivers ongoing value; a recurring fee is a plausible model to test with buyers and renewal behavior.";
        if (input.validatedRepeatUse !== true) warnings.push("Repeat use is unvalidated; subscription retention and revenue remain assumptions.");
      }
  }
  result.primary = make(model, payer, reason);
  const add = (m: RevenueModel, why: string) => { if (m !== model && !result.complementary.some(s => s.model === m)) result.complementary.push(make(m, payer, why)); };
  if (model === "paid-service" && input.valuePattern === "continuous" && !episodic) add("subscription", "Test recurring maintenance only after pilots demonstrate repeated value and a sustainable delivery cost.");
  if (model === "subscription" || model === "license-api") add("paid-service", "A separately priced onboarding or integration package may cover meaningful setup work; the setup charge is one-time revenue.");
  if (model === "usage" && input.validatedRepeatUse === true && !episodic) add("subscription", "A minimum commitment with included usage may fit measured recurring consumption; avoid double-counting included usage.");
  if (model === "one-time") add("paid-service", "Optional setup or support can be sold separately when customers need it and the incremental workload is priced.");
  if (model === "transaction-fee") add("subscription", "Optional merchant software could earn a recurring fee only if it creates value beyond the transactions already charged.");
  if (model === "sponsorship-affiliate") add("one-time", "A paid report or product could serve the same audience if separate purchase demand is demonstrated.");
  result.validationPath = [
    "Document the budget owner, purchase trigger, current alternatives and actual spending.",
    result.primary.experiment,
    model === "paid-service" ? "Use measured pilot delivery and repeat demand to choose repeatable service, subscription or usage pricing." : "Update the economics with actual acquisition, delivery, refund and repeat-purchase or renewal data.",
  ];
  return result;
}
