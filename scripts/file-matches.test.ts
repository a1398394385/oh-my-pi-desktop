// @-mention candidates must treat a symlinked directory as a directory: repos
// living under ~ are usually links into another volume, and dirent.isDirectory()
// is false for links, so Tab could never drill into them.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/file-matches.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFileMatches } from "../host/rpc/prompt";

let root = "";
let real = "";
/** A link to a directory could be created (symlink, or junction as fallback). */
let hasDirLink = false;
/** A link to a missing target could be created. */
let hasBrokenLink = false;

/**
 * Create a link, reporting whether the platform allowed it. Windows refuses
 * symlinks without the SeCreateSymbolicLinkPrivilege (Developer Mode or an
 * elevated shell); a junction needs no privilege and exercises the same path
 * (dirent.isDirectory() is false for both).
 */
function tryLink(target: string, linkPath: string, type: "dir" | "file" | "junction"): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-matches-"));
  real = path.join(root, "realdir");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "inner.ts"), "");
  const linkPath = path.join(root, "linkdir");
  hasDirLink = tryLink(real, linkPath, "dir") || tryLink(real, linkPath, "junction");
  fs.writeFileSync(path.join(root, "plain.txt"), "");
  hasBrokenLink = tryLink(path.join(root, "gone"), path.join(root, "broken"), "file");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listFileMatches prefix listing", () => {
  test("a symlinked directory is reported as a directory and can be drilled", async () => {
    if (!hasDirLink) {
      // No link could be created on this platform: the equivalent coverage is
      // that a plain directory is reported as a directory and can be drilled.
      const plain = await listFileMatches(root, "real");
      expect(plain.map((h) => [h.path, h.dir])).toEqual([["realdir/", true]]);
      const plainChildren = await listFileMatches(root, "realdir/");
      expect(plainChildren.map((h) => [h.path, h.dir])).toEqual([["realdir/inner.ts", false]]);
      return;
    }
    // A link must not read as a file: dirent.isDirectory() is false for links.
    const hits = await listFileMatches(root, "link");
    expect(hits.map((h) => [h.path, h.dir])).toEqual([["linkdir/", true]]);

    const children = await listFileMatches(root, "linkdir/");
    expect(children.map((h) => [h.path, h.dir])).toEqual([["linkdir/inner.ts", false]]);
  });

  test("a plain file stays a file and a broken link is not a directory", async () => {
    const hits = await listFileMatches(root, "plain");
    expect(hits.map((h) => [h.path, h.dir])).toEqual([["plain.txt", false]]);

    if (!hasBrokenLink) {
      // No broken link could be created on this platform: the plain file above
      // already covers the "a link is not a directory" classification.
      return;
    }
    // A link whose target is gone cannot be stat'ed, so it stays a file.
    const listing = await listFileMatches(root, "");
    expect(listing.map((h) => [h.path, h.dir])).toContainEqual(["broken", false]);
  });
});

describe("listFileMatches path prefixes", () => {
  // A bare @ must show the root's own level: fuzzyFind on an empty query walks
  // the tree and fills the card with deep directories instead.
  test("a bare @ lists the root level only, directories first", async () => {
    const hits = await listFileMatches(root, "");
    // The links are only there when the platform allowed creating them.
    const expected: Array<[string, boolean]> = [];
    if (hasDirLink) expected.push(["linkdir", true]);
    expected.push(["realdir", true]);
    if (hasBrokenLink) expected.push(["broken", false]);
    expected.push(["plain.txt", false]);
    expect(hits.map((h) => [h.path, h.dir])).toEqual(expected);
  });

  // A path prefix completes one directory listing; fuzzyFind would also match
  // the same name in unrelated subtrees.
  test("a relative prefix lists that directory only, keeping the query's own separators", async () => {
    expect((await listFileMatches(root, "realdir/")).map((h) => [h.path, h.dir])).toEqual([["realdir/inner.ts", false]]);
    expect((await listFileMatches(root, "re")).map((h) => [h.path, h.dir])).toEqual([
      ["realdir/", true],
    ]);
  });
});
