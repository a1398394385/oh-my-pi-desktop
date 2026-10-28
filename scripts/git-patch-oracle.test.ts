// Oracle test for line-level staging: real git in a temp repo, so selectLines'
// output has to survive `git apply` for stage, unstage and discard.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitRead, gitWrite } from "../host/git.ts";
import { applyLines, type GitRunner } from "../host/git-patch.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-git-patch-"));
const file = path.join(dir, "f.txt");
const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
/** 1-based line numbers the work tree edits. */
const CHANGED = [2, 5, 8, 12, 15, 18];
const PICKED = [5, 15];

function run(args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** Written lines that differ from the committed ones, 1-based. */
function changedLines(): number[] {
  const now = fs.readFileSync(file, "utf8").split("\n");
  return LINES.map((l, i) => (now[i] === l ? 0 : i + 1)).filter(Boolean);
}

const runner: GitRunner = {
  read: (args, input) => gitRead(dir, args, { input }),
  write: (args, input) => gitWrite(dir, args, { input }),
};

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("line-level staging against real git", () => {
  test("setup: clean repo with 20 lines", () => {
    run(["init", "-q", "."]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    fs.writeFileSync(file, `${LINES.join("\n")}\n`);
    run(["add", "-A"]);
    run(["commit", "-qm", "base"]);
    const edited = LINES.map((l, i) => (CHANGED.includes(i + 1) ? `changed ${i + 1}` : l));
    fs.writeFileSync(file, `${edited.join("\n")}\n`);
    expect(changedLines()).toEqual(CHANGED);
  });

  test("stage two of six scattered edits stages exactly those", async () => {
    expect(await applyLines(runner, dir, "f.txt", PICKED, "stage")).toBeNull();
    const staged = run(["show", ":f.txt"]).split("\n");
    expect(staged.slice(0, 20).map((l, i) => (l === LINES[i] ? 0 : i + 1)).filter(Boolean)).toEqual(PICKED);
    // The work tree still differs from the index in the other four places.
    expect(changedLines()).toEqual(CHANGED);
    expect(await applyLines(runner, dir, "f.txt", PICKED, "unstage")).toBeNull();
    expect(run(["diff", "--cached"]).trim()).toBe("");
  });

  test("unstage two of six staged edits leaves the rest staged", async () => {
    run(["add", "--", "f.txt"]);
    expect(await applyLines(runner, dir, "f.txt", PICKED, "unstage")).toBeNull();
    const staged = run(["show", ":f.txt"]).split("\n");
    expect(staged.slice(0, 20).map((l, i) => (l === LINES[i] ? 0 : i + 1)).filter(Boolean)).toEqual(
      CHANGED.filter((n) => !PICKED.includes(n)),
    );
    run(["reset", "-q", "HEAD", "--", "f.txt"]);
  });

  test("discard two of six work-tree edits reverts exactly those", async () => {
    expect(await applyLines(runner, dir, "f.txt", PICKED, "discard")).toBeNull();
    expect(changedLines()).toEqual(CHANGED.filter((n) => !PICKED.includes(n)));
  });

  test("an added file is refused instead of half-applied", async () => {
    fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
    run(["add", "-N", "--", "new.txt"]); // intent-to-add: now git diff reports it as a new file
    expect(await applyLines(runner, dir, "new.txt", [1], "stage")).toContain("not possible");
    expect(run(["diff", "--cached", "--", "new.txt"]).trim()).toBe("");
  });
});
