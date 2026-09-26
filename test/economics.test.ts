import { describe, expect, test } from "bun:test";
import { calculateEconomics, calculateScenarios, type EconomicsInput } from "../src/economics";

const base: EconomicsInput = {
  currency: "USD", model: "subscription", activeCustomers: 50, pricePerCustomer: 99,
  variableCostPerCustomer: 25, fixedMonthlyCost: 300, founderHoursPerMonth: 20,
  founderHourlyRate: 50, cac: 240, monthlyChurn: 0.04, newCustomersPerMonth: 2,
  startupCost: 0, availableHoursPerMonth: 160,
};
const model = (patch: EconomicsInput = {}) => calculateEconomics({ ...base, ...patch });

describe("checked opportunity economics", () => {
  test("reproduces every scenario in the design's worked example", () => {
    const cases = [
      [{ activeCustomers: 20, variableCostPerCustomer: 40, cac: 450, monthlyChurn: 0.08 }, 1980, -840, 57, 7.63, 16.35],
      [{}, 4950, 1920, 21, 3.24, 476.49],
      [{ activeCustomers: 100, variableCostPerCustomer: 18, cac: 150, monthlyChurn: 0.02 }, 9900, 6500, 17, 1.85, 721.90],
    ] as const;
    for (const [inputs, revenue, surplus, breakEven, payback, cohort] of cases) {
      const x = model(inputs);
      expect(x.errors).toEqual([]);
      expect(x.steadyState.revenue).toBeCloseTo(revenue, 6);
      expect(x.steadyState.economicSurplus).toBeCloseTo(surplus, 6);
      expect(x.steadyState.economicBreakEvenCustomers).toBe(breakEven);
      expect(x.unitEconomics.simplePaybackMonths).toBeCloseTo(payback, 2);
      expect(x.unitEconomics.cohort12MonthContributionAfterCAC).toBeCloseTo(cohort, 2);
    }
  });

  test("separates founder economic cost, steady surplus and launch acquisition cash", () => {
    const x = model();
    expect(x.steadyState.cashSurplus).toBeCloseTo(2920, 6);
    expect(x.steadyState.economicSurplus).toBeCloseTo(1920, 6);
    expect(x.steadyState.replacementAcquisitionCost).toBe(480);
    expect(x.steadyState.initialAcquisitionCost).toBe(12000);
    expect(x.projection.months[0]).toMatchObject({ acquisitionCost: 12000, founderLaborCost: 1000, netCash: -8600, economicSurplus: -9600 });
    expect(x.projection.months[1].customers).toBe(50);
    expect(x.projection.cashRequired).toBe(8600);
  });

  test("one-variable sensitivity matches independently calculated outcomes", () => {
    expect(model({ cac: 480 }).steadyState.economicSurplus).toBe(1440);
    expect(model({ variableCostPerCustomer: 40 }).steadyState.economicSurplus).toBe(1170);
    expect(model({ monthlyChurn: 0.08 }).steadyState.economicSurplus).toBe(1440);
    const x = model();
    expect(x.sensitivity).toHaveLength(6);
    const moreCAC = x.sensitivity.find(s => s.input === "cac" && s.direction === "higher")!;
    expect(moreCAC.value).toBe(288);
    expect(moreCAC.delta).toBeCloseTo(-96, 6);
  });

  test("independent scenarios do not share or mutate numeric assumptions", () => {
    const input = { ...base, pricePerCustomer: { value: 99, basis: "assumed" as const, note: "Price test" } };
    const before = JSON.stringify(input);
    const x = calculateScenarios({ downside: { ...input, monthlyChurn: 0.08 }, base: input, upside: { ...input, cac: 120 } });
    expect(x.downside.steadyState.economicSurplus).toBe(1440);
    expect(x.base.assumptions.pricePerCustomer.note).toBe("Price test");
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("missing data and adverse economics", () => {
  test("missing core inputs remain null rather than fabricated forecasts", () => {
    const x = calculateEconomics({});
    expect(x.errors).toEqual([]);
    expect(x.steadyState.revenue).toBeNull();
    expect(x.steadyState.economicSurplus).toBeNull();
    expect(x.projection.endingCash).toBeNull();
    expect(x.missingInputs).toContain("cac");
    expect(x.assumptions.setupFee).toMatchObject({ value: 0, basis: "assumed", defaulted: true });
    expect(x.assumptions.setupFee.note).toContain("assumed zero");
  });

  test("explicit unknown overrides optional default and preserves provenance", () => {
    const x = model({ refundRate: null, cac: { value: 100, basis: "unknown", note: "Unmeasured" }, pricePerCustomer: { value: 99, basis: "observed", sourceIds: ["receipt-1"], observedAt: "2026-09-26", note: "Paid pilot" } });
    expect(x.normalized.refundRate).toBeNull();
    expect(x.normalized.cac).toBeNull();
    expect(x.unitEconomics.cashContribution).toBeNull();
    expect(x.assumptions.pricePerCustomer).toMatchObject({ value: 99, basis: "observed", sourceIds: ["receipt-1"], note: "Paid pilot" });
    expect(x.warnings.join(" ")).toContain("not independent verification");
  });

  test("invalid numbers cannot appear as NaN, Infinity or a known output", () => {
    for (const invalid of [-1, Infinity, NaN, "99", {}, []]) {
      const x = model({ pricePerCustomer: invalid as any });
      expect(x.normalized.pricePerCustomer).toBeNull();
      expect(x.steadyState.revenue).toBeNull();
      expect(JSON.stringify(x)).not.toContain("NaN");
    }
    expect(model({ pricePerCustomer: {} as any }).errors.join(" ")).toContain("must include value");
    expect(model({ pricePerCustomer: { value: 100, basis: "verified" as any } }).errors.join(" ")).toContain("invalid assumption basis");
    expect(model({ monthlyChurn: 1.1 }).errors.join(" ")).toContain("monthlyChurn");
    expect(model({ currency: 123 as any }).errors.join(" ")).toContain("Currency");
    expect(model({ paymentFeeRate: -0.1 }).errors.join(" ")).toContain("paymentFeeRate");
    expect(calculateEconomics(null as any).steadyState.revenue).toBeNull();
    expect(model({ model: "magic" as any, currency: "cash", billingPeriodMonths: 2 as any }).errors).toHaveLength(3);
  });

  test("negative contribution never produces a bogus payback or break-even", () => {
    const x = model({ pricePerCustomer: 20, variableCostPerCustomer: 25 });
    expect(x.unitEconomics.cashContribution).toBe(-5);
    expect(x.unitEconomics.simplePaybackMonths).toBeNull();
    expect(x.unitEconomics.recoversCACWithin12Months).toBe(false);
    expect(x.steadyState.cashBreakEvenCustomers).toBeNull();
    expect(x.projection.cashBreakEvenMonth).toBeNull();
  });

  test("zero customers have only fixed expenses and startup costs", () => {
    const x = model({ activeCustomers: 0, newCustomersPerMonth: 0, startupCost: 1000 });
    expect(x.steadyState.revenue).toBe(0);
    expect(x.steadyState.cashSurplus).toBe(-300);
    expect(x.steadyState.economicSurplus).toBe(-1300);
    expect(x.projection.cashRequired).toBe(4600);
    expect(x.projection.months.every(m => m.acquisitionCost === 0 && m.netCash === -300)).toBe(true);
  });

  test("zero churn has a finite 12-month cohort, and full churn has only its first bill", () => {
    expect(model({ monthlyChurn: 0 }).unitEconomics.cohort12MonthContributionAfterCAC).toBe(648);
    const x = model({ monthlyChurn: 1 });
    expect(x.unitEconomics.cohort12MonthContributionAfterCAC).toBe(-166);
    expect(x.unitEconomics.cohortPaybackMonth).toBeNull();
    expect(x.unitEconomics.simplePaybackMonths).toBeCloseTo(3.2432, 4);
    expect(x.projection.months[1].customers).toBe(2);
  });

  test("simple positive payback can fail to recover CAC within a finite cohort", () => {
    const x = model({ monthlyChurn: 0.5 });
    expect(x.unitEconomics.simplePaybackMonths).toBeLessThan(4);
    expect(x.unitEconomics.recoversCACWithin12Months).toBe(false);
    expect(x.unitEconomics.cohortPaybackMonth).toBeNull();
  });
});

describe("costs, capacity and billing", () => {
  test("fees use gross price, refunds reduce revenue, setup never enters recurring revenue", () => {
    const x = model({ activeCustomers: 1, pricePerCustomer: 100, variableCostPerCustomer: 10, cac: 0, monthlyChurn: 0, setupFee: 50, onboardingCost: 5, refundRate: 0.1, paymentFeeRate: 0.03, paymentFeeFixed: 1 });
    expect(x.unitEconomics.cashContribution).toBe(76);
    expect(x.unitEconomics.upfrontContribution).toBe(38.5);
    expect(x.projection.months[0]).toMatchObject({ recurringRevenue: 90, oneTimeRevenue: 45, cashReceipts: 135, paymentFees: 5.5, onboardingCost: 5 });
    expect(x.projection.months[0].netCash).toBe(-185.5);
  });

  test("founder labor is charged once economically and is absent from cash expenses", () => {
    const x = model({ activeCustomers: 10, monthlyChurn: 0, newCustomersPerMonth: 0, cac: 0, founderHoursPerMonth: 2, founderHourlyRate: 50, hoursPerCustomer: 1, onboardingHoursPerCustomer: 0.5, salesHoursPerNewCustomer: 0.5 });
    const first = x.projection.months[0];
    expect(first.founderHours).toBe(22);
    expect(first.netCash).toBe(440);
    expect(first.founderLaborCost).toBe(1100);
    expect(first.economicSurplus).toBe(-660);
    expect(x.projection.months[1].economicSurplus).toBe(-160);
  });

  test("capacity caps launch and later arrivals, including fixed, sales and onboarding hours", () => {
    const x = model({ activeCustomers: 20, newCustomersPerMonth: 20, monthlyChurn: 0, availableHoursPerMonth: 30, founderHoursPerMonth: 10, hoursPerCustomer: 1, onboardingHoursPerCustomer: 0.5, salesHoursPerNewCustomer: 0.5 });
    expect(x.steadyState.withinCapacity).toBe(true);
    expect(x.projection.months[0]).toMatchObject({ customers: 10, newCustomers: 10, unmetNewCustomers: 10, founderHours: 30, capacityExceeded: false, acquisitionCost: 2400 });
    expect(x.projection.months[1]).toMatchObject({ customers: 15, newCustomers: 5, founderHours: 30, capacityExceeded: false });
    expect(x.warnings.join(" ")).toContain("only customers who can be served");
  });

  test("unknown capacity does not masquerade as verified feasibility", () => {
    const x = model({ availableHoursPerMonth: null, hoursPerCustomer: 10 });
    expect(x.steadyState.withinCapacity).toBeNull();
    expect(x.projection.months[0].customers).toBe(50);
    expect(x.projection.months[0].capacityExceeded).toBeNull();
    expect(x.warnings.join(" ")).toContain("not been capacity-checked");
  });

  test("annual prepayment separates cash, earned revenue and outstanding service obligations", () => {
    const x = model({ billingPeriodMonths: 12, activeCustomers: 1, pricePerCustomer: 100, variableCostPerCustomer: 10, fixedMonthlyCost: 0, founderHoursPerMonth: 0, cac: 0, monthlyChurn: 0.5, newCustomersPerMonth: 0 });
    expect(x.projection.months[0]).toMatchObject({ cashReceipts: 1200, revenue: 100, netCash: 1190, deferredRevenue: 1100 });
    expect(x.projection.months[1]).toMatchObject({ cashReceipts: 0, revenue: 100, netCash: -10, customers: 1 });
    expect(x.projection.months[11].deferredRevenue).toBe(0);
    expect(x.projection.totalRevenue).toBe(1200);
    expect(x.projection.endingCash).toBe(1080);
    expect(x.unitEconomics.cohort12MonthContributionAfterCAC).toBe(1080);
  });

  test("an annual prepayment temporarily above zero does not prove sustained cash break-even", () => {
    const x = model({ billingPeriodMonths: 12, activeCustomers: 1, pricePerCustomer: 100, variableCostPerCustomer: 110, fixedMonthlyCost: 0, founderHoursPerMonth: 0, cac: 0, newCustomersPerMonth: 0 });
    expect(x.projection.months[0].netCash).toBe(1090);
    expect(x.projection.endingCash).toBe(-120);
    expect(x.projection.cashBreakEvenMonth).toBeNull();
    expect(x.projection.firstPositiveCashMonth).toBe(1);
  });

  test("annual payment fee is collected once and amortized over earned contribution", () => {
    const x = model({ billingPeriodMonths: 12, activeCustomers: 1, pricePerCustomer: 100, variableCostPerCustomer: 0, paymentFeeFixed: 12, paymentFeeRate: 0.01, cac: 0, newCustomersPerMonth: 0, fixedMonthlyCost: 0, founderHoursPerMonth: 0 });
    expect(x.unitEconomics.cashContribution).toBe(98);
    expect(x.projection.months[0].paymentFees).toBe(24);
    expect(x.projection.months[1].paymentFees).toBe(0);
    expect(x.projection.months[0].economicSurplus).toBe(98);
    expect(x.projection.endingCash).toBe(1176);
  });

  test("usage prices multiply by units and missing units remain unknown", () => {
    const x = model({ model: "usage", activeCustomers: 10, unitsPerCustomer: 20, pricePerCustomer: 5, variableCostPerCustomer: 2 });
    expect(x.unitEconomics.cashContribution).toBe(60);
    expect(x.steadyState.revenue).toBe(1000);
    expect(model({ model: "usage" }).steadyState.revenue).toBeNull();
    expect(model({ model: "usage", billingPeriodMonths: 12 }).errors).not.toHaveLength(0);
  });

  test("one-time sales and services need new customers and have zero recurring revenue", () => {
    for (const revenueModel of ["one-time", "service"] as const) {
      const x = model({ model: revenueModel, activeCustomers: 10, newCustomersPerMonth: 2 });
      expect(x.steadyState.recurringRevenue).toBe(0);
      expect(x.steadyState.oneTimeRevenue).toBe(990);
      expect(x.steadyState.replacementAcquisitionCost).toBe(2400);
      expect(x.projection.months[0].recurringRevenue).toBe(0);
      expect(x.projection.months[1].customers).toBe(2);
      expect(x.projection.months[1].oneTimeRevenue).toBe(198);
      expect(x.unitEconomics.cohort12MonthContributionAfterCAC).toBe(-166);
      expect(x.unitEconomics.simplePaybackMonths).toBeNull();
    }
  });

  test("setup receipts cannot disguise cohort losses from ongoing delivery obligations", () => {
    const x = model({ pricePerCustomer: 0, variableCostPerCustomer: 100, setupFee: 1200, cac: 100, monthlyChurn: 0 });
    expect(x.unitEconomics.cohort12MonthContributionAfterCAC).toBe(-100);
    expect(x.unitEconomics.recoversCACWithin12Months).toBe(false);
    expect(x.unitEconomics.cohortPaybackMonth).toBeNull();
  });

  test("zero-value bills do not incur fixed payment fees, and a setup-only bill incurs one", () => {
    for (const billingPeriodMonths of [1, 12] as const) {
      const free = model({ billingPeriodMonths, activeCustomers: 1, pricePerCustomer: 0, variableCostPerCustomer: 0, setupFee: 0, paymentFeeFixed: 1, newCustomersPerMonth: 0, monthlyChurn: 0 });
      expect(free.unitEconomics.cashContribution).toBe(0);
      expect(free.projection.months.every(m => m.paymentFees === 0)).toBe(true);
      const setupOnly = model({ billingPeriodMonths, activeCustomers: 1, pricePerCustomer: 0, variableCostPerCustomer: 0, setupFee: 100, paymentFeeFixed: 1, newCustomersPerMonth: 0, monthlyChurn: 0 });
      expect(setupOnly.unitEconomics.cashContribution).toBe(0);
      expect(setupOnly.unitEconomics.upfrontContribution).toBe(99);
      expect(setupOnly.projection.months[0].paymentFees).toBe(1);
      expect(setupOnly.projection.months.slice(1).every(m => m.paymentFees === 0)).toBe(true);
      expect(setupOnly.projection.months[0].economicSurplus).toBe(100 - 1 - 240 - 300 - 1000);
    }
  });

  test("monthly cash conservation holds across churn, setup, refunds and capacity", () => {
    const x = model({ startupCost: 1234, setupFee: 149, onboardingCost: 35, refundRate: 0.06, paymentFeeRate: 0.03, paymentFeeFixed: 0.3, hoursPerCustomer: 2, onboardingHoursPerCustomer: 1, availableHoursPerMonth: 80 });
    let balance = -1234;
    for (const m of x.projection.months) {
      const expenses = m.deliveryCost! + m.paymentFees! + m.acquisitionCost! + m.onboardingCost! + 300;
      expect(m.netCash).toBeCloseTo(m.cashReceipts! - expenses, 8);
      expect(m.revenue).toBeCloseTo(m.recurringRevenue! + m.oneTimeRevenue!, 8);
      balance += m.netCash!;
      expect(m.cumulativeCash).toBeCloseTo(balance, 8);
      expect(m.founderHours!).toBeLessThanOrEqual(80 + 1e-9);
    }
    expect(x.projection.endingCash).toBeCloseTo(balance, 8);
  });
});
