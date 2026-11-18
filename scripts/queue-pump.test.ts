// Queue ordering contract (host/queue.ts pumpFollowUp): the base drains its own
// followUp queue and pauses the run (agent_end isTerminal:false), so the queue
// can sit EMPTY while messages stay parked. Two observed failures came from
// that window: a fresh prompt appended ahead of the parked messages, and a
// parked message nobody released never ran at all.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/queue-pump.test.ts --pool=forks --poolOptions.forks.singleFork
import { describe, expect, test } from "bun:test";
import { pumpFollowUp, parkFollowUpTail } from "../host/queue.ts";
import type { PoolEntry } from "../host/state.ts";

const user = (text: string) => ({ role: "user", content: text });
const textsOf = (list: unknown[]) => list.map((m) => (m as { content?: string }).content);

function harness(base: unknown[], parked: unknown[], streaming = false) {
  const calls = { continue: 0 };
  const agent = {
    peekFollowUpQueue: () => base,
    replaceQueue: (_queue: string, messages: unknown[]) => {
      base.splice(0, base.length, ...messages);
    },
    continue: () => {
      calls.continue++;
      return Promise.resolve();
    },
    waitForIdle: () => Promise.resolve(),
  };
  const entry = {
    parkedFollowUp: parked,
    session: { isStreaming: streaming, agent },
  } as unknown as PoolEntry;
  return { entry, base, parked, calls };
}

describe("pumpFollowUp", () => {
  test("hands the parked head to an empty base queue", () => {
    const { entry, base, calls } = harness([], [user("A")]);
    pumpFollowUp(entry);
    expect(textsOf(base)).toEqual(["A"]);
    expect(entry.parkedFollowUp).toEqual([]);
    expect(calls.continue).toBe(0); // delivery only: driving belongs to the caller
  });

  test("leaves a base queue that already holds an earlier message alone", () => {
    const { entry, base, calls } = harness([user("B")], [user("A")]);
    pumpFollowUp(entry);
    expect(textsOf(base)).toEqual(["B"]);
    expect(entry.parkedFollowUp.length).toBe(1);
    expect(calls.continue).toBe(0);
  });

  test("releases one message per pump, keeping FIFO across the parking lot", () => {
    const { entry, base } = harness([], [user("A"), user("C")]);
    pumpFollowUp(entry);
    expect(textsOf(base)).toEqual(["A"]);
    expect(textsOf(entry.parkedFollowUp)).toEqual(["C"]);
    pumpFollowUp(entry); // base holds A now: no second delivery
    expect(textsOf(base)).toEqual(["A"]);
    expect(textsOf(entry.parkedFollowUp)).toEqual(["C"]);
  });

  test("a prompt queued while parked messages wait lands behind them", () => {
    // Streaming run: the base drained B and paused, A is still parked
    const { entry, base } = harness([], [user("A")], true);
    pumpFollowUp(entry); // what handlePrompt does before enqueueing (see rpc/prompt.ts)
    base.push(user("C")); // the base appends the fresh prompt to its own queue
    parkFollowUpTail(entry);
    expect(textsOf(base)).toEqual(["A"]);
    expect(textsOf(entry.parkedFollowUp)).toEqual(["C"]);
  });
});