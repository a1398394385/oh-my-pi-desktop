// subagentEntriesUnder: deleting/archiving a parent session must sweep the pool entries whose
// transcript lives under the parent's artifacts dir (<session file minus .jsonl>/), and must
// not touch a sibling session that merely shares the path prefix.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/pool-subagent-eviction.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { subagentEntriesUnder } from "../host/state.ts";
import type { PoolEntry } from "../host/state.ts";

// The matcher appends path.sep to the parent address, so the fixtures must be built
// with the platform separator — a hardcoded POSIX path matches nothing on Windows.
const proj = path.join(path.sep, "proj");
const parent = path.join(proj, "parent.jsonl");
const rows: [string, string, boolean][] = [
  ["k-parent", parent, false],
  ["k-child", path.join(proj, "parent", "child.jsonl"), true],
  ["k-grandchild", path.join(proj, "parent", "child", "grand.jsonl"), true],
  ["k-sibling", path.join(proj, "parents.jsonl"), true],
  ["k-other", path.join(proj, "other", "child.jsonl"), true],
];
const pool = new Map<string, PoolEntry>(
  rows.map(([key, entryPath, isSubagent]) => [key, { path: entryPath, isSubagent, previousPaths: [] } as unknown as PoolEntry]),
);

describe("subagentEntriesUnder", () => {
  test("matches the parent's artifacts dir, nested grandchildren included", () => {
    expect(subagentEntriesUnder(parent, pool).map(([k]) => k)).toEqual(["k-child", "k-grandchild"]);
  });

  test("prefix-sharing sibling and unrelated trees are left alone", () => {
    const keys = subagentEntriesUnder(parent, pool).map(([k]) => k);
    expect(keys).not.toContain("k-sibling");
    expect(keys).not.toContain("k-other");
  });

  test("non-jsonl address and missing tree match nothing", () => {
    expect(subagentEntriesUnder(path.join(proj, "parent"), pool)).toEqual([]);
    expect(subagentEntriesUnder(path.join(proj, "missing.jsonl"), pool)).toEqual([]);
  });
});
