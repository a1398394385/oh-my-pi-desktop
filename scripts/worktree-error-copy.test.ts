// Repro/regression for the worktree failure-code → copy mapping: every code the
// host can emit on a failed create/status/remove must surface its own localized
// reason, never the dialogs' generic "creation failed" label. The host side is
// driven through the real handlers with a throwaway git fixture; the UI side is
// the dialogs' shared worktreeErrorText() against the real en/zh tables.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/worktree-error-copy.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeHandlers } from "../host/rpc/worktree.ts";
import { worktreeErrorText } from "../ui-src/components/main/sidebar/WorktreeCreateDialog.tsx";
import { worktreeEn } from "../ui-src/i18n/locales/ui/worktree.en.ts";
import { worktreeZhCn } from "../ui-src/i18n/locales/ui/worktree.zh.ts";

/** Contract from the audit: every failure code the host can emit on these RPCs. */
const FAILURE_CODES = [
  "invalid_name",
  "missing_base",
  "not_a_repo",
  "worktree_create_failed",
  "missing_path",
  "status_failed",
  "not_a_worktree",
  "worktree_dirty",
  "worktree_remove_failed",
] as const;

function git(args: string[], cwd: string): boolean {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

function initRepo(dir: string, commit: boolean): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@omp.test"], dir);
  git(["config", "user.name", "omp test"], dir);
  if (commit) {
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "init"], dir);
  }
}

// Lookup with a throw on missing/empty — a typo'd table key must fail the test,
// not silently match the other side of the assertion.
function translator(table: Record<string, unknown>) {
  return (key: string): string => {
    const path = key.startsWith("worktree.") ? key.slice("worktree.".length) : key;
    let node: unknown = table;
    for (const part of path.split(".")) {
      node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined;
    }
    if (typeof node !== "string" || !node) throw new Error(`missing i18n key ${key}`);
    return node;
  };
}

async function call(method: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frames: Record<string, unknown>[] = [];
  const ws = { send: (data: string) => void frames.push(JSON.parse(data) as Record<string, unknown>) };
  await worktreeHandlers[method](ws, { reqId: 1, ...msg });
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

describe("worktree failure codes", () => {
  test("each failing branch replies with its distinct code", async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-wt-copy-"));
    const repo = join(root, "repo");
    const unborn = join(root, "unborn");
    initRepo(repo, true);
    initRepo(unborn, false);
    const created: string[] = [];
    try {
      const codes: string[] = [];
      const record = async (method: string, msg: Record<string, unknown>) => {
        const reply = await call(method, msg);
        expect(reply.ok).toBe(false);
        codes.push(String(reply.code));
      };

      await record("worktree_create", { name: "!!!", baseCwd: repo });
      await record("worktree_create", { name: "x" });
      await record("worktree_create", { name: "x", baseCwd: tmpdir() });
      await record("worktree_create", { name: "x", baseCwd: unborn });
      await record("worktree_status", { path: "" });
      await record("worktree_remove", { path: "" });
      await record("worktree_remove", { path: tmpdir() });

      const made = await call("worktree_create", { name: "copy-dirty", baseCwd: repo });
      const madePath = String(made.path);
      created.push(madePath);
      writeFileSync(join(madePath, "wip.txt"), "uncommitted\n");
      await record("worktree_remove", { path: madePath });
      git(["worktree", "lock", madePath], repo);
      await record("worktree_remove", { path: madePath, force: true });

      expect(new Set(codes)).toEqual(new Set(FAILURE_CODES.filter((c) => c !== "status_failed")));
    } finally {
      for (const p of created) rmSync(p, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every code maps to its own copy in both locales", () => {
    for (const [locale, table] of [["en", worktreeEn], ["zh", worktreeZhCn]] as const) {
      const t = translator(table as unknown as Record<string, unknown>);
      for (const code of FAILURE_CODES) {
        const text = worktreeErrorText(t, code, undefined, "worktree.create.failed");
        expect(text, `${locale} ${code}`).not.toBe(t("worktree.create.failed"));
        expect(text, `${locale} ${code}`).toBe(t(`worktree.code.${code}`));
      }
    }
  });
});
