// Live `write` body, end to end: a real AgentSession on the mock provider emits a `write`
// call, and every session event runs through the desktop's own translateEvent. Proves the
// host reads the streamed call block (id/name/partial args) off real base events — the part
// the synthetic unit test cannot cover — and that the file is really written afterwards.
// Usage: OMP_PROFILE=omp-desktop-test bun run scripts/smoke-write-stream.ts
import { TEST_PROFILE } from "./smoke-profile.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProfile } from "@oh-my-pi/pi-utils";

assert.equal(process.env.OMP_PROFILE, TEST_PROFILE, "run with OMP_PROFILE=omp-desktop-test (never the default profile)");
// Static imports cannot work for the coding-agent module: it resolves agentDir at import
// time, so the profile must be active first (smoke-acp-tool.ts precedent).
setProfile(TEST_PROFILE);
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createMockModel, registerMockApi } = await import("@oh-my-pi/pi-ai/providers/mock");
const { translateEvent } = await import("../host/translate.ts");
registerMockApi();

const cwd = mkdtempSync(join(tmpdir(), "write-stream-e2e-"));
const target = "streamed.ts";
// Well past the parse throttle's 256-byte floor: several frames, not one
const body = Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i};`).join("\n");

let writeCalls = 0;
const mock = createMockModel({
  handler: () => {
    // One write, then a plain reply: the tool result feeds a second request, and repeating
    // the call from that request would loop forever.
    if (writeCalls++ === 0) {
      return { content: [{ type: "toolCall", name: "write", arguments: { i: "writing the streamed file", path: target, content: body } }] };
    }
    return { content: ["The file is written."] };
  },
});

const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
authStorage.keys.setRuntime("mock", "mock-key");
const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"));
const sessionManager = SessionManager.create(cwd);
const { session } = await createAgentSession({
  cwd,
  settings: Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" }),
  model: mock,
  modelRegistry,
  agentRegistry: new AgentRegistry(),
  sessionManager,
  getApiKey: async () => "mock-key",
  disableExtensionDiscovery: true,
  enableMCP: false,
  hasUI: true,
});

const entry = { transcript: [], cwd };
const frames: { kind: string; text?: string; path?: string; toolCallId?: string }[] = [];
const phases: string[] = [];
session.subscribe((ev) => {
  phases.push(ev.type);
  const frame = translateEvent(ev, entry as never);
  if (frame) frames.push(frame as never);
});

await session.prompt("please write the file");
await session.waitForIdle?.();

const streamed = frames.filter((f) => f.kind === "tool_args");
assert.ok(streamed.length > 0, `expected tool_args frames, got kinds: ${[...new Set(frames.map((f) => f.kind))].join(", ")}`);
assert.equal(streamed.map((f) => f.text).join(""), body, "streamed frames must concatenate back into the file body");
assert.equal(streamed[0].path, target, "the first frame carries the target path");
assert.equal(streamed[0].toolCallId !== undefined, true, "frames key on the call id the tool frame reuses");
// The preview precedes the call: the row exists before the tool starts executing
const firstArgs = phases.indexOf("message_update");
const toolStart = phases.indexOf("tool_execution_start");
assert.ok(firstArgs >= 0 && toolStart > firstArgs, "tool_args frames must arrive before tool_execution_start");
assert.equal(readFileSync(join(cwd, target), "utf8"), body, "the write tool really wrote the streamed body");

console.log(`ok: ${streamed.length} tool_args frames, ${body.length} chars reconstructed, file written`);
await session.dispose();
rmSync(cwd, { recursive: true, force: true });
