// Repository grouping behind the "one project row per repository" list mode
// (host/repo-roots.ts): which checkout a registered project dir belongs to, and how
// several checkouts of one repo collapse into one group. The fs-only root detection is
// what makes the per-frame grouping free of git subprocesses, so both .git shapes git
// actually writes are pinned here, plus the collision naming the sidebar shows.
// Run: bun test scripts/repo-roots.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRootOf, parseWorktreeList, worktreesOf, repoGroups } from "../host/repo-roots";

let tmp = "";
const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

beforeAll(() => {
  // realpath: git stores the real path in a linked worktree's .git file, and macOS puts
  // os.tmpdir() behind /var → /private/var
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-repo-roots-")));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("repoRootOf", () => {
  test("plain checkout (.git directory) is its own root", () => {
    const repo = path.join(tmp, "plain");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    expect(repoRootOf(repo)).toBe(repo);
  });

  test("linked worktree (.git file) resolves to the primary checkout", () => {
    const repo = path.join(tmp, "clone");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    const side = path.join(tmp, "clone-side");
    git(repo, ["worktree", "add", "-q", "-b", "side", side]);
    expect(fs.statSync(path.join(side, ".git")).isFile()).toBe(true);
    expect(repoRootOf(side)).toBe(repo);
  });

  test("a directory without .git has no root", () => {
    const plainDir = path.join(tmp, "not-a-repo");
    fs.mkdirSync(plainDir);
    expect(repoRootOf(plainDir)).toBeNull();
  });
});

describe("parseWorktreeList", () => {
  test("keeps every record and derives the branch short name", () => {
    const stdout = [
      "worktree /repo/main",
      "HEAD 111",
      "branch refs/heads/main",
      "",
      "worktree /repo/side",
      "HEAD 222",
      "detached",
    ].join("\n");
    expect(parseWorktreeList(stdout)).toEqual([
      { path: "/repo/main", branch: "main", detached: false },
      { path: "/repo/side", branch: "", detached: true },
    ]);
  });

  test("a bare repository is dropped: it has no working tree", () => {
    const stdout = ["worktree /repo/bare.git", "HEAD 111", "bare", "", "worktree /repo/main", "HEAD 222", "branch refs/heads/main"].join("\n");
    expect(parseWorktreeList(stdout)).toEqual([{ path: "/repo/main", branch: "main", detached: false }]);
  });
});

describe("repoGroups", () => {
  test("checkouts of one repository collapse into one group with its worktrees", async () => {
    const repo = path.join(tmp, "multi");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    const side = path.join(tmp, "multi-side");
    git(repo, ["worktree", "add", "-q", "-b", "side", side]);
    const groups = await repoGroups([repo, side, path.join(tmp, "not-a-repo")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root).toBe(repo);
    expect(groups[0].name).toBe("multi");
    expect(groups[0].cwds.sort()).toEqual([repo, side].sort());
    expect(groups[0].worktrees.map((w) => w.branch).sort()).toEqual(["main", "side"]);
    expect(await worktreesOf(repo)).toHaveLength(2);
  });

  test("same-named repositories keep the parent directory in their display name", async () => {
    const a = path.join(tmp, "a", "same");
    const b = path.join(tmp, "b", "same");
    for (const repo of [a, b]) {
      fs.mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
    }
    const groups = await repoGroups([a, b]);
    expect(groups.map((g) => g.name).sort()).toEqual(["a/same", "b/same"]);
  });
});
