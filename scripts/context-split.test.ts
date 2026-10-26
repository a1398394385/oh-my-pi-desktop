// Context-card split of systemContextTokens: the memory row must capture every
// shape a memory backend injects — hindsight/mnemopi tagged <memories>/<mental_models>
// blocks, sharpshooter's decision block, and the read-path "# Memory Guidance"
// block — while repo rules split out independently and functional prose
// (Auto-Learn guidance, "# Memory" header) stays in "Other" (i.e. out of memoryTokens).
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/context-split.test.ts
import { describe, expect, test } from "bun:test";
import { splitSystemContextRegions } from "../host/rpc/limits.ts";
import type { PoolEntry } from "../host/state.ts";

const fakeSession = (blocks: string[]): PoolEntry["session"] =>
  ({ systemPrompt: blocks, model: "zhipu-coding-plan/glm-4.6" }) as unknown as PoolEntry["session"];

describe("splitSystemContextRegions memory shapes", () => {
  test("hindsight <memories>/<mental_models> blocks count as memory", () => {
    const block1 = [
      "# Memory",
      "This agent has long-term memory.",
      "<memories>\nRecalled fact: profile isolation is mandatory.\n</memories>",
      "<mental_models>\n# Project Conventions\nuses bun run check as the merge gate.\n</mental_models>",
      "## Auto-Learn (experimental)",
      "`manage_skill`: build reusable managed-skill library.",
    ].join("\n");
    const { memoryTokens } = splitSystemContextRegions(fakeSession(["base prompt", block1]));
    expect(memoryTokens).toBeGreaterThan(0);
  });

  test("multiple tagged blocks per block accumulate", () => {
    const block1 = [
      "<memories>\nfirst recall\n</memories>",
      "<memories>\nsecond recall\n</memories>",
      "<mental_models>\nmodels\n</mental_models>",
    ].join("\n");
    const single = splitSystemContextRegions(fakeSession(["p", "<memories>\nfirst recall\n</memories>"]));
    const triple = splitSystemContextRegions(fakeSession(["p", block1]));
    expect(triple.memoryTokens).toBeGreaterThan(single.memoryTokens);
  });

  test("read-path # Memory Guidance block still counts (no tagged blocks present)", () => {
    const block1 = [
      "# Memory Guidance\nRoot: memory://root\nRules:\n1. Read memory_summary.md first.",
      "## Auto-Learn (experimental)\nguidance",
    ].join("\n");
    const { memoryTokens } = splitSystemContextRegions(fakeSession(["p", block1]));
    expect(memoryTokens).toBeGreaterThan(0);
  });

  test("prompt with neither shape yields zero memory, repo rules unaffected", () => {
    const block1 = "<repo-rules>\nAGENTS.md content\n</repo-rules>\n## MCP Tool Routes\n- probe → `xd://mcp__probe`";
    const split = splitSystemContextRegions(fakeSession(["p", block1]));
    expect(split.memoryTokens).toBe(0);
    expect(split.repoRulesTokens).toBeGreaterThan(0);
  });
});

describe("splitSystemContextRegions sharpshooter", () => {
  test("decision block counts as memory, bounded at the append pipeline's next heading", () => {
    const block1 = [
      "Project decision memory (sharpshooter). These are friction-earned decisions; follow them unless the user overrides.",
      "## architecture\n\nHost owns the session pool.",
      "## product\n\nRemote control is read-only.",
      "## Auto-Learn (experimental)",
      "`manage_skill`: build reusable managed-skill library.",
      "## MCP Tool Routes\n\n- probe → `xd://mcp__probe`",
    ].join("\n");
    const split = splitSystemContextRegions(fakeSession(["p", block1]));
    expect(split.memoryTokens).toBeGreaterThan(0);
    // Bound check: with the follow-up headings removed the block ends after the
    // decision content, so the two must price identically (the boundary cut wins
    // over running to block end when the headings are present).
    const onlyMemory = splitSystemContextRegions(fakeSession(["p", block1.split("\n## Auto-Learn")[0]]));
    expect(split.memoryTokens).toBe(onlyMemory.memoryTokens);
  });

  test("block without the sharpshooter heading yields zero memory", () => {
    const split = splitSystemContextRegions(fakeSession(["p", "## Auto-Learn (experimental)\nguidance"]));
    expect(split.memoryTokens).toBe(0);
  });
});
