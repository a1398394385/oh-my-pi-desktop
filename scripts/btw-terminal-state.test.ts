// /btw terminal states: a disk record left `running` by a crashed host is recovered by the
// base store as `interrupted`, so promote is not blocked forever and the read path never
// reports a stale `running`. The UI also has to tell the terminal states apart instead of
// rendering every answer-less turn as "never answered".
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/btw-terminal-state.test.ts
import "./dom-stub";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBtwLatestTurn } from "../host/bootstrap.ts";
import { collectBtwHistory } from "../host/btw.ts";
import { sessions, type PoolEntry } from "../host/state.ts";

// ws.ts binds invoke from window.__TAURI__ at module scope, so the stub must exist before the
// UI module graph loads.
(globalThis.window as unknown as { __TAURI__: unknown }).__TAURI__ = {
  core: { invoke: async () => {} },
};
// chat/parts.tsx constructs a ResizeObserver at module scope.
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const root = await mkdtemp(path.join(tmpdir(), "omp-btw-state-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Status = "running" | "complete" | "cancelled" | "error" | "interrupted";

interface DiskTurn {
  question: string;
  answer: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
}

interface DiskRecord extends DiskTurn {
  id: string;
  leafId: null;
  followUps?: DiskTurn[];
}

function diskRecord(id: string, status: Status, followUps?: DiskTurn[]): DiskRecord {
  const base = { id, leafId: null, question: `q-${id}`, answer: "", status, createdAt: 1, updatedAt: 2 } as const;
  return followUps ? { ...base, followUps } : base;
}

function diskTurn(status: Status): DiskTurn {
  return { question: "follow-up", answer: "", status, createdAt: 3, updatedAt: 4 };
}

async function seed(scope: string, records: DiskRecord[]): Promise<string> {
  const artifacts = path.join(root, scope);
  const dir = path.join(artifacts, "btw-history", "sessions", scope);
  await mkdir(dir, { recursive: true });
  for (const record of records) {
    await writeFile(path.join(dir, `entry-${record.id}.json`), `${JSON.stringify(record)}\n`);
  }
  // Only the manager methods the btw read path touches; a full PoolEntry would drag the
  // whole session runtime in for no coverage.
  sessions.set(scope, {
    session: {
      model: {},
      sessionManager: {
        getArtifactsDir: () => artifacts,
        getSessionId: () => scope,
        getLeafId: () => null,
      },
    },
  } as unknown as PoolEntry);
  return scope;
}

describe("btw read path", () => {
  test("a disk record stuck in running surfaces as interrupted, so promote is not blocked", async () => {
    const scope = await seed("crashed", [
      diskRecord("t-crash", "running"),
      diskRecord("t-followup", "complete", [diskTurn("running")]),
    ]);
    const byId = new Map((await collectBtwHistory(scope)).map((r) => [r.id, r]));
    expect(byId.get("t-crash")?.status).toBe("interrupted");
    // A running follow-up is the latest turn, so it is what promote gates on.
    const followUp = byId.get("t-followup");
    if (!followUp) throw new Error("t-followup missing from read path");
    expect(followUp.followUps?.[0]?.status).toBe("interrupted");
    expect(getBtwLatestTurn(followUp).status).not.toBe("running");
  });

  test("terminal states round-trip unchanged", async () => {
    const scope = await seed("terminal", [
      diskRecord("t-cancel", "cancelled"),
      diskRecord("t-interrupt", "interrupted"),
      diskRecord("t-error", "error"),
    ]);
    const byId = new Map((await collectBtwHistory(scope)).map((r) => [r.id, r.status]));
    expect(byId.get("t-cancel")).toBe("cancelled");
    expect(byId.get("t-interrupt")).toBe("interrupted");
    expect(byId.get("t-error")).toBe("error");
  });
});

describe("btw turn status copy", () => {
  test("every terminal state has its own placeholder", async () => {
    // Dynamic on purpose: the stubs above must be installed before this module graph loads.
    const { initI18n } = await import("../ui-src/i18n");
    initI18n("zh-CN");
    const { turnStatusKey } = await import("../ui-src/components/main/right/BtwPage.tsx");
    expect(turnStatusKey({ status: "running" })).toBe("right.btwWaiting");
    expect(turnStatusKey({ status: "cancelled" })).toBe("right.btwCancelled");
    expect(turnStatusKey({ status: "interrupted" })).toBe("right.btwInterrupted");
    // A turn that finished with nothing to say, or failed outright, stays "no answer";
    // the error text renders below it.
    expect(turnStatusKey({ status: "complete" })).toBe("right.btwEmptyAnswer");
    expect(turnStatusKey({ status: "error" })).toBe("right.btwEmptyAnswer");
  });
});
