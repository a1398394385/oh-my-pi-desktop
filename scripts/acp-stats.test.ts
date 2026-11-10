// ACP compaction stats rows (host/acp-stats.ts): the per-compression figures the
// usage dashboard's ACP section renders. Pins the two derivations that are easy
// to get wrong — the round's extra cost (the status/compress calls plus the
// request each one triggers, deduped when one message carries both) and the
// saving multiplier (requests after the fold) at the model's cache-read rate.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/acp-stats.test.ts
import { describe, expect, test } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-catalog/types";
import { parseAcpStatsJournal } from "../host/acp-stats.ts";
import { AcpRuntimeState } from "../host/acp-runtime.ts";
import type { AcpSummaryData } from "../host/acp-persist.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { priceUsage, type UsagePricer } from "../host/catalog-cost.ts";

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
    expect(row.extraInput).toBe(300);
    expect(row.extraOutput).toBe(30);
    expect(row.extraCacheRead).toBe(1000);
    expect(row.extraCacheWrite).toBe(0);
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
    expect(rows[0].extraInput).toBe(200);
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

  test("a zero recorded cost is repriced from the supplied catalog rate", () => {
    const free = assistant("m1", ["context_status"], { totalTokens: 1000, costTotal: 0 });
    const atListRate: UsagePricer = (_provider, _model, usage) => ({
      input: usage.input / 1000,
      output: usage.output / 1000,
      cacheRead: 0,
      cacheWrite: 0,
      total: (usage.input + usage.output) / 1000,
    });
    const rows = parseAcpStatsJournal(journal(free, summary("s-5", { tokensBefore: 10, tokensAfter: 4 })), atListRate);
    // 100 input + 10 output tokens at 1e-3 each.
    expect(rows[0].extraCost).toBeCloseTo(0.11, 10);
  });
});

describe("runtime telemetry recording", () => {
  // The pull and the compress it feeds never share a request: the model sees the
  // tool result, then answers with compress_context. A per-request reset of the
  // count left every journal's statusTokens null (2026-11-09).
  test("statusTokens survives the request boundary between pull and compress", async () => {
    const entries: SessionEntry[] = [];
    const view: AgentMessage[] = [];
    for (const id of ["e0", "e1", "e2"]) {
      const message = { role: "user", content: "x".repeat(100), timestamp: 1 } as never as AgentMessage;
      entries.push({ type: "message", id, message } as never as SessionEntry);
      view.push(message);
    }
    const writes: AcpSummaryData[] = [];
    const state = new AcpRuntimeState({
      countTokens: (t: string) => t.length,
      countMessages: () => 0,
      sink: { appendCustomEntry: (_type: string, data: AcpSummaryData) => (writes.push(data), "s1") },
      getEntries: () => entries,
      params: { minCompress: 0 },
    });
    state.projectView(view);
    const pulled = state.status();
    if (!pulled.ok) throw new Error(pulled.error);
    state.projectView(view); // next request: the compress call arrives here

    const out = await state.compress({ summary: "s" });
    expect(out.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].meta.statusTokens).toBe(pulled.text.length);
  });
});

describe("catalog pricing fallback", () => {
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number): Usage => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  test("a subscription 0 card is priced at the same id's list rate", () => {
    // zhipu-coding-plan carries an explicit 0 card; the bundled `zai` row prices
    // the model at list rate, which is what an API-equivalent estimate reports.
    const cost = priceUsage("zhipu-coding-plan", "glm-5.3", usage(1_000_000, 0, 0, 0), 0);
    expect(cost?.total ?? 0).toBeGreaterThan(0);
  });

  test("a model no bundled row prices stays at zero", () => {
    expect(priceUsage("kimi-code", "k3.1-pro", usage(1000, 100, 0, 0), 0)).toBeNull();
  });
});
