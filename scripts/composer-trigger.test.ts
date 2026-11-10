// Composer @-mention drill: the Tab drill must leave a trailing slash so the
// host's prefix listing (`query.endsWith("/")`) lists the directory's children
// instead of re-listing the directory itself.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/composer-trigger.test.ts
import { describe, expect, test } from "bun:test";
import { detectTrigger, insertFile } from "../ui-src/components/composer/trigger";

describe("insertFile", () => {
  test("picked file gets a trailing space", () => {
    expect(insertFile("~/x.ts", false, false)).toBe("@~/x.ts ");
  });

  test("picked directory gets a trailing space and no slash", () => {
    expect(insertFile("~/Github/ZCodium", false, false)).toBe("@~/Github/ZCodium ");
  });

  test("drilled directory keeps the slash inside the quotes and no space", () => {
    expect(insertFile("~/Github/ZCodium", true, false)).toBe("@~/Github/ZCodium/");
    expect(insertFile("~/My Dir/sub", true, false)).toBe('@"~/My Dir/sub/"');
  });
});

describe("drill text re-triggers the file completion", () => {
  test("unquoted drill resolves the trailing-slash query at the caret tail", () => {
    const text = insertFile("~/Github/ZCodium", true, false);
    expect(detectTrigger(text, text.length)).toEqual({
      kind: "file",
      start: 0,
      end: text.length,
      query: "~/Github/ZCodium/",
      quoted: false,
    });
  });

  test("quoted drill resolves at the caret parked before the closing quote", () => {
    const text = insertFile("~/My Dir/sub", true, false);
    expect(detectTrigger(text, text.length - 1)).toEqual({
      kind: "file",
      start: 0,
      end: text.length - 1,
      query: "~/My Dir/sub/",
      quoted: true,
    });
  });
});
