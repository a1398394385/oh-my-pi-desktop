// Composer prediction parsing (host/prediction.ts): the reply normalization is the only place
// model output becomes ghost text, so list markers, preambles, repeats, the skip reply and the
// length ceiling are all pinned here.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/prediction-parse.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { parsePrediction, parsePredictions } from "../host/prediction.ts";

describe("single prediction", () => {
  test("unwraps quotes and collapses whitespace", () => {
    expect(parsePrediction('  “继续  下一步”  ')).toBe("继续 下一步");
    expect(parsePrediction('"ship it"')).toBe("ship it");
    expect(parsePrediction("`run the tests`")).toBe("run the tests");
  });

  test("a skip or an over-long reply is no prediction", () => {
    expect(parsePrediction("NO_PREDICTION")).toBeUndefined();
    expect(parsePrediction(`NO_PREDICTION — nothing obvious`)).toBeUndefined();
    expect(parsePrediction("x".repeat(501))).toBeUndefined();
    expect(parsePrediction("   ")).toBeUndefined();
  });
});

describe("alternatives", () => {
  test("keeps order, strips list markers and the preamble", () => {
    expect(parsePredictions("Here are options:\n1. fix the test\n- run the suite\n* ship it", 4)).toEqual([
      "fix the test",
      "run the suite",
      "ship it",
    ]);
  });

  test("dedupes up to case and punctuation", () => {
    expect(parsePredictions("Run the tests\nrun the tests!\nRun, the tests", 4)).toEqual(["Run the tests"]);
  });

  test("stops at the cap and at a leading skip", () => {
    expect(parsePredictions("a\na2\na3\na4\na5", 2)).toEqual(["a", "a2"]);
    expect(parsePredictions("NO_PREDICTION\nsomething", 4)).toBeUndefined();
  });

  test("nothing usable is no prediction", () => {
    expect(parsePredictions("\n\n", 4)).toBeUndefined();
    expect(parsePredictions("x".repeat(501), 4)).toBeUndefined();
  });
});
