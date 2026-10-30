// Subagent failure rows: a child run that dies on a provider/request error ends with an
// assistant message whose only failure payload is `errorMessage` (the shape BUG-034 fixed for
// the main chat). The subagent translate layer had no message_end branch at all, so the roster
// said "failed" with no cause and the child transcript's reason never reached the UI. Both
// delivery paths are covered here: the live event stream and the cold-load history replay.
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/subagent-error-row.test.ts
import "./dom-stub";
import { afterAll, describe, expect, test } from "bun:test";
import { useAppStore } from "../ui-src/store";
import { frameHandlers } from "../ui-src/store/wsHandlers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translateSubagentEvent } from "../host/translate";
import { replaySubagentHistory } from "../host/subagent-view";

describe("subagent message_end", () => {
  test("a failed child message becomes an error row", () => {
    const ui = translateSubagentEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 400: invalid model" },
    });
    expect(ui).toEqual({ kind: "error", text: "HTTP 400: invalid model" });
  });

  test("a healthy child message yields no row (text arrives as deltas)", () => {
    expect(translateSubagentEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })).toBeNull();
    // An error stopReason without a payload has nothing to show — never invent a blank row
    expect(translateSubagentEvent({ type: "message_end", message: { role: "assistant", stopReason: "error" } })).toBeNull();
    expect(translateSubagentEvent({ type: "message_end", message: { role: "toolResult" } })).toBeNull();
  });
});

describe("subagent history replay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-error-"));
  const sessionFile = path.join(dir, "parent.jsonl");
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a failed child's replayed lifecycle frame carries the reason", () => {
    fs.writeFileSync(sessionFile, "");
    const artDir = path.join(dir, "parent");
    fs.mkdirSync(artDir, { recursive: true });
    const childFile = path.join(artDir, "Verifier.jsonl");
    const lines = [
      { type: "session", timestamp: "2026-10-30T00:00:00.000Z", parentSession: sessionFile },
      { type: "message", timestamp: "2026-10-30T00:00:01.000Z", message: { role: "user", content: "check it" } },
      { type: "message", timestamp: "2026-10-30T00:00:02.000Z", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited (429)" } },
    ];
    fs.writeFileSync(childFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // A file still being written belongs to a live subagent and is skipped: age it past the window
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(childFile, old, old);

    const frames: Array<Record<string, unknown>> = [];
    replaySubagentHistory({ send: (raw: string) => frames.push(JSON.parse(raw)) }, sessionFile, "sess-1", false);
    const lifecycle = frames.find((f) => f.type === "subagent_lifecycle");
    expect(lifecycle?.status).toBe("failed");
    expect(lifecycle?.error).toBe("rate limited (429)");
    expect(lifecycle?.result).toBeUndefined(); // no text was produced
  });
});

// Frontend landing: the detail page renders sub.error straight off this state, so the store is
// the whole render contract (no React render tests exist in this repo — same as the other
// subagent store assertions).
describe("subagent error state", () => {
  test("error frames and terminal lifecycle frames land on the roster row", () => {
    const SLOT = "/tmp/replay/sub.jsonl";
    const sid = "sess-sub-1";
    useAppStore.setState({
      ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
      openSessions: new Map([
        [
          SLOT,
          {
            sessionId: sid,
            path: SLOT,
            items: [],
            assistantDraft: "",
            streaming: false,
            subagents: new Map([
              ["sub-1", { agent: "Verifier", description: "", status: "started", text: "", tools: [], streaming: true }],
            ]),
          },
        ],
      ]) as never,
      activePath: SLOT,
    });
    const frame = frameHandlers as Record<string, (msg: Record<string, unknown>) => void>;
    frame.subagent_event({ type: "subagent_event", sessionId: sid, subagentId: "sub-1", kind: "error", text: "HTTP 429" });
    expect(useAppStore.getState().openSessions.get(SLOT)!.subagents.get("sub-1")!.error).toBe("HTTP 429");
    // Terminal lifecycle carries the same reason on the cold-load path
    frame.subagent_lifecycle({ type: "subagent_lifecycle", sessionId: sid, subagentId: "sub-1", agent: "Verifier", description: "", status: "failed", error: "rate limited" });
    expect(useAppStore.getState().openSessions.get(SLOT)!.subagents.get("sub-1")!.error).toBe("rate limited");
    // A wake re-run over the same id must not keep the previous run's failure text
    frame.subagent_lifecycle({ type: "subagent_lifecycle", sessionId: sid, subagentId: "sub-1", agent: "Verifier", description: "", status: "started" });
    expect(useAppStore.getState().openSessions.get(SLOT)!.subagents.get("sub-1")!.error).toBeUndefined();
  });
});
