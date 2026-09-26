// Conditional arithmetic, not a demand forecast. Missing measurements stay unknown.
export type NumericAssumption = {
  value: number | null;
  basis?: "assumed" | "observed" | "unknown";
  note?: string;
  sourceIds?: string[];
  observedAt?: string;
};
export type NumericInput = number | null | NumericAssumption;
export type EconomicModel = "subscription" | "usage" | "one-time" | "service" | "license";

type InputDefinition = { label: string; unit: string; default?: number; max?: number };
export const ECONOMIC_INPUTS = {
  activeCustomers: { label: "Customers in the scenario / launch cohort", unit: "customers" },
  pricePerCustomer: { label: "Price per customer, job or usage unit", unit: "currency" },
  variableCostPerCustomer: { label: "Cash delivery cost per customer, job or unit", unit: "currency" },
  fixedMonthlyCost: { label: "Fixed monthly cash overhead", unit: "currency/month" },
  founderHoursPerMonth: { label: "Fixed founder operating hours", unit: "hours/month" },
  founderHourlyRate: { label: "Value of founder time", unit: "currency/hour" },
  cac: { label: "Cash customer acquisition cost", unit: "currency/new customer" },
  monthlyChurn: { label: "Monthly customer churn", unit: "fraction/month", max: 1 },
  newCustomersPerMonth: { label: "New paying customers after launch month", unit: "customers/month" },
  startupCost: { label: "Startup cash before launch", unit: "currency" },
  setupFee: { label: "One-time setup charge", unit: "currency/new customer", default: 0 },
  onboardingCost: { label: "Cash onboarding cost", unit: "currency/new customer", default: 0 },
  refundRate: { label: "Revenue refunded", unit: "fraction", default: 0, max: 1 },
  paymentFeeRate: { label: "Payment processing rate", unit: "fraction", default: 0, max: 1 },
  paymentFeeFixed: { label: "Fee per payment", unit: "currency/payment", default: 0 },
  hoursPerCustomer: { label: "Founder delivery/support time", unit: "hours/customer/month or job", default: 0 },
  onboardingHoursPerCustomer: { label: "Founder onboarding time", unit: "hours/new customer", default: 0 },
  salesHoursPerNewCustomer: { label: "Founder sales time", unit: "hours/new customer", default: 0 },
  availableHoursPerMonth: { label: "Total founder capacity", unit: "hours/month" },
  unitsPerCustomer: { label: "Usage units per active customer", unit: "units/customer/month" },
} satisfies Record<string, InputDefinition>;
export type EconomicInputKey = keyof typeof ECONOMIC_INPUTS;
export type EconomicsInput = Partial<Record<EconomicInputKey, NumericInput>> & {
  currency?: string;
  model?: EconomicModel;
  billingPeriodMonths?: 1 | 12;
};
type Amount = number | null;
export type NormalizedAssumption = NumericAssumption & { unit: string; defaulted: boolean };
export type MonthlyEconomics = {
  month: number; customers: Amount; newCustomers: Amount; unmetNewCustomers: Amount;
  recurringRevenue: Amount; oneTimeRevenue: Amount; revenue: Amount; cashReceipts: Amount; deferredRevenue: Amount;
  deliveryCost: Amount; paymentFees: Amount; acquisitionCost: Amount; onboardingCost: Amount;
  founderHours: Amount; founderLaborCost: Amount; capacityExceeded: boolean | null;
  netCash: Amount; economicSurplus: Amount; cumulativeCash: Amount;
};
export type EconomicsResult = {
  currency: string; model: EconomicModel; billingPeriodMonths: 1 | 12;
  normalized: Record<EconomicInputKey, Amount>;
  assumptions: Record<EconomicInputKey, NormalizedAssumption>;
  missingInputs: EconomicInputKey[]; errors: string[]; warnings: string[]; conventions: string[];
  unitEconomics: {
    realizedMonthlyRevenue: Amount; cashContribution: Amount; economicContribution: Amount;
    cashContributionMargin: Amount; upfrontContribution: Amount;
    simplePaybackMonths: Amount; cohort12MonthContributionAfterCAC: Amount;
    cohort12MonthEconomicContributionAfterCAC: Amount; cohortPaybackMonth: Amount;
    recoversCACWithin12Months: boolean | null;
  };
  steadyState: {
    revenue: Amount; recurringRevenue: Amount; oneTimeRevenue: Amount; replacementCustomers: Amount;
    replacementAcquisitionCost: Amount; cashSurplus: Amount; economicSurplus: Amount;
    cashBreakEvenCustomers: Amount; economicBreakEvenCustomers: Amount;
    founderHours: Amount; maxCustomersAtCapacity: Amount; withinCapacity: boolean | null;
    initialAcquisitionCost: Amount;
  };
  projection: {
    months: MonthlyEconomics[]; cashRequired: Amount; totalRevenue: Amount; totalCashReceipts: Amount;
    endingCash: Amount; cashBreakEvenMonth: Amount; firstPositiveCashMonth: Amount;
  };
  sensitivity: { input: EconomicInputKey; direction: "lower" | "higher"; value: number; economicSurplus: Amount; delta: Amount }[];
};

