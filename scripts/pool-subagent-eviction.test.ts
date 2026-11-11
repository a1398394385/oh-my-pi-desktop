// subagentEntriesUnder: deleting/archiving a parent session must sweep the pool entries whose
// transcript lives under the parent's artifacts dir (<session file minus .jsonl>/), and must
// not touch a sibling session that merely shares the path prefix.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/pool-subagent-eviction.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { subagentEntriesUnder } from "../host/state.ts";
import type { PoolEntry } from "../host/state.ts";

const rows: [string, string, boolean][] = [
  ["k-parent", "/proj/parent.jsonl", false],
  ["k-child", "/proj/parent/child.jsonl", true],
  ["k-grandchild", "/proj/parent/child/grand.jsonl", true],
  ["k-sibling", "/proj/parents.jsonl", true],
  ["k-other", "/proj/other/child.jsonl", true],
];
const pool = new Map<string, PoolEntry>(
  rows.map(([key, path, isSubagent]) => [key, { path, isSubagent, previousPaths: [] } as unknown as PoolEntry]),
);

describe("subagentEntriesUnder", () => {
  test("matches the parent's artifacts dir, nested grandchildren included", () => {
    expect(subagentEntriesUnder("/proj/parent.jsonl", pool).map(([k]) => k)).toEqual(["k-child", "k-grandchild"]);
  });

  test("prefix-sharing sibling and unrelated trees are left alone", () => {
    const keys = subagentEntriesUnder("/proj/parent.jsonl", pool).map(([k]) => k);
    expect(keys).not.toContain("k-sibling");
    expect(keys).not.toContain("k-other");
  });

  test("non-jsonl address and missing tree match nothing", () => {
    expect(subagentEntriesUnder("/proj/parent", pool)).toEqual([]);
    expect(subagentEntriesUnder("/proj/missing.jsonl", pool)).toEqual([]);
  });
});
