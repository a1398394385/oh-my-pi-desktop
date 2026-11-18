import { describe, expect, test } from "bun:test";
import { SMART_STEP_MS, nextSmartCadence } from "../host/keepalive-config.ts";

const base = { maxIdleMs: 3_600_000, growthHeld: false };

describe("nextSmartCadence", () => {
  // Regression: the >200k guard used to rewrite the cadence to the settings
  // base (5m), throwing away the model's own confirmed TTL (25m). It must now
  // freeze in place and only stop the climb.
  test("long context freezes at the confirmed per-model TTL", () => {
    expect(nextSmartCadence(1_500_000, 483_447, base)).toEqual({
      cadenceMs: 1_500_000,
      growthHeld: true,
    });
  });

  test("long context freezes a climbing cadence too", () => {
    expect(nextSmartCadence(480_000, 201_000, base)).toEqual({
      cadenceMs: 480_000,
      growthHeld: true,
    });
  });

  test("below the cap grows by one step", () => {
    expect(nextSmartCadence(300_000, 199_999, base)).toEqual({
      cadenceMs: 300_000 + SMART_STEP_MS,
      growthHeld: false,
    });
  });

  test("a held cadence does not grow", () => {
    expect(nextSmartCadence(300_000, 10_000, { ...base, growthHeld: true })).toEqual({
      cadenceMs: 300_000,
      growthHeld: true,
    });
  });

  test("maxIdle fences growth without pinning the base", () => {
    expect(nextSmartCadence(3_570_000, 10_000, base)).toEqual({
      cadenceMs: 3_570_000,
      growthHeld: false,
    });
  });
});