const keys = Object.keys(ECONOMIC_INPUTS) as EconomicInputKey[];
const finite = (x: number): Amount => Number.isFinite(x) ? x : null;
const add = (...xs: Amount[]): Amount => xs.some(x => x === null) ? null : finite((xs as number[]).reduce((a, b) => a + b, 0));
const mul = (...xs: Amount[]): Amount => xs.includes(0) ? 0 : xs.some(x => x === null) ? null : finite((xs as number[]).reduce((a, b) => a * b, 1));
const sub = (a: Amount, b: Amount): Amount => a === null || b === null ? null : finite(a - b);
const ratio = (a: Amount, b: Amount): Amount => a === null || b === null || b <= 0 ? null : finite(a / b);
const sum = (xs: Amount[]) => add(...xs);
const feeOnPositiveBill = (gross: Amount, fee: Amount): Amount => gross === null ? fee === 0 ? 0 : null : gross > 0 ? fee : 0;
const breakEven = (fixed: Amount, margin: Amount): Amount => fixed === null || margin === null || margin <= 0 ? null : Math.ceil(fixed / margin);
const recurringModel = (model: EconomicModel) => model !== "one-time" && model !== "service";
const text = (v: unknown, n = 500) => typeof v === "string" ? v.slice(0, n) : "";

function normalize(input: EconomicsInput, errors: string[]) {
  const values = {} as Record<EconomicInputKey, Amount>;
  const assumptions = {} as Record<EconomicInputKey, NormalizedAssumption>;
  for (const key of keys) {
    const def: InputDefinition = ECONOMIC_INPUTS[key];
    const raw = input[key];
    const supplied = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    if (supplied && !("value" in supplied)) errors.push(`${key} assumption must include value (use null when unknown).`);
    if (supplied?.basis !== undefined && !["assumed", "observed", "unknown"].includes(supplied.basis)) errors.push(`${key} has an invalid assumption basis.`);
    const defaulted = raw === undefined && def.default !== undefined;
    const candidate = defaulted ? def.default : supplied ? supplied.value : raw;
    let value: Amount = null;
    if (candidate !== undefined && candidate !== null && supplied?.basis !== "unknown") {
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > (def.max ?? 1e12)) {
        errors.push(`${key} must be a finite number between 0 and ${def.max ?? "1 trillion"}.`);
      } else value = candidate;
    }
    values[key] = value;
    assumptions[key] = {
      value, basis: value === null ? "unknown" : supplied?.basis === "observed" ? "observed" : "assumed",
      note: defaulted ? "Not entered; excluded from this scenario (assumed zero)." : text(supplied?.note),
      sourceIds: Array.isArray(supplied?.sourceIds) ? supplied.sourceIds.filter(x => typeof x === "string").slice(0, 30).map(x => x.slice(0, 200)) : [],
      observedAt: text(supplied?.observedAt, 50) || undefined,
      unit: def.unit, defaulted,
    };
  }
  return { values, assumptions };
}

