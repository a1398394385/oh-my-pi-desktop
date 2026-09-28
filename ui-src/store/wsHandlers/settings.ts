// 设置中心数据域帧：登录流程、供应商与配额、资产/记忆/MCP 编辑器回包、
// 输入框 sigil 候选（斜杠命令清单 / @ 文件匹配）。自 store/ws.ts onMessage 平移。
import { useAppStore } from "../index";
import type { McpAssetsPayload } from "../../types/frames";
import type { HandlerSlice } from "./types";

export const settingsHandlers = {
  limits_result(msg) {
    useAppStore.setState((s) => ({ ctxLimits: msg }));
  },
  provider_limits_result(msg) {
    // 模型管理页配额：按选中供应商落地，组件按 providerLimits 渲染（防旧响应污染由组件判 provider）
    if (msg.provider === useAppStore.getState().selectedProvider) {
      useAppStore.setState((s) => ({ providerLimits: msg }));
    }
  },
  all_providers(msg) {
    useAppStore.setState((s) => ({ allProvidersCache: msg.providers ?? [] }));
  },
  login_progress(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    useAppStore.setState((s) => ({ loginBanner: `${msg.provider}：${msg.message}` }));
  },
  login_prompt(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    useAppStore.setState((s) => ({ loginPromptData: msg }));
  },
  login_done(msg) {
    if (msg.reqId !== useAppStore.getState().loginReqId) return;
    if (msg.ok) {
      useAppStore.getState().toast(`${msg.provider} 登录成功，模型列表已刷新`);
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null, mpAddView: false }));
    } else if (msg.cancelled) {
      useAppStore.getState().toast("登录已取消");
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
    } else {
      useAppStore.getState().toast(`${msg.provider} 登录失败：${msg.message}`);
      useAppStore.setState((s) => ({ loginBusy: false, loginBanner: null, loginPromptData: null }));
    }
  },
  provider_key_done(msg) {
    useAppStore.getState().toast(`${msg.provider} API key 已保存，模型列表已刷新`);
    useAppStore.setState((s) => ({ mpDetailProv: null }));
    useAppStore.getState().send({ type: "get_all_providers" });
  },
  models_config_path(msg) {
    useAppStore.getState().toast(`配置文件：${msg.path}`);
  },
  asset_file(msg) {
    // skills/agents/mcp 编辑器共用帧，全量落地，页面按 kind 过滤（每次赋新对象触发 effect）。
    // 补 type 字段构造完整帧对象(kind 缺省兜底为原行为);新对象引用驱动「已保存」态复位
    useAppStore.setState((s) => ({
      assetFile: { type: "asset_file", kind: msg.kind ?? "agent", path: msg.path, content: msg.content },
    }));
  },
  memory_file(msg) {
    // 首次目录级读取带 files；行展开/rollout 只回 content（旧版 memInbox 语义平移）
    useAppStore.setState((s) => {
      const md = s.memoryDetail;
      const next = msg.files
        ? {
            ...md,
            base: msg.path,
            files: msg.files,
            rollouts: msg.rollouts ?? [],
            active: { name: msg.file, rollout: false },
          }
        : { ...md };
      next.content = msg.content;
      next.status = "done";
      next.error = null;
      return { memoryDetail: next };
    });
  },
  asset_file_saved(msg) {
    const at = Date.now();
    useAppStore.setState((s) => ({ assetFileSaved: { kind: msg.kind, at }, assetSaved: { kind: msg.kind, at } }));
    useAppStore.getState().send({ type: "list_agent_assets" });
  },
  asset_file_deleted(msg) {
    useAppStore.getState().toast(msg.kind === "skill" ? "技能已删除" : "文件已删除");
  },
  mcp_server_tested(msg) {
    // 旧版 handleMcpServerTested 平移：测试结果落地 + 行状态点同步 + toast（全量换引用）
    useAppStore.setState((st) => {
      // mcp 段逐字段形状随底座扫描函数(frames.ts TODO),此处只取 servers 数组的测试相关字段
      const mcp = st.agentAssets?.mcp as { servers?: { name: string; status?: string; error?: string; log?: string }[] } | undefined;
      const servers = mcp?.servers;
      const srv = servers?.find((x) => x.name === msg.name);
      const mcpTestResults = { ...st.mcpTestResults, [msg.name]: { status: msg.status, error: msg.error, log: msg.log, ts: Date.now() } };
      if (!srv || !servers || !mcp) return { mcpTestResults };
      const nextServers = servers.map((x) =>
        x === srv ? { ...x, status: msg.status === "ok" ? "connected" : "error", error: msg.error, log: msg.log } : x,
      );
      return {
        mcpTestResults,
        // mcp 经窄类型 as 读 servers(spread 运行期保留全部字段),静态侧断言还原完整负载类型
        agentAssets: { ...st.agentAssets!, mcp: { ...mcp, servers: nextServers } as McpAssetsPayload },
      };
    });
    useAppStore.getState().toast(msg.status === "ok" ? `MCP [${msg.name}] 连接成功` : `MCP [${msg.name}] 探测失败: ${msg.error || ""}`);
  },
  // ---- 输入框 sigil：斜杠命令清单（宿主 list_commands 回包；list_files 的 @ 候选回包） ----
  commands(msg) {
    useAppStore.setState((s) => ({
      commands: Array.isArray(msg.commands) ? msg.commands : [],
      commandsSessionId: msg.sessionId ?? "new", // 无会话回包 = 新建页清单
    }));
  },
  file_matches(msg) {
    if (msg.reqId !== useAppStore.getState().mentionReqSeq) return; // 过期响应：用户已继续输入，丢弃
    useAppStore.setState((s) => ({
      mentionResult: { reqId: msg.reqId, matches: Array.isArray(msg.matches) ? msg.matches : [] },
    }));
  },
} satisfies HandlerSlice;

// 域键集（供 index 的穷尽断言交叉验证）
export type SettingsFrames = keyof typeof settingsHandlers;
