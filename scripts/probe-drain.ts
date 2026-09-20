// 探针：SDK 层复现 followUp 排队消息的自动消费（drain）。
// 场景：长任务跑动中排队一条 followUp → turn_end 后队列应自动清空（idle drain）。
// 用法：OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/probe-drain.ts
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
let seenNonEmpty = false; // 排队后队列曾非空（成功判定的前置，防误判）
const t0 = Date.now();
const agent = (session as any).agent;
session.subscribe((ev: any) => {
  if (ev.type === "agent_start") console.log(`[+${Date.now() - t0}ms] agent_start`);
  if (ev.type === "agent_end" && ev.isTerminal !== false) {
    turnEndAt = Date.now();
    console.log(`[+${Date.now() - t0}ms] agent_end (terminal)`);
  }
});

// 长任务：read 探针文件 + sleep 3 + 总结（与 steer-smoke 同构，多工具轮次）
import { writeFileSync } from "node:fs";
const probeFile = `/tmp/omp-probe-drain-${Date.now()}.txt`;
writeFileSync(probeFile, "PROBE-A\nPROBE-B\n");
void session
  .prompt(
    `用 read 工具读取 ${probeFile}，然后用 bash 执行 sleep 3，最后把文件两行内容连成一句话输出。慢慢来，按步骤调用工具。`,
  )
  .catch((e) => console.log("prompt1 err", String(e)));

// 复刻 host 的 dequeue hook（消费前通知）
agent.addBeforeQueuedMessageDequeueHook(() => {
  const texts = agent
    .peekSteeringQueue()
    .concat(agent.peekFollowUpQueue())
    .filter((m: any) => m.role === "user" || (m.role === "custom" && m.attribution === "user" && m.display !== false))
    .map((m: any) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content.find((p: any) => p.type === "text")?.text ?? "") : ""));
  console.log(`[+${Date.now() - t0}ms] dequeue-hook: 即将消费 ${JSON.stringify(texts)}`);
});

// 等首个事件（isStreaming 置位）再排队 followUp
const timer = setInterval(() => {
  const q = (session as any).agent.peekFollowUpQueue().length;
  if (turnEndAt === 0 && queuedAt === 0 && (session as any).agent) {
    // isStreaming 通过 agent.state 读
    if ((session as any).agent.state.isStreaming) {
      queuedAt = Date.now();
      void (async () => {
        // 复刻 UI 完整操作序列：排队 → 立即发送(转 steer) → 放回队列(requeue) → 删除(drop) → 强指令排队
        await session
          .prompt("排队中的原文", { streamingBehavior: "followUp" })
          .then((ok) => console.log(`[+${Date.now() - t0}ms] 排队返回 ${ok}`));
        // send_now：从 followUp 取出转 steer（与 host handleSendNow 同构）
        const q0 = agent.peekFollowUpQueue();
        const moved0 = { ...q0[q0.length - 1] };
        delete moved0.steering;
        agent.replaceQueues(agent.peekSteeringQueue(), q0.slice(0, -1));
        await session.steer("排队中的原文");
        console.log(`[+${Date.now() - t0}ms] send_now 完成 steering=${agent.peekSteeringQueue().length}`);
        // requeue：steer 第 0 条回 followUp 顶端
        const s1 = agent.peekSteeringQueue();
        const moved1 = { ...s1[s1.length - 1] };
        delete moved1.steering;
        agent.replaceQueues(s1.slice(0, -1), [moved1, ...agent.peekFollowUpQueue()]);
        console.log(`[+${Date.now() - t0}ms] requeue 完成 followUp=${agent.peekFollowUpQueue().length}`);
        // drop：followUp 第 0 条删除（含伴随）
        agent.replaceQueues(agent.peekSteeringQueue(), agent.peekFollowUpQueue().slice(1));
        console.log(`[+${Date.now() - t0}ms] drop 完成 followUp=${agent.peekFollowUpQueue().length}`);
        // 强指令排队（等待自动消费）
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

// 总超时兜底
setTimeout(() => {
  clearInterval(timer);
  console.log("✗ 总超时");
  process.exit(1);
}, 60000);

// 成功条件：turn_end 后队列清空
const watch = setInterval(() => {
  if (queuedAt > 0 && seenNonEmpty && turnEndAt > 0 && (session as any).agent.peekFollowUpQueue().length === 0) {
    clearInterval(watch);
    clearInterval(timer);
    console.log(`✓ followUp 已被自动消费（turn_end 后 ${Date.now() - turnEndAt}ms）`);
    process.exit(0);
  }
}, 200);
