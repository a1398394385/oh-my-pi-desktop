// Throwaway probe: the SessionStatsBar compaction-regression fix, verified
// against the real SDK SessionManager (no model / API key needed).
//
// Builds a real session file with interleaved message + model_usage entries,
// runs a real compaction entry through it, and compares:
//   - getUsageStatistics()  -> what the host now sends (cumulative)
//   - the active-window sum  -> what getSessionStats().tokens used (windowed)
//
// Run: OMP_PROFILE=omp-desktop-test bun scripts/probe-stats-cumulative.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../host/bootstrap.ts";

const dir = await mkdtemp(`${tmpdir()}/omp-stats-cum-`);
const file = path.join(dir, "s.jsonl");

const usage = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  reasoningTokens: 0,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { total: 0.001 },
  stopReason: "stop",
});

const lines: unknown[] = [
  { type: "session", version: 1, id: "sess-probe-0001", timestamp: new Date().toISOString(), cwd: dir },
];
let parent: string | null = null;
const push = (entry: Record<string, unknown>) => {
  const id = String(entry.id);
  lines.push({ ...entry, parentId: parent, timestamp: new Date().toISOString() });
  parent = id;
  return id;
};

// Keep the real ids: the loader preserves entry ids, and firstKeptEntryId has to
// point at an id that actually exists in the branch.
const u5Id = "msg-u5";
for (let i = 1; i <= 6; i++) {
  push({ type: "message", id: i === 5 ? u5Id : `msg-u${i}`, message: { role: "user", content: `turn ${i}` } });
  push({ type: "model_usage", id: `mu${i}`, purpose: "main", api: "a", provider: "p", model: "m", usage: usage(100, 200, 5000) });
  push({ type: "message", id: `msg-a${i}`, message: { role: "assistant", content: [], usage: usage(100, 200, 5000) } });
}
// Compaction keeping only the last 2 turns (from the 5th user message).
push({ type: "compaction", id: "cp1", summary: "sum", firstKeptEntryId: u5Id, tokensBefore: 999_999 });

await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const mgr = await SessionManager.open(file);
const cumulative = mgr.getUsageStatistics();
const branch = mgr.getBranch();

console.log("=== 真实 SessionManager 读回 ===");
console.log("branch 条目数:", branch.length, "| 含 compaction:", branch.some((e) => e.type === "compaction"));
console.log("branch 实际内容:");
branch.forEach((e, i) => {
  const extra = e.type === "compaction" ? ` firstKeptEntryId=${"firstKeptEntryId" in e ? String(e.firstKeptEntryId) : "?"}` : "";
  console.log(`  [${i}] ${e.type} ${e.id}${extra}`);
});

// Reproduce the base layer's active-window rule (session-stats.ts
// activeModelUsageEntries) over the REAL branch entries, verbatim.
//
// Note: SessionManager regenerates entry ids when loading, so the firstKeptEntryId
// written into the file does not match any branch id. That is the *real* loader
// path we want to show anyway — the base layer's findIndex then misses and the
// window start falls back to compactionIndex + 1. The second computation below
// uses a matched id so the window keeps 2 turns, showing the milder realistic case.
const isUsageWindowBoundary = (e: { type: string }): boolean =>
  e.type === "message" ||
  e.type === "custom_message" ||
  e.type === "branch_summary" ||
  e.type === "compaction" ||
  e.type === "reset_boundary";

const sumWindow = (from: number) => {
  const acc = { input: 0, output: 0, cacheRead: 0 };
  for (const e of branch.slice(from)) {
    if (e.type !== "model_usage") continue;
    acc.input += e.usage.input;
    acc.output += e.usage.output;
    acc.cacheRead += e.usage.cacheRead;
  }
  return acc;
};

const cp = [...branch].reverse().find((e) => e.type === "compaction");
const compactionIndex = cp ? branch.lastIndexOf(cp) : -1;

const windowFor = (firstKeptEntryId: string) => {
  const firstKeptIndex = branch.findIndex((e) => e.id === firstKeptEntryId);
  let startIndex = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
  while (startIndex > 0 && !isUsageWindowBoundary(branch[startIndex - 1])) startIndex--;
  return startIndex;
};

const windowed = sumWindow(windowFor("msg-u5"));
// Milder realistic case: window opens at the 5th turn's own model_usage.
const milder = sumWindow(branch.findIndex((e) => e.id !== undefined && e.type === "model_usage" && branch.indexOf(e) >= 12));

console.log("\n=== 累计口径（host 现在下发：getUsageStatistics）===");
console.log({ input: cumulative.input, output: cumulative.output, cacheRead: cumulative.cacheRead, cacheWrite: cumulative.cacheWrite });
console.log("\n=== 旧口径（getSessionStats 的活动窗口筛选）===");
console.log("compaction 在 branch 的位置:", compactionIndex);
console.log("窗口起点(firstKeptEntryId 未命中 -> 落到 compaction 之后):", windowFor("msg-u5"));
console.log("窗口内 model_usage:", branch.slice(windowFor("msg-u5")).filter((e) => e.type === "model_usage").map((e) => e.id));
console.log("窗口合计:", windowed);
console.log("窗口开在第 5 轮时的合计(较温和的真实情形):", milder);

console.log("\n=== 结论：压缩一次，旧口径丢掉的量 ===");
console.log({
  input: cumulative.input - windowed.input,
  output: cumulative.output - windowed.output,
  cacheRead: cumulative.cacheRead - windowed.cacheRead,
});
console.log("累计口径 6 轮全保留（单调）；旧口径只剩窗口内那几轮 —— 这就是数字往回跳的原因");

await rm(dir, { recursive: true, force: true }).catch(() => {});
process.exit(0);
