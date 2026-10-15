// Probe: reproduce automatic consumption (drain) of queued followUp messages at the SDK layer.
// Scenario: queue a followUp while a long task is running -> the queue should auto-drain after turn_end (idle drain).
// Usage: OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/probe-drain.ts
import { setProfile } from "@oh-my-pi/pi-utils";

setProfile("omp-desktop");
const { createAgentSession, SessionManager, Settings, discoverAuthStorage, ModelRegistry, AgentRegistry } =
  await import("@oh-my-pi/pi-coding-agent");
import os from "node:os";

const cwd = os.homedir();
const agentDir = (await import("@oh-my-pi/pi-utils")).getAgentDir();
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const settings = await Settings.init({ cwd, agentDir });
const manager = SessionManager.create(cwd);
const want = process.env.OMP_DESKTOP_MODEL || "deepseek/deepseek-flash";
const model = modelRegistry.getAvailable().find((m: any) => `${m.provider}/${m.id}` === want);
if (!model) throw new Error("找不到模型: " + want);
const { session } = await createAgentSession({
  cwd,
  authStorage,
  modelRegistry,
  settings,
  model,
  agentRegistry: new AgentRegistry(),
  sessionManager: manager,
  disableExtensionDiscovery: true,
  enableMCP: false,
});

let queuedAt = 0;
let turnEndAt = 0;
let seenNonEmpty = false; // The queue was non-empty right after enqueue (precondition of the success check, against misjudging)
const t0 = Date.now();
const agent = (session as any).agent;
session.subscribe((ev: any) => {
  if (ev.type === "agent_start") console.log(`[+${Date.now() - t0}ms] agent_start`);
  if (ev.type === "agent_end" && ev.isTerminal !== false) {
    turnEndAt = Date.now();
    console.log(`[+${Date.now() - t0}ms] agent_end (terminal)`);
  }
});

// Long task: read a probe file + sleep 3 + summarize (same shape as steer-smoke, multiple tool turns)
import { writeFileSync } from "node:fs";
const probeFile = `${os.tmpdir()}/omp-probe-drain-${Date.now()}.txt`;
writeFileSync(probeFile, "PROBE-A\nPROBE-B\n");
void session
  .prompt(
    `用 read 工具读取 ${probeFile}，然后用 bash 执行 sleep 3，最后把文件两行内容连成一句话输出。慢慢来，按步骤调用工具。`,
  )
  .catch((e) => console.log("prompt1 err", String(e)));

// Replicates the host's dequeue hook (pre-consumption notification)
agent.addBeforeQueuedMessageDequeueHook(() => {
  const texts = agent
    .peekSteeringQueue()
    .concat(agent.peekFollowUpQueue())
    .filter((m: any) => m.role === "user" || (m.role === "custom" && m.attribution === "user" && m.display !== false))
    .map((m: any) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content.find((p: any) => p.type === "text")?.text ?? "") : ""));
  console.log(`[+${Date.now() - t0}ms] dequeue-hook: 即将消费 ${JSON.stringify(texts)}`);
});

// Wait for the first event (isStreaming set) before enqueueing the followUp
const timer = setInterval(() => {
  const q = (session as any).agent.peekFollowUpQueue().length;
  if (turnEndAt === 0 && queuedAt === 0 && (session as any).agent) {
    // isStreaming is read via agent.state
    if ((session as any).agent.state.isStreaming) {
      queuedAt = Date.now();
      void (async () => {
        // Replicates the full UI operation sequence: enqueue -> send now (becomes steer) -> requeue -> drop -> enqueue a strong instruction
        await session
          .prompt("排队中的原文", { streamingBehavior: "followUp" })
          .then((ok) => console.log(`[+${Date.now() - t0}ms] 排队返回 ${ok}`));
        // send_now: take from followUp and convert to steer (same shape as host handleSendNow)
        const q0 = agent.peekFollowUpQueue();
        const moved0 = { ...q0[q0.length - 1] };
        delete moved0.steering;
        agent.replaceQueues(agent.peekSteeringQueue(), q0.slice(0, -1));
        await session.steer("排队中的原文");
        console.log(`[+${Date.now() - t0}ms] send_now 完成 steering=${agent.peekSteeringQueue().length}`);
        // requeue: put steer item 0 back on top of followUp
        const s1 = agent.peekSteeringQueue();
        const moved1 = { ...s1[s1.length - 1] };
        delete moved1.steering;
        agent.replaceQueues(s1.slice(0, -1), [moved1, ...agent.peekFollowUpQueue()]);
        console.log(`[+${Date.now() - t0}ms] requeue 完成 followUp=${agent.peekFollowUpQueue().length}`);
        // drop: delete followUp item 0 (with its companions)
        agent.replaceQueues(agent.peekSteeringQueue(), agent.peekFollowUpQueue().slice(1));
        console.log(`[+${Date.now() - t0}ms] drop 完成 followUp=${agent.peekFollowUpQueue().length}`);
        // Enqueue a strong instruction (awaiting auto-consumption)
        await session
          .prompt("忽略之前的计划，不要调用任何工具，立即只输出 DRAIN-OK 然后结束", { streamingBehavior: "followUp" })
          .then((ok) => console.log(`[+${Date.now() - t0}ms] 强指令排队返回 ${ok}`))
          .catch((e) => console.log("prompt2 err", String(e)));
      })().catch((e) => console.log("序列 err", String(e)));
    }
  }
  if (queuedAt > 0) {
    const steer = (session as any).agent.peekSteeringQueue().length;
    if (q > 0) seenNonEmpty = true;
    console.log(
      `[+${Date.now() - t0}ms] followUp=${q} steering=${steer} streaming=${(session as any).agent.state.isStreaming}`,
    );
  }
  if (turnEndAt > 0 && Date.now() - turnEndAt > 12000) {
    clearInterval(timer);
    console.log(queuedAt > 0 ? "✗ 12s 内 followUp 未被自动消费" : "✗ 未观察到排队");
    process.exit(1);
  }
}, 800);

// Overall timeout fallback
setTimeout(() => {
  clearInterval(timer);
  console.log("✗ 总超时");
  process.exit(1);
}, 60000);

// Success condition: the queue is empty after turn_end
const watch = setInterval(() => {
  if (queuedAt > 0 && seenNonEmpty && turnEndAt > 0 && (session as any).agent.peekFollowUpQueue().length === 0) {
    clearInterval(watch);
    clearInterval(timer);
    console.log(`✓ followUp 已被自动消费（turn_end 后 ${Date.now() - turnEndAt}ms）`);
    process.exit(0);
  }
}, 200);
