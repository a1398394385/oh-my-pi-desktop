import { describe, expect, test } from "bun:test";
import { effectiveProbeCost, estimateProbeSpendUsd, estimateSavedUsd } from "../host/keepalive-lib.ts";

describe("effectiveProbeCost", () => {
  const zeroCost = { input: 0, output: 0, cacheRead: 0 };

  test("pay-as-you-go catalog cost passes through untouched", () => {
    const cost = { input: 0.3, output: 1.2, cacheRead: 0.006 };
    expect(effectiveProbeCost("bulita/glm-5.3-flashx", cost)).toBe(cost);
  });

  test("all-zero subscription cost is replaced by the list API price", () => {
    expect(effectiveProbeCost("zhipu-coding-plan/glm-5.3-flashx", zeroCost)).toEqual({
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
    });
  });

  test("missing cost on a listed subscription model gets the list price", () => {
    expect(effectiveProbeCost("zhipu-coding-plan/glm-5.3", undefined)).toEqual({ input: 1.4, output: 4.4 });
  });

  test("missing cost on an unlisted model stays missing", () => {
    expect(effectiveProbeCost("shiyi/glm-5.3-flashx", undefined)).toBeUndefined();
  });
});

describe("probe estimates with subscription list prices", () => {
  const usage = { inputTokens: 190_000, cacheReadTokens: 180_000, outputTokens: 100 };

  test("savedUsd reflects real input-vs-cacheRead delta", () => {
    const cost = effectiveProbeCost("zhipu-coding-plan/glm-5.3-flashx", { input: 0, output: 0, cacheRead: 0 });
    // (180k/1M) * (0.15 - 0.03) = 0.0216
    expect(estimateSavedUsd(usage.cacheReadTokens, cost)).toBeCloseTo(0.0216, 6);
  });

  test("probe spend is non-zero", () => {
    const cost = effectiveProbeCost("zhipu-coding-plan/glm-5.3-flashx", { input: 0, output: 0, cacheRead: 0 });
    expect(estimateProbeSpendUsd(usage as never, cost)).toBeGreaterThan(0);
  });
});