/** All amounts use one currency. Annual recurring price is entered as its monthly equivalent. */
export function calculateEconomics(input: EconomicsInput = {}): EconomicsResult {
  return calculate(input, true);
}

function calculate(raw: EconomicsInput, withSensitivity: boolean): EconomicsResult {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const errors: string[] = [], warnings: string[] = [];
  const models = ["subscription", "usage", "one-time", "service", "license"];
  const model: EconomicModel = models.includes(input.model ?? "subscription") ? input.model ?? "subscription" : "subscription";
  if (input.model !== undefined && !models.includes(input.model)) errors.push("Unknown revenue model; select subscription, usage, one-time, service or license.");
  const recurring = recurringModel(model);
  const annualAllowed = model === "subscription" || model === "license";
  const period = input.billingPeriodMonths === 12 && annualAllowed ? 12 : 1;
  if (input.billingPeriodMonths !== undefined && ![1, 12].includes(input.billingPeriodMonths)) errors.push("Billing period must be 1 or 12 months.");
  if (input.billingPeriodMonths === 12 && !annualAllowed) errors.push("Annual prepayment is supported only for subscriptions and licenses.");
  if (input.currency !== undefined && typeof input.currency !== "string") errors.push("Currency must be a three-letter code.");
  let currency = typeof input.currency === "string" ? input.currency.toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) { errors.push("Currency must be a three-letter code."); currency = "USD"; }
  const { values: n, assumptions } = normalize(input, errors);
  const missingInputs = keys.filter(key => n[key] === null && !(["unitsPerCustomer"].includes(key) && model !== "usage") && !(key === "monthlyChurn" && !recurring));
  const units: Amount = model === "usage" ? n.unitsPerCustomer : 1;
  const gross = mul(n.pricePerCustomer, units);
  const realized = mul(gross, sub(1, n.refundRate));
  const delivery = mul(n.variableCostPerCustomer, units);
  const recurringFixedFee = feeOnPositiveBill(gross, n.paymentFeeFixed);
  const setupOnlyFixedFee = gross === 0 ? feeOnPositiveBill(n.setupFee, n.paymentFeeFixed) : gross === null && n.paymentFeeFixed !== 0 ? null : 0;
  const monthlyFees = add(mul(gross, n.paymentFeeRate), mul(recurringFixedFee, 1 / period));
  const cashContribution = sub(sub(realized, delivery), monthlyFees);
  const laborPerCustomer = mul(n.hoursPerCustomer, n.founderHourlyRate);
  const economicContribution = sub(cashContribution, laborPerCustomer);
  const setupNet = mul(n.setupFee, sub(1, n.refundRate));
  const upfront = sub(sub(sub(setupNet, mul(n.setupFee, n.paymentFeeRate)), n.onboardingCost), setupOnlyFixedFee);
  const newCustomerHours = add(n.onboardingHoursPerCustomer, n.salesHoursPerNewCustomer);
  const upfrontLabor = mul(newCustomerHours, n.founderHourlyRate);
  const fixedLabor = mul(n.founderHoursPerMonth, n.founderHourlyRate);
  const fixedEconomic = add(n.fixedMonthlyCost, fixedLabor);
  // Annual contracts keep delivering until renewal; monthly churn becomes a renewal survival assumption.
  const churn = recurring ? n.monthlyChurn : 1;
  const survival = (month: number): Amount => !recurring ? (month === 0 ? 1 : 0) : month < period ? 1 : churn === null ? null : (1 - churn) ** (Math.floor(month / period) * period);
  const cohortContributions = Array.from({ length: 12 }, (_, m) => mul(cashContribution, survival(m)));
  const cohortCash = sub(add(sum(cohortContributions), upfront), n.cac);
  const cohortEconomic = sub(sub(add(sum(Array.from({ length: 12 }, (_, m) => mul(economicContribution, survival(m)))), upfront), n.cac), upfrontLabor);
  const cohortCumulative = cohortContributions.map((_, m) => sub(add(sum(cohortContributions.slice(0, m + 1)), upfront), n.cac));
  const recoveredMonth = cohortCumulative.findIndex((earned, i) => earned !== null && earned >= 0 && cohortCumulative.slice(i).every(later => later !== null && later >= 0));
  const cohortPaybackMonth: Amount = recoveredMonth < 0 ? null : recoveredMonth + 1;
  const replacementRate = !recurring ? 1 : churn === null ? null : period === 1 ? churn : (1 - (1 - churn) ** period) / period;
  const replacementCustomers = mul(n.activeCustomers, replacementRate);
  const replacementAcquisitionCost = mul(replacementCustomers, n.cac);
  const cashRetainedContribution = sub(cashContribution, mul(replacementRate, sub(n.cac, upfront)));
  const economicRetainedContribution = sub(economicContribution, mul(replacementRate, sub(add(n.cac, upfrontLabor), upfront)));
  const recurringRevenue = recurring ? mul(n.activeCustomers, realized) : 0;
  const oneTimeRevenue = add(recurring ? 0 : mul(n.activeCustomers, realized), mul(replacementCustomers, setupNet));
  const steadyHoursPerCustomer = add(n.hoursPerCustomer, mul(replacementRate, newCustomerHours));
  const maxCustomersAtCapacity = n.availableHoursPerMonth === null || n.founderHoursPerMonth === null || steadyHoursPerCustomer === null || steadyHoursPerCustomer <= 0 ? null : Math.max(0, (n.availableHoursPerMonth - n.founderHoursPerMonth) / steadyHoursPerCustomer);
  const founderHours = add(n.founderHoursPerMonth, mul(n.activeCustomers, steadyHoursPerCustomer));
  const steadyState = {
    revenue: add(recurringRevenue, oneTimeRevenue), recurringRevenue, oneTimeRevenue,
    replacementCustomers, replacementAcquisitionCost,
    cashSurplus: sub(mul(n.activeCustomers, cashRetainedContribution), n.fixedMonthlyCost),
    economicSurplus: sub(mul(n.activeCustomers, economicRetainedContribution), fixedEconomic),
    cashBreakEvenCustomers: breakEven(n.fixedMonthlyCost, cashRetainedContribution),
    economicBreakEvenCustomers: breakEven(fixedEconomic, economicRetainedContribution),
    founderHours, maxCustomersAtCapacity,
    withinCapacity: founderHours === null || n.availableHoursPerMonth === null ? null : founderHours <= n.availableHoursPerMonth,
    initialAcquisitionCost: mul(n.activeCustomers, n.cac),
  };
  if (cashContribution !== null && cashContribution <= 0) warnings.push("Delivery has zero or negative cash contribution; acquiring more customers does not fix it.");
  if (steadyState.withinCapacity === false) warnings.push("The steady-state scenario exceeds founder capacity; the projection caps new sales at available hours.");
  if (steadyState.withinCapacity === null) warnings.push("Founder capacity or required hours are unknown; projected sales have not been capacity-checked.");
  if (n.founderHourlyRate === null) warnings.push("Founder time has no entered value; economic surplus remains unknown where labor is required.");
  if (Object.values(assumptions).some(a => a.defaulted)) warnings.push("Unentered optional costs are explicitly assumed zero. Review fees, refunds, onboarding and delivery hours.");
  if (Object.values(assumptions).some(a => a.basis === "observed")) warnings.push("Observed input labels are supplied provenance, not independent verification of evidence.");
  if (!recurring) warnings.push("One-time/service volume requires fresh customers each month; no recurring revenue or monthly payback is assumed. Cohort recovery reflects the single sale.");
  if (model === "usage") warnings.push("Usage revenue is variable revenue, not contracted MRR.");
  const conventions = [
    "Conditional scenarios, not forecasts or confidence intervals. Unknown inputs remain null; all numeric assumptions retain their provenance.",
    "The launch cohort equals activeCustomers and is acquired and billed in month 1. Later arrivals equal newCustomersPerMonth. All new arrivals receive a full billed period.",
    "Cash CAC excludes separately entered founder sales time. Delivery cash cost excludes separately entered founder hours; include paid employees or contractors there only once.",
    "Startup cost is paid before month 1. Tax, financing, expansion and currency conversion are excluded. Setup fees and one-time sales are never recurring revenue.",
    "Refunds reduce receipts and revenue, not service volume. Processing fees apply to positive gross charges and are not returned on refunds. Zero-value bills incur no fixed payment fee. Setup is collected with the first payment.",
    "Capacity is measured in expected customer equivalents. Existing contractual obligations remain; new sales are capped by remaining founder hours. Cash CAC is charged only on admitted sales.",
    period === 12 ? "Annual price is its monthly equivalent. Cash is collected for 12 months upfront; revenue is recognized monthly. Annual contracts remain active until renewal; monthly churn is converted to renewal survival. Projection assumes no pre-existing deferred revenue." : "Monthly customers churn before subsequent bills; each new cohort pays for a full first month. Steady state replaces churn, while the projection uses explicit new-customer arrivals.",
    "Cash required is the largest month-end cash deficit including startup. It excludes within-month working capital timing. Cash break-even must remain nonnegative through the displayed horizon; annual prepaid cash still has future delivery obligations.",
    "Cohort contribution includes setup/onboarding, excludes allocated fixed overhead and is limited to 12 months. Simple payback for recurring models is CAC / cash contribution before churn and setup; cohort recovery must remain nonnegative through the displayed horizon.",
  ];

  const months: MonthlyEconomics[] = [];
  const cohorts: { start: number; customers: Amount }[] = [];
  let cumulative: Amount = n.startupCost === null ? null : -n.startupCost;
  let cashRequired: Amount = n.startupCost;
  let collected: Amount = 0, recognized: Amount = 0;
  let cashBreakEvenMonth: Amount = null, firstPositiveCashMonth: Amount = null;
  for (let month = 1; month <= 12; month++) {
    const existing = sum(cohorts.map(c => mul(c.customers, survival(month - c.start))));
    const wanted = month === 1 ? n.activeCustomers : n.newCustomersPerMonth;
    const currentHours = add(n.founderHoursPerMonth, mul(existing, n.hoursPerCustomer));
    const hoursPerArrival = add(n.hoursPerCustomer, newCustomerHours);
    let arrivals = wanted;
    if (n.availableHoursPerMonth !== null && currentHours !== null && hoursPerArrival !== null) {
      const room = Math.max(0, n.availableHoursPerMonth - currentHours);
      if (hoursPerArrival > 0 && wanted !== null) arrivals = Math.min(wanted, room / hoursPerArrival);
      else if (currentHours > n.availableHoursPerMonth) arrivals = 0;
    }
    cohorts.push({ start: month, customers: arrivals });
    const customers = add(existing, arrivals);
    const billedCustomers = sum(cohorts.map(c => (month - c.start) % period === 0 ? mul(c.customers, survival(month - c.start)) : 0));
    const recurringRev = recurring ? mul(customers, realized) : 0;
    const oneTimeRev = add(!recurring ? mul(customers, realized) : 0, mul(arrivals, setupNet));
    const grossReceipts = add(mul(billedCustomers, gross, period), mul(arrivals, n.setupFee));
    const receipts = mul(grossReceipts, sub(1, n.refundRate));
    const cashFees = add(mul(grossReceipts, n.paymentFeeRate), mul(billedCustomers, recurringFixedFee), mul(arrivals, setupOnlyFixedFee));
    const feesRecognized = add(mul(customers, monthlyFees), mul(arrivals, n.setupFee, n.paymentFeeRate), mul(arrivals, setupOnlyFixedFee));
    const deliveryCost = mul(customers, delivery);
    const acquisitionCost = mul(arrivals, n.cac);
    const onboardingCost = mul(arrivals, n.onboardingCost);
    const hours = add(currentHours, mul(arrivals, hoursPerArrival));
    const labor = mul(hours, n.founderHourlyRate);
    const cashExpenses = add(deliveryCost, cashFees, acquisitionCost, onboardingCost, n.fixedMonthlyCost);
    const netCash = sub(receipts, cashExpenses);
    cumulative = add(cumulative, netCash);
    cashRequired = cashRequired === null || cumulative === null ? null : Math.max(cashRequired, -cumulative);
    if (firstPositiveCashMonth === null && netCash !== null && netCash > 0) firstPositiveCashMonth = month;
    collected = add(collected, receipts); recognized = add(recognized, recurringRev, oneTimeRev);
    months.push({
      month, customers, newCustomers: arrivals, unmetNewCustomers: sub(wanted, arrivals),
      recurringRevenue: recurringRev, oneTimeRevenue: oneTimeRev, revenue: add(recurringRev, oneTimeRev), cashReceipts: receipts, deferredRevenue: sub(collected, recognized),
      deliveryCost, paymentFees: cashFees, acquisitionCost, onboardingCost,
      founderHours: hours, founderLaborCost: labor,
      capacityExceeded: hours === null || n.availableHoursPerMonth === null ? null : hours > n.availableHoursPerMonth + 1e-9,
      netCash, economicSurplus: sub(add(recurringRev, oneTimeRev), add(deliveryCost, feesRecognized, acquisitionCost, onboardingCost, n.fixedMonthlyCost, labor)),
      cumulativeCash: cumulative,
    });
  }
  cashBreakEvenMonth = months.find((m, i) => m.cumulativeCash !== null && m.cumulativeCash >= 0 && months.slice(i).every(later => later.cumulativeCash !== null && later.cumulativeCash >= 0))?.month ?? null;
  if (months.some(m => m.unmetNewCustomers !== null && m.unmetNewCustomers > 0)) warnings.push("Some projected customer demand exceeds capacity; revenue uses only customers who can be served.");
  const result: EconomicsResult = {
    currency, model, billingPeriodMonths: period, normalized: n, assumptions, missingInputs, errors, warnings, conventions,
    unitEconomics: {
      realizedMonthlyRevenue: realized, cashContribution, economicContribution,
      cashContributionMargin: ratio(cashContribution, realized), upfrontContribution: upfront,
      simplePaybackMonths: recurring ? ratio(n.cac, cashContribution) : null, cohort12MonthContributionAfterCAC: cohortCash,
      cohort12MonthEconomicContributionAfterCAC: cohortEconomic, cohortPaybackMonth,
      recoversCACWithin12Months: cohortCash === null ? null : cohortCash >= 0,
    },
    steadyState,
    projection: { months, cashRequired, totalRevenue: sum(months.map(m => m.revenue)), totalCashReceipts: sum(months.map(m => m.cashReceipts)), endingCash: cumulative, cashBreakEvenMonth, firstPositiveCashMonth },
    sensitivity: [],
  };
  if (withSensitivity) for (const key of ["cac", "variableCostPerCustomer", "monthlyChurn"] as const) {
    if (n[key] === null || (key === "monthlyChurn" && !recurring)) continue;
    for (const direction of ["lower", "higher"] as const) {
      const value = Math.min(key === "monthlyChurn" ? 1 : 1e12, n[key]! * (direction === "lower" ? 0.8 : 1.2));
      const alternate = calculate({ ...input, [key]: { value, basis: "assumed", note: "One input changed by 20%; all other inputs held constant." } }, false);
      const economicSurplus = alternate.steadyState.economicSurplus;
      result.sensitivity.push({ input: key, direction, value, economicSurplus, delta: sub(economicSurplus, steadyState.economicSurplus) });
    }
  }
  return result;
}

/** Scenarios are independently specified assumptions, never probabilities or confidence bands. */
export function calculateScenarios(scenarios: { downside: EconomicsInput; base: EconomicsInput; upside: EconomicsInput }) {
  return { downside: calculateEconomics(scenarios.downside), base: calculateEconomics(scenarios.base), upside: calculateEconomics(scenarios.upside) };
}
