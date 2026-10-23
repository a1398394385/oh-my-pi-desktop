import { describe, expect, test } from "bun:test";
import {
  catalogListCost,
  effectiveProbeCost,
  estimateProbeSpendUsd,
  estimateSavedUsd,
} from "../host/keepalive-lib.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0 };

describe("catalogListCost", () => {
  // The subscription plan's own row prices at 0; the same bare model id is also
  // listed by pay-as-you-go providers, which carry the list price.
  const rows = [
    { id: "glm-5.3", cost: zeroCost },
    { id: "glm-5.3", cost: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
    { id: "glm-5.3", cost: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
    { id: "glm-5.3", cost: { input: 2.8, output: 8.8, cacheRead: 0.56 } },
  ];

  test("modal non-zero sibling price wins", () => {
    expect(catalogListCost("glm-5.3", rows)).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26 });
  });

  test("prices never carry a zero cacheRead when the sibling prices one", () => {
    // Regression: a missing cacheRead made saved == spend (both billed at input).
    expect(catalogListCost("glm-5.3", rows)?.cacheRead).toBeGreaterThan(0);
  });

  test("an id with no priced row yields nothing", () => {
    expect(catalogListCost("glm-5.3-flash", rows)).toBeUndefined();
  });

  test("a tie goes to the cheapest input", () => {
    const tie = [
      { id: "m", cost: { input: 2, output: 4, cacheRead: 0.2 } },
      { id: "m", cost: { input: 1, output: 4, cacheRead: 0.1 } },
    ];
    expect(catalogListCost("m", tie)).toEqual({ input: 1, output: 4, cacheRead: 0.1 });
  });
});

describe("effectiveProbeCost", () => {
  test("pay-as-you-go catalog cost passes through untouched", () => {
    const cost = { input: 0.3, output: 1.2, cacheRead: 0.006 };
    expect(effectiveProbeCost(cost, undefined)).toBe(cost);
  });

  test("all-zero subscription cost is replaced by the sibling list price", () => {
    const list = { input: 0.15, output: 0.5, cacheRead: 0.03 };
    expect(effectiveProbeCost(zeroCost, list)).toBe(list);
  });

  test("without a sibling price the zeroed cost stays as it is", () => {
    expect(effectiveProbeCost(zeroCost, undefined)).toBe(zeroCost);
    expect(effectiveProbeCost(undefined, undefined)).toBeUndefined();
  });
});

describe("probe estimates with list prices", () => {
  const cost = { input: 1.4, output: 4.4, cacheRead: 0.26 };
  const usage = { inputTokens: 136_587, cacheReadTokens: 136_576, cacheWriteTokens: 0, outputTokens: 810 };

  test("savedUsd reflects the real input-vs-cacheRead delta", () => {
    // (136576/1M) * (1.4 - 0.26) = 0.15570
    expect(estimateSavedUsd(usage.cacheReadTokens, cost)).toBeCloseTo(0.1557, 4);
  });

  test("spend and saved do not collapse into the same number", () => {
    const spend = estimateProbeSpendUsd(usage, cost);
    const saved = estimateSavedUsd(usage.cacheReadTokens, cost);
    // 0.0355 cache read + 0.0036 output
    expect(spend).toBeCloseTo(0.0391, 4);
    expect(saved).toBeGreaterThan(spend + 0.1);
  });
});
