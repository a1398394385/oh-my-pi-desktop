// Smoke: git worktree RPC domain (host/rpc/worktree.ts) — create → status →
// dirty-remove refusal → force-remove, plus clean auto-removal, slug collision
// suffixing and input validation, all against a throwaway git fixture repo.
// Runs the real handlers against a fake ws (frame capture); no host process is
// spawned, so nothing here can touch live sessions. Profile pinned by
// smoke-profile import (before any host-module import), and the worktree root
// resolves inside the test profile (~/.omp/profiles/omp-desktop-test/agent/wt).
import { smokeEnv, TEST_PROFILE } from "./smoke-profile.ts";
void smokeEnv; // pins OMP_PROFILE/PI_PROFILE for this process at import time

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeHandlers } from "../host/rpc/worktree.ts";

// pi-utils' profile layout puts the worktree root at ~/.omp/profiles/<name>/wt
// (one level above the agent dir smoke-profile's helper names).
const expectedWtRoot = join(homedir(), ".omp", "profiles", TEST_PROFILE, "wt");

// ---- fixture: one temp git repo with an initial commit ----
const repo = mkdtempSync(join(tmpdir(), "omp-wt-smoke-"));
const git = (args: string[], cwd = repo) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
git(["init", "-q"]);
git(["config", "user.email", "smoke@omp.test"]);
git(["config", "user.name", "omp smoke"]);
writeFileSync(join(repo, "base.txt"), "base\n");
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);

// ---- fake ws: capture every reply frame ----
type Reply = Record<string, unknown>;
let captured: Reply[] = [];
const ws = { send: (data: string) => { captured.push(JSON.parse(data) as Reply); } };
async function call(method: string, msg: Reply): Promise<Reply> {
  const before = captured.length;
  await worktreeHandlers[method](ws, { reqId: 1, ...msg });
  if (captured.length !== before + 1) throw new Error(`${method}: expected exactly one reply frame`);
  return captured[captured.length - 1];
}

let failures = 0;
const createdPaths: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else console.log(`ok   ${name}`);
}

try {
  // 1. create (free-text name → slugified)
  const created = await call("worktree_create", { name: "My Feature", baseCwd: repo });
  const createdPath = typeof created.path === "string" ? created.path : "";
  const createdBranch = typeof created.branch === "string" ? created.branch : "";
  check("create ok", created.ok === true, JSON.stringify(created));
  createdPaths.push(createdPath);
  check("create branch", createdBranch === "omp/desktop/my-feature", createdBranch);
  check("create path under profile wt root", createdPath.startsWith(expectedWtRoot + "/desktop-my-feature-"), createdPath);
  check("create worktree usable", createdPath !== "" && git(["rev-parse", "--is-inside-work-tree"], createdPath) && git(["branch", "--show-current"], createdPath));

  // 2. status: clean
  const clean = await call("worktree_status", { path: createdPath });
  check("status exists+repo", clean.exists === true && clean.isRepo === true, JSON.stringify(clean));
  check("status branch", clean.branch === "omp/desktop/my-feature", String(clean.branch));
  check("status not dirty", clean.dirty === false && clean.staged === 0 && clean.unstaged === 0 && clean.untracked === 0, JSON.stringify(clean));

  // 3. dirty → remove refused
  writeFileSync(join(createdPath, "wip.txt"), "uncommitted\n");
  const dirty = await call("worktree_status", { path: createdPath });
  check("status dirty", dirty.dirty === true && dirty.untracked === 1, JSON.stringify(dirty));
  const refused = await call("worktree_remove", { path: createdPath });
  check("dirty remove refused", refused.ok === false && refused.code === "worktree_dirty", JSON.stringify(refused));
  check("dirty remove keeps counts", refused.untracked === 1, JSON.stringify(refused));
  check("refused removal left dir", existsSync(createdPath));

  // 4. force remove
  const forced = await call("worktree_remove", { path: createdPath, force: true });
  check("force remove ok", forced.ok === true, JSON.stringify(forced));
  check("force remove removed dir", !existsSync(createdPath));

  // 5. clean worktree removes without force
  const second = await call("worktree_create", { name: "second", baseCwd: repo });
  const secondPath = typeof second.path === "string" ? second.path : "";
  check("second create ok", second.ok === true, JSON.stringify(second));
  createdPaths.push(secondPath);
  const cleanRm = await call("worktree_remove", { path: secondPath });
  check("clean remove ok", cleanRm.ok === true, JSON.stringify(cleanRm));
  check("clean remove removed dir", secondPath !== "" && !existsSync(secondPath));

  // 6. collision → -2 suffix on branch and path
  const c1 = await call("worktree_create", { name: "coll", baseCwd: repo });
  const c2 = await call("worktree_create", { name: "coll", baseCwd: repo });
  const c2Branch = typeof c2.branch === "string" ? c2.branch : "";
  const c2Path = typeof c2.path === "string" ? c2.path : "";
  check("collision suffix branch", c2Branch === "omp/desktop/coll-2", c2Branch);
  check("collision suffix path", c2Path.includes("desktop-coll-2-"), c2Path);
  check("collision distinct dirs", c1.path !== c2.path);
  createdPaths.push(typeof c1.path === "string" ? c1.path : "");
  createdPaths.push(c2Path);

  // 7. baseRef "default" with no origin → falls back to HEAD, still creates
  const def = await call("worktree_create", { name: "from-default", baseRef: "default", baseCwd: repo });
  check("default baseRef ok (no origin)", def.ok === true, JSON.stringify(def));
  createdPaths.push(typeof def.path === "string" ? def.path : "");

  // 8. validation: bad name / not a repo / not a worktree
  const badName = await call("worktree_create", { name: "!!!", baseCwd: repo });
  check("invalid name rejected", badName.ok === false && badName.code === "invalid_name", JSON.stringify(badName));
  const notRepo = await call("worktree_create", { name: "x", baseCwd: join(tmpdir()) });
  check("not a repo rejected", notRepo.ok === false && notRepo.code === "not_a_repo", JSON.stringify(notRepo));
  const notWt = await call("worktree_remove", { path: join(tmpdir()) });
  check("not a worktree rejected", notWt.ok === false && notWt.code === "not_a_worktree", JSON.stringify(notWt));

  // 9. status of a vanished path
  const gone = await call("worktree_status", { path: join(repo, "does-not-exist") });
  check("status vanished path", gone.ok === true && gone.exists === false && gone.isRepo === false, JSON.stringify(gone));

  console.log(failures === 0 ? "SMOKE OK: worktree RPC chain green" : `SMOKE FAILED: ${failures} failure(s)`);
} finally {
  rmSync(repo, { recursive: true, force: true });
  // Sweep the worktrees still alive at teardown (collision/default cases) so the
  // test profile's wt root stays empty between runs.
  for (const p of createdPaths) if (p) rmSync(p, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
