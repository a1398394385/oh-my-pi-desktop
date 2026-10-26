// Path → directory tree shared by the Git page's file lists
// (ui-src/components/main/git/path-tree.ts). The tree drives the flat/tree
// toggle of the working-changes column and the commit detail file list.
// Run: bun test scripts/git-path-tree.test.ts
import { describe, expect, test } from "bun:test";
import { buildPathTree } from "../ui-src/components/main/git/path-tree";

describe("buildPathTree", () => {
  test("nested paths become nested directories", () => {
    const tree = buildPathTree([{ path: "src/app/main.ts" }], (f) => f.path);
    expect([...tree.dirs.keys()]).toEqual(["src"]);
    const src = tree.dirs.get("src")!;
    expect([...src.dirs.keys()]).toEqual(["app"]);
    expect(src.dirs.get("app")!.files.map((f) => f.path)).toEqual(["src/app/main.ts"]);
  });

  test("root-level files stay at the root", () => {
    const tree = buildPathTree([{ path: "a.md" }, { path: "b.md" }], (f) => f.path);
    expect(tree.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(tree.dirs.size).toBe(0);
  });

  test("files in one directory keep their input order", () => {
    const tree = buildPathTree([{ path: "d/2.ts" }, { path: "d/1.ts" }], (f) => f.path);
    expect(tree.dirs.get("d")!.files.map((f) => f.path)).toEqual(["d/2.ts", "d/1.ts"]);
  });
});
