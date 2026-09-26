import { describe, expect, test } from "bun:test";
import { recommendRevenueStreams, type ValuePattern } from "../src/revenue";

describe("revenue recommendations", () => {
  test("matches billing to the actual customer value pattern", () => {
    const cases = [
      ["urgent", "paid-service"], ["continuous", "subscription"], ["episodic", "usage"],
      ["finite", "one-time"], ["embedded", "license-api"], ["transaction", "transaction-fee"],
      ["audience", "sponsorship-affiliate"],
    ] as const;
    for (const [pattern, expected] of cases) {
      const x = recommendRevenueStreams({ valuePattern: pattern, buyer: "Small-business owner", hasAudience: true });
      expect(x.primary?.model).toBe(expected);
      expect(x.primary?.payer).toBe("Small-business owner");
      expect(x.primary?.reason.length).toBeGreaterThan(30);
      expect(x.primary?.experiment).toMatch(/paid|purchases|commercial/);
      expect(x.primary?.priceRange).toBeNull();
      expect(x.basis).toBe("heuristic");
      expect(x.warnings.join(" ")).toContain("not demand validation");
    }
  });

  test("new, unvalidated B2B workflows start with a pilot before recurring assumptions", () => {
    const x = recommendRevenueStreams({ valuePattern: "continuous", newMarket: true });
    expect(x.primary?.model).toBe("paid-service");
    expect(x.complementary.map(s => s.model)).toEqual(["subscription"]);
    expect(x.complementary[0].reason).toContain("after pilots");
    const validated = recommendRevenueStreams({ valuePattern: "continuous", newMarket: true, validatedRepeatUse: true });
    expect(validated.primary?.model).toBe("subscription");
  });

  test("occasional and finite purchase frequency overrides an unsupported subscription", () => {
    const occasional = recommendRevenueStreams({ valuePattern: "continuous", frequency: "occasional" });
    expect(occasional.primary?.model).toBe("usage");
    expect(occasional.warnings.join(" ")).toContain("conflict");
    expect(recommendRevenueStreams({ valuePattern: "continuous", frequency: "one-off" }).primary?.model).toBe("one-time");
  });

  test("hands-on episodic work accounts for scoped delivery, not only metered compute", () => {
    const x = recommendRevenueStreams({ valuePattern: "episodic", handsOn: true });
    expect(x.primary?.model).toBe("paid-service");
    expect(x.complementary.map(s => s.model)).not.toContain("subscription");
  });

  test("unknown audience cannot justify sponsorship revenue", () => {
    for (const hasAudience of [undefined, false, "true" as any]) {
      const x = recommendRevenueStreams({ valuePattern: "audience", hasAudience });
      expect(x.primary).toBeNull();
      expect(x.warnings.join(" ")).toContain("measurable audience");
    }
  });

  test("missing or invalid buyer-value inputs return a research task without invented prices", () => {
    for (const input of [{}, { valuePattern: "everything" }, null, []]) {
      const x = recommendRevenueStreams(input as any);
      expect(x.primary).toBeNull();
      expect(x.validationPath.length).toBeGreaterThan(0);
    }
    expect(recommendRevenueStreams({ valuePattern: "continuous" }).primary?.payer).toContain("identify before testing");
  });

  test("complementary revenue remains conditional and is never aggregated", () => {
    const x = recommendRevenueStreams({ valuePattern: "subscription" as ValuePattern });
    expect(x.primary).toBeNull();
    const recurring = recommendRevenueStreams({ valuePattern: "continuous" });
    expect(recurring.complementary[0].reason).toContain("one-time revenue");
    expect(recurring.complementary[0].prerequisites.length).toBeGreaterThan(0);
    expect(recurring.warnings.join(" ")).toContain("do not add");
    expect(recurring.warnings.join(" ")).toContain("retention and revenue remain assumptions");
  });

  test("returned recommendations do not share mutable template arrays", () => {
    const x = recommendRevenueStreams({ valuePattern: "urgent" });
    x.primary!.prerequisites.splice(0);
    expect(recommendRevenueStreams({ valuePattern: "urgent" }).primary!.prerequisites.length).toBeGreaterThan(0);
  });
});
