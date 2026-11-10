// `git worktree list --porcelain` parsing behind the Git page's workspace
// switcher (host/rpc/git-graph.ts). The rows decide which checkouts the pill can
// offer and which one is marked current, so the cases pinned here are the shapes
// git actually prints: blank-line separated records, detached checkouts, and the
// bare repository entry that has no files to show.
// Run: bun test scripts/git-worktrees.test.ts
import { describe, expect, test } from "bun:test";
import { parseWorktrees } from "../host/rpc/git-graph";

describe("parseWorktrees", () => {
  test("marks the caller's own checkout and lists the rest", () => {
    const stdout = [
      "worktree /repo/main",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/side",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/omp/desktop/feat-login",
    ].join("\n");
    expect(parseWorktrees(stdout, "/repo/side")).toEqual([
      { path: "/repo/main", branch: "main", detached: false, current: false },
      { path: "/repo/side", branch: "omp/desktop/feat-login", detached: false, current: true },
    ]);
  });

  test("a detached checkout keeps the path and reports no branch", () => {
    const stdout = ["worktree /repo/main", "HEAD 111", "detached"].join("\n");
    expect(parseWorktrees(stdout, "/repo/main")).toEqual([
      { path: "/repo/main", branch: "", detached: true, current: true },
    ]);
  });

  test("a bare repository is dropped: there is nothing to diff", () => {
    const stdout = ["worktree /repo/bare.git", "HEAD 111", "bare", "", "worktree /repo/main", "HEAD 222", "branch refs/heads/main"].join("\n");
    expect(parseWorktrees(stdout, "/repo/main")).toEqual([
      { path: "/repo/main", branch: "main", detached: false, current: true },
    ]);
  });
});
