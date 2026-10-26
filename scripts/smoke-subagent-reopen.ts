// Throwaway check: reopening a subagent transcript must replay its persisted
// spawn contract instead of re-rendering the main prompt.
// Dynamic imports below are load-order, not style: the coding-agent package
// resolves its agentDir at import time, so the profile must be active first.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const REPO = new URL("..", import.meta.url).pathname;
const now = new Date().toISOString();

const dir = mkdtempSync(join(tmpdir(), "omp-subagent-reopen-"));
const childDir = join(dir, "PARENT");
mkdirSync(childDir);
const parentJsonl = join(dir, "PARENT.jsonl");
writeFileSync(parentJsonl, "");
const childPath = join(childDir, "ScanX.jsonl");
writeFileSync(
  childPath,
  [
    JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: now, cwd: REPO, parentSession: parentJsonl }),
    JSON.stringify({
      type: "session_init",
      id: "init1",
      parentId: "hdr",
      timestamp: now,
      runtime: { version: "18.11.3" },
      systemPrompt: ["CHILD-SCOUT-PROMPT-ONLY"],
      task: "stats only",
      tools: ["read", "grep"],
      agent: "scout",
      readOnly: true,
    }),
  ].join("\n") + "\n",
);

await import("../host/bootstrap.ts");
const { H } = await import("../host/state.ts");
const { discoverAuthStorage, ModelRegistry, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { getAgentDir } = await import("@oh-my-pi/pi-utils");
// Minimal H bootstrap (host/profile.ts applyProfile also rewrites desktop-profile.json,
// which a smoke must never touch).
H.agentDir = getAgentDir();
H.authStorage = await discoverAuthStorage(H.agentDir);
H.modelRegistry = new ModelRegistry(H.authStorage);
H.settings = await Settings.init({ cwd: REPO, agentDir: H.agentDir });
const { handleLoadSession } = await import("../host/session-lifecycle.ts");
const { sessions } = await import("../host/state.ts");

const frames: string[] = [];
const ws = { send: (d: unknown) => frames.push(String(d)), readyState: 1 };
await handleLoadSession(ws, childPath);

const entry = [...sessions.values()].find((e) => e.path === childPath);
assert.ok(entry, "session entry must be created for the reopened child");
assert.equal(entry.isSubagent, true, "parent jsonl exists -> subagent lineage");

const prompt = entry.session.systemPrompt.join("\n");
assert.ok(prompt.includes("CHILD-SCOUT-PROMPT-ONLY"), "persisted child prompt must reach the session");
assert.ok(!prompt.includes("# Project Conventions"), "main prompt blocks must not be injected");
assert.ok(!prompt.includes("# Delegation"), "main delegation rules must not be injected");

console.log("prompt length:", prompt.length);
console.log("frames:", frames.length);

// Control: a child without a persisted session_init has no contract to replay and must
// fall back to the rendered main prompt (proves the assertion above measures the fix).
const bareDir = join(dir, "PARENT2");
mkdirSync(bareDir);
writeFileSync(join(dir, "PARENT2.jsonl"), "");
const barePath = join(bareDir, "Bare.jsonl");
writeFileSync(
  barePath,
  JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: now, cwd: REPO }) + "\n",
);
await handleLoadSession(ws, barePath);
const bare = [...sessions.values()].find((e) => e.path === barePath);
assert.ok(bare, "bare child session entry");
const barePrompt = bare.session.systemPrompt.join("\n");
assert.ok(barePrompt.length > 1000, "no persisted contract -> rendered main prompt");
console.log("fallback prompt length:", barePrompt.length);
rmSync(dir, { recursive: true, force: true });
console.log("OK");
process.exit(0);
