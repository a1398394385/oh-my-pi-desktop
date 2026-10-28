// ACP compaction stats rows (host/acp-stats.ts): the per-compression figures the
// usage dashboard's ACP section renders. Pins the two derivations that are easy
// to get wrong — the round's extra cost (the status/compress calls plus the
// request each one triggers, deduped when one message carries both) and the
// saving multiplier (requests after the fold) at the model's cache-read rate.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/acp-stats.test.ts
import { describe, expect, test } from "bun:test";
import { parseAcpStatsJournal } from "../host/acp-stats.ts";

type Line = Record<string, unknown>;

function assistant(id: string, toolNames: string[], usage: Partial<Record<string, number>>, model = "test/model"): Line {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      model,
      content: [
        { type: "text", text: "ok" },
        ...toolNames.map((name, i) => ({ type: "toolCall", id: `${id}-call-${i}`, name, arguments: {} })),
      ],
      usage: {
        input: usage.input ?? 100,
        output: usage.output ?? 10,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: 0,
        totalTokens: usage.totalTokens ?? 110,
        cost: {
          input: usage.costInput ?? 0,
          output: usage.costOutput ?? 0,
          cacheRead: usage.costCacheRead ?? 0,
          cacheWrite: 0,
          total: usage.costTotal ?? 0,
        },
      },
    },
  };
}

function toolResult(id: string, toolName: string): Line {
  return {
    type: "message",
    id,
    message: { role: "toolResult", toolCallId: `${id}-call`, toolName, content: [{ type: "text", text: "done" }] },
  };
}

function summary(id: string, meta: Record<string, unknown>): Line {
  return {
    type: "custom",
    id,
    customType: "acpSummary",
    data: {
      summary: "folded work",
      index: [{ id: "block-1", tokens: 1000, intent: "block one" }],
      meta: { createdAt: 1_760_000_000_000, depth: 0, method: "normal", keepIds: [], supersedes: [], ...meta },
    },
  };
}

const journal = (...lines: Line[]): string =>
  [
    { type: "session", id: "s1", version: 3, timestamp: "2026-10-22T00:00:00.000Z", cwd: "/repo/demo" },
    ...lines,
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");

describe("parseAcpStatsJournal", () => {
  const status = assistant("m1", ["context_status"], { totalTokens: 1000, costTotal: 0.01 });
  const compress = assistant("m2", ["compress_context"], {
    totalTokens: 2000,
    costTotal: 0.02,
    // cache-read rate of this call: 0.002 cost / 1000 tokens = 2e-6 per token
    cacheRead: 1000,
    costCacheRead: 0.002,
  });
  const afterCompress = assistant("m4", ["read"], { totalTokens: 3000, costTotal: 0.03 });

  test("extra cost covers the status/compress calls and the request each triggers", () => {
    const rows = parseAcpStatsJournal(
      journal(
        status,
        toolResult("r1", "context_status"),
        compress,
        summary("s-1", { tokensBefore: 100_000, tokensAfter: 20_000, summaryTokens: 500, statusTokens: 300, hints: 2 }),
        toolResult("r2", "compress_context"),
        afterCompress,
      ),
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe("s-1");
    expect(row.cwd).toBe("/repo/demo");
    expect(row.model).toBe("test/model");
    expect(row.compressedTokens).toBe(80_000);
    expect(row.activeTokensAfter).toBe(20_000);
    expect(row.summaryTokens).toBe(500);
    expect(row.statusTokens).toBe(300);
    expect(row.hints).toBe(2);
    // status (m1) + next request (m2) + compress (m2, deduped) + next request (m4)
    expect(row.extraTokens).toBe(1000 + 2000 + 3000);
    expect(row.extraCost).toBeCloseTo(0.01 + 0.02 + 0.03, 10);
    // One request after the fold; saving priced at the compress call's cache-read rate.
    expect(row.requestsAfter).toBe(1);
    expect(row.savedTokens).toBe(80_000);
    expect(row.savedCost).toBeCloseTo(80_000 * 2e-6, 10);
  });

  test("one message carrying both calls is billed once", () => {
    const both = assistant("m1", ["context_status", "compress_context"], { totalTokens: 1000, costTotal: 0.01 });
    const rows = parseAcpStatsJournal(
      journal(both, summary("s-2", { tokensBefore: 50, tokensAfter: 40 }), afterCompress),
    );
    expect(rows[0].extraTokens).toBe(1000 + 3000);
    expect(rows[0].extraCost).toBeCloseTo(0.04, 10);
  });

  test("pre-telemetry journals report unknown instead of zero", () => {
    const rows = parseAcpStatsJournal(journal(compress, summary("s-3", { tokensBefore: 10, tokensAfter: 4 })));
    expect(rows[0].summaryTokens).toBeNull();
    expect(rows[0].statusTokens).toBeNull();
    expect(rows[0].hints).toBeNull();
    expect(rows[0].requestsAfter).toBe(0);
    expect(rows[0].savedTokens).toBe(0);
  });

  test("torn tail lines and non-ACP lines are ignored", () => {
    const text = `${journal(summary("s-4", { tokensBefore: 10, tokensAfter: 4 }))}\n{"type":"message","id":"torn"`;
    expect(parseAcpStatsJournal(text).map((r) => r.id)).toEqual(["s-4"]);
  });
});
