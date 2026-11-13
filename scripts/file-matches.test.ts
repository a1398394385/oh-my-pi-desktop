// @-mention candidates must treat a symlinked directory as a directory: repos
// living under ~ are usually links into another volume, and dirent.isDirectory()
// is false for links, so Tab could never drill into them.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/file-matches.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listFileMatches } from "../host/rpc/prompt";

let root = "";
let real = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omp-matches-"));
  real = path.join(root, "realdir");
  await mkdir(real);
  await writeFile(path.join(real, "inner.ts"), "");
  await symlink(real, path.join(root, "linkdir"));
  await writeFile(path.join(root, "plain.txt"), "");
  await symlink(path.join(root, "gone"), path.join(root, "broken"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listFileMatches prefix listing", () => {
  test("a symlinked directory is reported as a directory and can be drilled", async () => {
    const hits = await listFileMatches(root, path.join(root, "link"));
    expect(hits).toEqual([{ path: path.join(root, "linkdir"), dir: true, empty: false }]);

    const children = await listFileMatches(root, path.join(root, "linkdir") + "/");
    expect(children.map((h) => [h.path, h.dir])).toEqual([[path.join(root, "linkdir") + "/inner.ts", false]]);
  });

  test("a plain file stays a file and a broken link is not a directory", async () => {
    const hits = await listFileMatches(root, path.join(root, "plain"));
    expect(hits.map((h) => [h.path, h.dir])).toEqual([[path.join(root, "plain.txt"), false]]);

    const broken = await listFileMatches(root, path.join(root, "broken"));
    expect(broken.map((h) => [h.path, h.dir])).toEqual([[path.join(root, "broken"), false]]);
  });
});

describe("listFileMatches path prefixes", () => {
  // A bare @ must show the root's own level: fuzzyFind on an empty query walks
  // the tree and fills the card with deep directories instead.
  test("a bare @ lists the root level only, directories first", async () => {
    const hits = await listFileMatches(root, "");
    expect(hits.map((h) => [h.path, h.dir])).toEqual([
      ["linkdir", true],
      ["realdir", true],
      ["broken", false],
      ["plain.txt", false],
    ]);
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
