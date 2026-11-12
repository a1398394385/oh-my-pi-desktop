// Repro/regression for the "MCP connection status" vocabulary audit (B5):
// 1. dotState() used to fall through unknown / not-yet-probed states into the green
//    "ready" branch — an unprobed server looked connected.
// 2. The store widened the mcp_server_tested status to `string`, so the frame union was lost
//    at the store boundary. That half is compile-time: the `narrowStatus` assertion below fails
//    `tsc` while the field is widened and passes once it keeps the frame's "ok" | "error".
// Run: OMP_PROFILE=omp-desktop-test bun test --pool=forks --poolOptions.forks.singleFork scripts/mcp-status-vocab.test.ts
import "./dom-stub";
import { describe, expect, test } from "bun:test";
import { useAppStore, type AppStore } from "../ui-src/store";
import { dispatchFrame } from "../ui-src/store/wsHandlers";
import { dotState } from "../ui-src/components/settings/pages/McpPage.tsx";
import type { AgentAssetsPayload, HostFrame, McpServerTestedFrame } from "../ui-src/types/frames";

// Compile-time repro (see header): `string extends "ok" | "error"` is false, so assigning `true`
// fails until the store field references the frame's status union.
type StoreTestStatus = AppStore["mcpTestResults"][string]["status"];
const narrowStatus: StoreTestStatus extends McpServerTestedFrame["status"] ? true : false = true;

const NAME = "codegraph";

function seedServer(status: AgentAssetsPayload["mcp"]["servers"][number]["status"]): void {
  useAppStore.setState({
    agentAssets: {
      mcp: {
        servers: [{ name: NAME, enabled: true, status, scope: "profile" }],
        scopes: [],
        userMcpPath: "/tmp/mcp.json",
        global: { path: "/tmp/mcp.json", servers: [] },
        profile: { path: "/tmp/mcp.json", servers: [] },
        projects: [],
      },
    } as unknown as AgentAssetsPayload,
  });
}

function rowStatus(): string | undefined {
  return useAppStore.getState().agentAssets?.mcp.servers.find((s) => s.name === NAME)?.status;
}

describe("MCP status dot tells unknown apart from connected", () => {
  test("unknown / not-yet-probed is never the green 'ok' dot", () => {
    expect(narrowStatus).toBe(true); // keeps the compile-time assertion evaluated at runtime too
    expect(dotState({ enabled: true, status: "unknown" }).cls).not.toBe("ok");
    expect(dotState({ enabled: true }).cls).not.toBe("ok");
  });

  test("confirmed states keep their dot: connected green, error red, disabled hidden", () => {
    expect(dotState({ enabled: true, status: "connected" }).cls).toBe("ok");
    expect(dotState({ enabled: true, status: "error" }).cls).toBe("err");
    expect(dotState({ enabled: false, status: "disabled" }).cls).toBe("off");
  });
});

describe("mcp_server_tested keeps the frame's own status", () => {
  test("probe success lands status 'ok' and a connected row", () => {
    seedServer("unknown");
    dispatchFrame({ type: "mcp_server_tested", name: NAME, status: "ok" } as unknown as HostFrame);
    const result = useAppStore.getState().mcpTestResults[NAME];
    expect(result.status).toBe("ok");
    expect(typeof result.ts).toBe("number");
    expect(rowStatus()).toBe("connected");
  });

  test("probe failure lands status 'error' and an error row", () => {
    seedServer("unknown");
    dispatchFrame({ type: "mcp_server_tested", name: NAME, status: "error", error: "boom" } as unknown as HostFrame);
    expect(useAppStore.getState().mcpTestResults[NAME]).toMatchObject({ status: "error", error: "boom" });
    expect(rowStatus()).toBe("error");
  });
});
