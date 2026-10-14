// Direct unit assertions for the composer palette filters (A14 acceptance: the
// filterCommands family must be importable and assertable in isolation after
// moving out of components/Composer.tsx).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/composer-filters.test.ts
import { describe, expect, test } from "bun:test";
import { filterCommands, filterSkills, filterSubcommands } from "../ui-src/components/composer/completionFilters";
import { bgTaskCount, subagentCount } from "../ui-src/components/composer/sessionCounts";

const cmd = (name: string, source: string, aliases?: string[]) => ({ name, source, aliases });

describe("filterCommands", () => {
  test("empty/null list yields no candidates", () => {
    expect(filterCommands(null, "")).toEqual([]);
    expect(filterCommands([], "x")).toEqual([]);
  });

  test("empty query returns all sorted by source rank then name", () => {
    const list = [cmd("zeta", "custom"), cmd("alpha", "builtin"), cmd("beta", "skill")];
    expect(filterCommands(list, "").map((c) => c.name)).toEqual(["alpha", "beta", "zeta"]);
  });

  test("prefix matches rank before includes matches", () => {
    const list = [cmd("memory-all", "builtin"), cmd("memory", "builtin"), cmd("readmem", "builtin")];
    expect(filterCommands(list, "mem").map((c) => c.name)).toEqual(["memory", "memory-all", "readmem"]);
  });

  test("aliases participate in matching", () => {
    const list = [cmd("model", "builtin", ["m"])];
    expect(filterCommands(list, "m").map((c) => c.name)).toEqual(["model"]);
  });

  test("result cap is 50", () => {
    const list = Array.from({ length: 60 }, (_, i) => cmd(`cmd${String(i).padStart(2, "0")}`, "builtin"));
    expect(filterCommands(list, "cmd")).toHaveLength(50);
  });
});

describe("filterSkills", () => {
  test("only source==='skill' entries, bare name stripped of the skill: prefix", () => {
    const list = [cmd("skill:translate", "skill"), cmd("memory", "builtin"), cmd("skill:search-web", "skill")];
    expect(filterSkills(list, "").map((c) => c.name)).toEqual(["skill:search-web", "skill:translate"]);
  });

  test("query matches the bare name", () => {
    const list = [cmd("skill:translate", "skill"), cmd("skill:search-web", "skill")];
    expect(filterSkills(list, "search").map((c) => c.name)).toEqual(["skill:search-web"]);
  });
});

describe("filterSubcommands", () => {
  test("prefix match mapped into the CommandItem shape (hint = usage)", () => {
    const subs = [
      { name: "view", description: "View a memory", usage: "/memory view <name>" },
      { name: "write", description: "Write a memory", usage: "/memory write" },
    ];
    expect(filterSubcommands(subs, "vie")).toEqual([
      { name: "view", description: "View a memory", hint: "/memory view <name>" },
    ]);
    expect(filterSubcommands(undefined, "")).toEqual([]);
  });
});

describe("sessionCounts", () => {
  test("bgTaskCount pairs hub start/stop and counts running bash rows", () => {
    const items = [
      { role: "tool", name: "hub", args: { op: "start", name: "server-a" } },
      { role: "tool", name: "bash", running: true },
      { role: "tool", name: "hub", args: { op: "stop", name: "server-a" } },
      { role: "tool", name: "read", running: true }, // non-bg tool: never counts
    ];
    expect(bgTaskCount({ items })).toBe(1);
    expect(bgTaskCount(null)).toBe(0);
  });

  test("subagentCount counts streaming or started entries", () => {
    const subs = new Map([
      ["a", { status: "started" }],
      ["b", { streaming: true }],
      ["c", { status: "completed" }],
    ]);
    expect(subagentCount({ subagents: subs })).toBe(2);
    expect(subagentCount(undefined)).toBe(0);
  });
});
