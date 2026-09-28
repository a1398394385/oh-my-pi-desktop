// 设置域 RPC：底座设置读写、实验性开关（acp/sessionContext/hooks/plugins/skills）、
// 桌面环境（代理/证书）、profile 切换、审批模式与审批应答、计划模式开关。
// 自 main.ts message 分发平移（第三刀）。
import path from "node:path";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings";
import { H, sessions, pendingApprovals, type DesktopEnv } from "../state.ts";
import { rebuildScopedModels, settingsSnapshot } from "../models.ts";
import { settingsFrame, modelsFrame } from "../frames.ts";
import {
  readAcpRaw,
  writeAcpEnabled,
  writeSessionContextEnabled,
  applyProfile,
  applySleepPrevention,
  applyDesktopEnv,
} from "../profile.ts";
import { listAgentAssets, writeHooksEnabled, writePluginsEnabled } from "../assets.ts";
import { setPlanMode } from "../plan.ts";
import { handleListSessions } from "./session";
import type { RpcHandler } from "./types";

export const settingsHandlers: Record<string, RpcHandler> = {
  get_settings(ws) {
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  get_settings_schema(ws) {
    ws.send(JSON.stringify({ type: "settings_schema", schema: SETTINGS_SCHEMA }));
  },
  async reload_settings(ws) {
    // 本地 config 文件可能被手工修改：从磁盘重载（仅模型设置），并推送新模型列表
    try {
      await H.settings.reloadFromDisk();
      rebuildScopedModels();
      ws.send(JSON.stringify(modelsFrame()));
      ws.send(JSON.stringify({ type: "settings", settings: settingsSnapshot() }));
    } catch (err) {
      process.stderr.write(`[host] reload_settings 失败: ${err}\n`);
    }
  },
  async set_setting(ws, msg) {
    const key = String(msg.key ?? "");
    let value = msg.value;
    const def = SETTINGS_SCHEMA[key];
    if (!def) throw new Error(`未知设置项: ${key}`);
    const t = def.type;
    if (t === "number") {
      if ((key === "compaction.thresholdPercent" || key === "compaction.thresholdTokens") && value === "default") {
        value = -1;
      } else if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n)) value = n;
      }
    }
    if (t === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} 必须是布尔值`);
    } else if (t === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`);
    } else if (t === "string") {
      if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
    } else if (t === "enum") {
      if (!def.values.includes(value)) throw new Error(`${key} 必须是 ${def.values.join("/")} 之一`);
    } else if (t === "array") {
      if (!Array.isArray(value)) throw new Error(`${key} 必须是数组`);
      const d = def.default;
      if (Array.isArray(d) && d.every((x) => typeof x === "string") && d.length > 0 && !value.every((x) => typeof x === "string"))
        throw new Error(`${key} 元素必须是字符串`);
    } else if (t === "record") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} 必须是对象`);
    }
    // 逐键附加校验：ask.timeout 必须非负
    if (key === "ask.timeout" && (typeof value !== "number" || value < 0)) throw new Error("ask.timeout 必须是非负秒数");
    H.settings.set(key, value);
    // 写后副作用：睡眠防止需立即应用到进程
    if (key === "power.sleepPrevention") applySleepPrevention(value);
    // 模型相关键：重建 scoped 目录并推送 models 帧
    const isModelKey = ["enabledModels", "enabledProviders", "disabledProviders", "modelRoleStorage", "modelTags", "modelProviderOrder", "cycleOrder"].includes(key);
    if (isModelKey) rebuildScopedModels();
    await H.settings.flush();
    if (isModelKey) ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_acp_enabled(ws, msg) {
    // 实验性功能页开关：写入 omp-desktop.json 的 acp.enabled（只影响此后创建的会话——
    // 工具面与 context 扩展在 createSessionCore 里注入，无法热插拔到已打开的会话）
    await writeAcpEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_acp_config(ws, msg) {
    // 实验性功能页：更新 omp-desktop.json 的 acp 配置段
    const raw = readAcpRaw();
    const acp = (raw.acp && typeof raw.acp === "object" ? raw.acp : {}) as Record<string, unknown>;
    const patch = (msg.config && typeof msg.config === "object" ? msg.config : {}) as Record<string, unknown>;
    await writeFile(H.desktopProjectsPath, JSON.stringify({ ...raw, acp: { ...acp, ...patch } }, null, 2));
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_session_context_enabled(ws, msg) {
    // 实验性功能页开关：写入 omp-desktop.json 的 sessionContext.enabled（同上，只影响此后创建的会话）
    await writeSessionContextEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
  },
  async set_hooks_enabled(ws, msg) {
    // 钩子总开关：写入 omp-desktop.json 的 hooks.enabled（只影响此后创建的会话）
    await writeHooksEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_plugins_enabled(ws, msg) {
    // 插件总开关：写入 omp-desktop.json 的 plugins.enabled（只影响此后创建的会话）
    await writePluginsEnabled(!!msg.enabled);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_skills_enabled(ws, msg) {
    // 技能总开关：写入底座 settings.json 的 skills.enabled（getGroup("skills") 各加载点消费）
    H.settings.set("skills.enabled", !!msg.enabled);
    await H.settings.flush();
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
  },
  async set_desktop_env(ws, msg) {
    const next: DesktopEnv = {
      httpProxy: String(msg.httpProxy ?? "").trim(),
      noProxy: String(msg.noProxy ?? "").trim(),
      caCerts: String(msg.caCerts ?? "").trim(),
    };
    await writeFile(H.desktopEnvPath, JSON.stringify(next, null, 2));
    H.desktopEnv = next;
    H.desktopEnvFilePresent = true;
    applyDesktopEnv(next);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame(), restartHint: true }));
  },
  async switch_profile(ws, msg) {
    const p = String(msg.profile ?? "").trim();
    if (!p) throw new Error("Profile 名称不能为空");
    await applyProfile(p);
    ws.send(JSON.stringify({ type: "settings", settings: settingsFrame() }));
    ws.send(JSON.stringify(modelsFrame()));
    await handleListSessions(ws);
    try {
      ws.send(JSON.stringify({ type: "agent_assets", assets: await listAgentAssets() }));
    } catch {}
    ws.send(JSON.stringify({ type: "profile_switched", profile: H.currentProfile }));
  },
  set_approval_mode(ws, msg) {
    const mode = msg.mode;
    if (mode !== "yolo" && mode !== "write" && mode !== "always-ask") {
      throw new Error(`非法审批模式: ${mode}`);
    }
    // execute-time 解析：无需重建会话，下一个工具调用即生效（对全部会话生效——settings 全进程共享）
    H.settings.override("tools.approvalMode", mode);
    ws.send(JSON.stringify({ type: "approval_mode", mode }));
  },
  set_plan_mode(ws, msg) {
    // 计划模式开关：UI 从权限模式菜单进入、从权限胶囊右侧的「计划」按钮退出
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    setPlanMode(ws, msg.sessionId, entry, msg.enabled === true);
  },
  approval_response(ws, msg) {
    const pending = pendingApprovals.get(msg.requestId);
    if (!pending) throw new Error(`审批请求不存在或已结束: ${msg.requestId}`);
    pending.resolve(typeof msg.answer === "string" ? msg.answer : undefined);
    ws.send(JSON.stringify({ type: "approval_resolved", requestId: msg.requestId }));
  },
  ui_error(_ws, msg) {
    // 前端未捕获错误上报（WKWebView 无 console，dev 终端是唯一出口）
    process.stderr.write(`[ui] ${msg.message}\n`);
  },
  async open_folder(_ws, msg) {
    const raw = String(msg.path ?? "");
    if (raw) {
      try {
        if (!fs.existsSync(raw)) await mkdir(raw, { recursive: true });
        Bun.spawn(["open", raw], { stdout: "ignore", stderr: "ignore" });
      } catch {}
    }
  },
};
