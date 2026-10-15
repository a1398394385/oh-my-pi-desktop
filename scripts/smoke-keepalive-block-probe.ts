// Cache keepalive block-probing: a turn parked on a pending tool execution
// (subagent task/agent, long build) must keep probing on the cadence, a plainly
// busy turn must hold its deadline for agent_end, a permission-dialog wait must
// stay on its own switch (the approval gate runs inside the tool execution, so
// such a wait also reports a pending tool), and the idle path must stay
// unchanged. Drives the real extension's event chain with a mocked endpoint.
// The mocked endpoint answers 500 on purpose: a successful probe appends to the
// global ~/.omp/cache-keepalive/probe-log.jsonl (deliberately not
// profile-scoped), and these assertions only need the request to leave.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-keepalive-block-probe.ts
import type { KeepaliveContext, KeepalivePi } from "../host/keepalive.ts";

process.env.OMP_PROFILE = "omp-desktop-test";
// Legit dynamic imports: the host modules resolve the profile (and the keepalive
// section of omp-desktop.json) at import time, so they must load after the env
// switch above.
const { applyProfile } = await import("../host/profile.ts");
await applyProfile("omp-desktop-test");
const { writeKeepaliveEnabled, writeKeepaliveConfig } = await import("../host/keepalive-config.ts");
writeKeepaliveEnabled(true);
writeKeepaliveConfig({ targets: ["mock/tool-model"], intervalMs: 30000, mode: "default" });
const { createKeepaliveExtension } = await import("../host/keepalive.ts");

function ok(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));
const posted: string[] = [];
// Signature cast: the double only needs fetch's (url, init) head.
globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
  let model = "?";
  try {
    model = String((JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "?");
  } catch {}
  posted.push(model);
  return new Response("probe rejected by the smoke endpoint", { status: 500 });
}) as unknown as typeof fetch;
// Compress the real 30s cadence so a probe lands inside this script's lifetime.
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(fn, Math.min(Number(ms) || 0, 20), ...rest)) as unknown as typeof setTimeout;

const model = {
  provider: "mock",
  id: "tool-model",
  baseUrl: "https://mock.local/v1",
  api: "openai-completions",
  cost: {},
};
const payload = { model: "tool-model", messages: [{ role: "user", content: "hello" }], stream: true };

interface Block {
  approval: boolean;
  ask: boolean;
  tool: boolean;
}
async function scenario(block: Block, idle: boolean): Promise<() => Promise<void>> {
  const handlers = new Map<string, unknown>();
  // Narrow-then-call: the map holds heterogeneous hook signatures.
  const emit = async (name: string, ...args: unknown[]): Promise<void> => {
    const handler = handlers.get(name);
    if (typeof handler !== "function") return;
    await (handler as (...a: unknown[]) => unknown)(...args);
  };
  const ctx = {
    // onTick's target check re-reads the session model while
    // before_provider_request uses the request-level one — both carry the target.
    model,
    isIdle: () => idle,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
  } satisfies KeepaliveContext;
  // Double cast: KeepalivePi.on's overload set cannot be satisfied structurally.
  const pi = { on: (name: string, handler: unknown) => void handlers.set(name, handler) } as unknown as KeepalivePi;
  createKeepaliveExtension({ isWanted: () => true, blockState: () => block })(pi);
  await emit("session_start", {}, ctx);
  await emit("before_provider_request", { payload }, { ...ctx, model });
  return () => emit("session_shutdown", {}, ctx);
}

/** Probes fired while one scenario runs. */
async function calls(block: Block, idle: boolean): Promise<number> {
  const mark = posted.length;
  const stop = await scenario(block, idle);
  await sleep(300);
  await stop();
  return posted.length - mark;
}

const toolBusy = await calls({ approval: false, ask: false, tool: true }, false);
const plainBusy = await calls({ approval: false, ask: false, tool: false }, false);
const idlePath = await calls({ approval: false, ask: false, tool: false }, true);
writeKeepaliveConfig({ probeDuringApproval: false });
const approvalOff = await calls({ approval: true, ask: false, tool: true }, false);
writeKeepaliveConfig({ probeDuringApproval: true });
const approvalOn = await calls({ approval: true, ask: false, tool: true }, false);

ok(toolBusy > 0, `probes while a tool call parks the turn (calls=${toolBusy})`);
ok(plainBusy === 0, `holds the deadline while plainly busy (calls=${plainBusy})`);
ok(idlePath > 0, `probes on the idle path as before (calls=${idlePath})`);
ok(approvalOff === 0, `a dialog wait stays off while its switch is off (calls=${approvalOff})`);
ok(approvalOn > 0, `a dialog wait probes once its switch is on (calls=${approvalOn})`);
ok(posted.every((m) => m === "tool-model"), `probe requests carry the captured model (${posted.join(",")})`);

globalThis.setTimeout = realSetTimeout;
console.log("smoke-keepalive-block-probe: all assertions passed");
process.exit(0);
