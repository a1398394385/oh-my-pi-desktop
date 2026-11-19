// External-behavior seam test for worktree_create_session (spec
// docs/architecture/managed-worktree-spec.md): real git in temp repos + a pseudo
// ws. Assertions stay on the observable surface only — reply frames and real
// disk/git state — never on internal helpers or call order.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/worktree-create-session.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeHandlers } from "../host/rpc/worktree.ts";

interface FakeSocket {
  sent: string[];
  send(data: string): void;
  frames(): Record<string, unknown>[];
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(data);
    },
    frames() {
      return sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    },
  };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: GIT_ENV });
  return { ok: p.exitCode === 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function mustGit(dir: string, args: string[]): string {
  const r = git(dir, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A committed repo named `name` inside its own temp parent (stable basename for path assertions). */
function makeRepo(name: string, commit = true): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `omp-wtcs-${name}-`));
  tmpDirs.push(parent);
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  mustGit(dir, ["init", "-q", "."]);
  mustGit(dir, ["config", "user.email", "t@t"]);
  mustGit(dir, ["config", "user.name", "t"]);
  if (commit) {
    fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
    mustGit(dir, ["add", "-A"]);
    mustGit(dir, ["commit", "-qm", "base"]);
  }
  return dir;
}

async function call(baseCwd: string, reqId = 1): Promise<{ ws: FakeSocket; reply: Record<string, unknown> }> {
  const ws = fakeSocket();
  await worktreeHandlers.worktree_create_session(ws as never, { type: "worktree_create_session", reqId, baseCwd });
  return { ws, reply: ws.frames().at(-1) ?? {} };
}

const BUCKET_RE = /^[0-9a-f]{4}$/;

describe("worktree_create_session", () => {
  test("root project: ok frame, copy on disk, clean both statuses, no .omp noise", async () => {
    const repo = makeRepo("repo");
    const head = mustGit(repo, ["rev-parse", "HEAD"]);
    const { reply } = await call(repo);

    expect(reply.type).toBe("worktree_created");
    expect(reply.ok).toBe(true);
    // Detached contract: the reused frame carries no branch field.
    expect("branch" in reply).toBe(false);
    expect(reply.head).toBe(head);

    const copyPath = reply.path as string;
    expect(copyPath).toMatch(new RegExp(`^${path.join(repo, ".omp", "worktrees")}/[0-9a-f]{4}/repo$`));
    expect(reply.cwd).toBe(copyPath);
    expect(reply.baseCwd).toBe(repo);
    expect(fs.existsSync(path.join(copyPath, ".git"))).toBe(true);

    // Copy checked out at HEAD, detached, clean.
    expect(mustGit(copyPath, ["rev-parse", "HEAD"])).toBe(head);
    expect(mustGit(copyPath, ["status", "--porcelain"])).toBe("");
    expect(git(copyPath, ["symbolic-ref", "-q", "HEAD"]).ok).toBe(false);

    // Primary repo stays clean: exclude hid the managed root.
    expect(mustGit(repo, ["status", "--porcelain"])).toBe("");
    // And the copy shows up in the worktree list.
    expect(mustGit(repo, ["worktree", "list", "--porcelain"])).toContain(copyPath);
  });

  test("subdir project: cwd lands on the mirrored subdir inside the copy", async () => {
    const repo = makeRepo("subdir-repo");
    fs.mkdirSync(path.join(repo, "nested"));
    fs.writeFileSync(path.join(repo, "nested", "n.txt"), "n\n");
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-qm", "nested"]);

    const { reply } = await call(path.join(repo, "nested"));
    expect(reply.ok).toBe(true);
    const copyPath = reply.path as string;
    expect(reply.cwd).toBe(path.join(copyPath, "nested"));
    expect(fs.existsSync(path.join(reply.cwd as string, "n.txt"))).toBe(true);
    expect(mustGit(repo, ["status", "--porcelain"])).toBe("");
  });

  test("two consecutive creates claim two different buckets, both registered", async () => {
    const repo = makeRepo("twice-repo");
    const a = await call(repo, 1);
    const b = await call(repo, 2);
    expect(a.reply.ok).toBe(true);
    expect(b.reply.ok).toBe(true);
    const bucketOf = (p: string) => p.split(path.sep).at(-2)!;
    expect(bucketOf(a.reply.path as string)).toMatch(BUCKET_RE);
    expect(bucketOf(b.reply.path as string)).toMatch(BUCKET_RE);
    expect(a.reply.path).not.toBe(b.reply.path);
    const list = mustGit(repo, ["worktree", "list", "--porcelain"]);
    expect(list).toContain(a.reply.path as string);
    expect(list).toContain(b.reply.path as string);
  });

  test("non-git directory: not_a_repo, nothing written to disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-wtcs-notrepo-"));
    tmpDirs.push(dir);
    const { reply } = await call(dir);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("not_a_repo");
    expect(fs.existsSync(path.join(dir, ".omp"))).toBe(false);
  });

  test("empty repository: start_ref_unresolvable, no .omp residue", async () => {
    const repo = makeRepo("empty-repo", false);
    const { reply } = await call(repo);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("start_ref_unresolvable");
    expect(fs.existsSync(path.join(repo, ".omp"))).toBe(false);
    expect(mustGit(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  test("project subdir missing at HEAD: start_ref_missing_subdir", async () => {
    const repo = makeRepo("ghost-repo");
    fs.mkdirSync(path.join(repo, "ghost")); // on disk, but untracked and absent at HEAD
    const { reply } = await call(path.join(repo, "ghost"));
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("start_ref_missing_subdir");
    expect(fs.existsSync(path.join(repo, ".omp"))).toBe(false);
  });

  test("worktree add failure: cleanup contract — no bucket dir, no admin entry", async () => {
    const repo = makeRepo("rollback-repo");
    // Read-only worktree admin dir: `worktree add` cannot register the new
    // checkout and fails deterministically regardless of the random bucket.
    fs.chmodSync(path.join(repo, ".git"), 0o555);
    try {
      const { reply } = await call(repo);
      expect(reply.ok).toBe(false);
      expect(reply.code).toBe("worktree_create_failed");

      const managedRoot = path.join(repo, ".omp", "worktrees");
      // No bucket survives the rollback (the macOS Spotlight marker may exist).
      expect(fs.readdirSync(managedRoot).filter((e) => BUCKET_RE.test(e))).toEqual([]);
      const list = mustGit(repo, ["worktree", "list", "--porcelain"]);
      expect(list.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1); // primary only
      // The failure left no untracked residue behind either.
      expect(mustGit(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      fs.chmodSync(path.join(repo, ".git"), 0o755); // let afterAll wipe the temp dir
    }
  });

  test("tracked file under the managed root: worktree_root_tracked refusal", async () => {
    const repo = makeRepo("tracked-repo");
    fs.mkdirSync(path.join(repo, ".omp", "worktrees"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".omp", "worktrees", "kept.txt"), "tracked\n");
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-qm", "tracked under managed root"]);

    const { reply } = await call(repo);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("worktree_root_tracked");
    // Refusal happens before any copy is attempted.
    expect(fs.readdirSync(path.join(repo, ".omp", "worktrees"))).toEqual(["kept.txt"]);
  });
});
