// 登录与凭证域 RPC：浏览器授权登录（onPrompt 经 UI 弹窗中转）、登出、API key 写入、
// 登录取消与 prompt 应答、打开 models.yml。自 main.ts message 分发平移（第三刀）。
import path from "node:path";
import fs from "node:fs";
import { authPolicyFor } from "../bootstrap.ts";
import { H, loginPendingPrompts } from "../state.ts";
import { rebuildScopedModels, modelCatalog } from "../models.ts";
import { modelsFrame } from "../frames.ts";
import type { RpcHandler } from "./types";

export const loginHandlers: Record<string, RpcHandler> = {
  async provider_login(ws, msg) {
    // OMP 登录流程(AuthStorage.login):浏览器授权 + 需要粘贴码时经 UI 弹窗中转
    const provider = String(msg.provider ?? "");
    if (!provider) throw new Error("缺少 provider");
    if (H.loginInFlight) throw new Error("已有登录流程进行中，请完成或稍后再试");
    H.loginInFlight = true;
    H.loginAbort = new AbortController();
    const reqId = msg.reqId ?? null;
    const wsRef = ws;
    const reply = (obj: Record<string, unknown>) => {
      try {
        wsRef.send(JSON.stringify({ reqId, ...obj }));
      } catch {}
    };
    reply({ type: "login_progress", provider, message: "正在启动登录…" });
    let promptSeq = 0;
    try {
      const identity = await H.authStorage.login(provider, {
        signal: H.loginAbort.signal,
        onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
          if (H.loginAbort?.signal.aborted) return;
          const url = info.launchUrl ?? info.url;
          if (url) {
            try {
              Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
            } catch {}
          }
          reply({
            type: "login_progress",
            provider,
            message: info.instructions || "已在浏览器打开登录页面，请完成授权…",
            url: url ?? "",
          });
        },
        onProgress: (message: string) => reply({ type: "login_progress", provider, message: String(message) }),
        onPrompt: (prompt: { message?: string; secret?: boolean }) =>
          new Promise<string>((resolve, reject) => {
            const id = ++promptSeq;
            loginPendingPrompts.set(id, resolve);
            H.loginAbort?.signal.addEventListener(
              "abort",
              () => {
                loginPendingPrompts.delete(id);
                reject(new Error("aborted"));
              },
              { once: true },
            );
            reply({ type: "login_prompt", provider, id, message: String(prompt.message ?? ""), secret: !!prompt.secret });
          }),
      });
      // 登录成功:重新拉取模型目录(新凭证使供应商可用),并推送最新列表
      await H.modelRegistry.refresh();
      H.availableModels = H.modelRegistry.getAvailable();
      rebuildScopedModels();
      reply(modelsFrame());
      reply({ type: "models_catalog", models: modelCatalog() });
      reply({ type: "login_done", provider, ok: true, identity: identity ?? null });
    } catch (err) {
      const aborted = H.loginAbort?.signal.aborted;
      reply({
        type: "login_done",
        provider,
        ok: false,
        cancelled: !!aborted,
        message: aborted ? "登录已取消" : String((err as any)?.message ?? err),
      });
    } finally {
      H.loginInFlight = false;
      H.loginAbort = null;
    }
  },
  async provider_logout(ws, msg) {
    // 登出供应商：删除存储凭证（本地毫秒级）后立即本地过滤推送目录，UI 瞬时移除；
    // 完整的 modelRegistry.refresh()（逐供应商网络发现，秒级）随后收敛再推一版(幂等)。
    // models.yml 手写 apiKey 的优先级高于存储凭证，该类供应商 UI 不提供登出入口
    const provider = String(msg.provider ?? "");
    if (!provider) throw new Error("缺少 provider");
    await H.authStorage.remove(provider);
    H.availableModels = H.availableModels.filter((m) => m.provider !== provider);
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    try {
      await H.modelRegistry.refresh();
      H.availableModels = H.modelRegistry.getAvailable();
      rebuildScopedModels();
      ws.send(JSON.stringify(modelsFrame()));
      ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    } catch (err) {
      process.stderr.write(`[host] 登出后模型目录刷新失败: ${err}\n`);
    }
  },
  provider_login_cancel(_ws, _msg) {
    // 用户显式取消(如关闭了登录页):中断进行中的登录流程
    if (H.loginInFlight && H.loginAbort) H.loginAbort.abort();
    else throw new Error("当前没有进行中的登录流程");
  },
  async provider_set_key(ws, msg) {
    // 配置 API key:写入 authStorage(api_key 凭证),随后刷新模型目录
    const provider = String(msg.provider ?? "");
    const key = String(msg.key ?? "").trim();
    if (!provider) throw new Error("缺少 provider");
    if (!key) throw new Error("API key 不能为空");
    // 登录型供应商(oauth/device/custom)凭证经浏览器授权归属到目录供应商(store-as),
    // 目录里没有同名 provider,存 API key 只会产生「已配置」却永不可用的孤立凭证
    const loginKind = authPolicyFor(provider)?.login?.kind;
    if (loginKind === "oauth-code" || loginKind === "device-code" || loginKind === "custom") {
      throw new Error(`${provider} 仅支持浏览器登录授权，不支持 API key`);
    }
    H.authStorage.upsertCredential(provider, { type: "api_key", key });
    await H.modelRegistry.refresh();
    H.availableModels = H.modelRegistry.getAvailable();
    rebuildScopedModels();
    ws.send(JSON.stringify(modelsFrame()));
    ws.send(JSON.stringify({ type: "models_catalog", models: modelCatalog() }));
    ws.send(JSON.stringify({ type: "provider_key_done", provider, ok: true }));
  },
  login_prompt_reply(_ws, msg) {
    const resolve = loginPendingPrompts.get(Number(msg.id));
    if (resolve) {
      loginPendingPrompts.delete(Number(msg.id));
      resolve(String(msg.text ?? ""));
    }
  },
  open_models_config(ws, msg) {
    // 「手动添加供应商」:打开配置层 models.yml(不存在则创建空文件)
    const modelsPath = path.join(H.agentDir, "models.yml");
    try {
      if (!fs.existsSync(modelsPath)) fs.writeFileSync(modelsPath, "# omp 供应商配置,参考文档编辑\n");
      Bun.spawn(["open", modelsPath], { stdout: "ignore", stderr: "ignore" });
    } catch {}
    ws.send(JSON.stringify({ type: "models_config_path", path: modelsPath }));
  },
};
