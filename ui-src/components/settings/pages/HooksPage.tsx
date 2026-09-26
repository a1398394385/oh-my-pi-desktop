// 设置页：钩子（pg-hooks）。
// 提供总开关（hooks.enabled 控制 disableExtensionDiscovery）、运行配置项（SchemaRows）与已发现钩子列表。
import { useState } from "react";
import { useAppStore, send, toast } from "../../../store";
import type { HookAssetItem } from "../../../types/frames";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import Icon from "../../../Icon";
import { emptyRow } from "../common";

export default function HooksPage() {
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hooks = agentAssets?.hooks as HookAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);

  const known = typeof hostSettings?.hooksEnabled === "boolean";
  const hooksEnabled = known && !!hostSettings?.hooksEnabled;

  const toggleHooks = () => {
    const next = !hooksEnabled;
    send({ type: "set_hooks_enabled", enabled: next });
    toast(next ? "已开启钩子总开关，对新建会话生效。" : "已关闭钩子总开关。");
  };

  const onRefresh = () => {
    if (spin) return;
    setSpin(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpin(false), 600);
  };

  const toggleHookItem = (id: string, enabled: boolean) => {
    send({ type: "toggle_extension_item", id, enabled });
    const current = useAppStore.getState().agentAssets;
    if (current && Array.isArray(current.hooks)) {
      const nextHooks = current.hooks.map((item) => {
        const itemId = `hook:${item.phase}:${item.tool || "*"}:${item.name}`;
        if (itemId === id) {
          return { ...item, enabled };
        }
        return item;
      });
      useAppStore.setState({ agentAssets: { ...current, hooks: nextHooks } });
    }
  };

  return (
    <div className="set-page" id="pg-hooks">
      <div className="flex items-center justify-between mb-[25px]">
        <div className="set-tt mb-0">钩子</div>
        <button
          type="button"
          className={"icon-btn pg-refresh" + (spin ? " spin" : "")}
          id="hooksRefreshBtn"
          title="刷新钩子列表"
          onClick={onRefresh}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>

      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>启用钩子 (Hooks)</b>
            <span>允许 Agent 执行 pre/post 钩子脚本。支持工具拦截、提示词上下文注入与结果后置审计。对新建会话生效。</span>
          </div>
          <div
            className={"tg" + (hooksEnabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgHooks"
            title={hooksEnabled ? "点击停用钩子" : "点击启用钩子"}
            onClick={toggleHooks}
          >
            <i></i>
          </div>
        </div>
      </div>

      <div className="set-group-tt">运行配置</div>
      <div className="set-group-desc">控制钩子在执行时的状态展示与工具调用超时时间。</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-hooks"]} />

      <div className="set-group-tt">已发现的钩子</div>
      <div className="set-group-desc">
        在 Profile 目录或各项目工作区 <code>.omp/hooks/</code> 下检测到的脚本。
      </div>
      <div className="set-card" id="hooksList">
        {!agentAssets ? (
          emptyRow("加载中…")
        ) : !hooks || hooks.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <b>未检测到钩子脚本</b>
              <span>可在 Profile 目录（<code>~/.omp/agent/hooks/pre/</code>、<code>post/</code>）或项目目录（<code>.omp/hooks/pre/</code>、<code>post/</code>）下放入 <code>.ts</code>、<code>.js</code> 或 <code>.sh</code> 脚本。</span>
            </div>
          </div>
        ) : (
          hooks.map((h) => {
            const hookId = `hook:${h.phase}:${h.tool || "*"}:${h.name}`;
            const itemEnabled = h.enabled !== false;
            return (
              <div className="srow" key={h.path || hookId}>
                <div className="srow-tx">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b>{h.name}</b>
                    <span
                      className={
                        "text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded leading-none " +
                        (h.phase === "pre"
                          ? "bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30"
                          : "bg-[var(--green)]/15 text-[var(--green)] border border-[var(--green)]/30")
                      }
                    >
                      {h.phase}
                    </span>
                    {h.tool && (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--panel-2)] text-[var(--dim)] border border-[var(--line)]">
                        tool: {h.tool}
                      </span>
                    )}
                    <span className="text-[11px] text-[var(--faint)]">
                      {h.projectName ? `项目 · ${h.projectName}` : "Profile"}
                    </span>
                  </div>
                  <span className="truncate max-w-[500px]" title={h.path}>
                    {h.path}
                  </span>
                </div>
                <div
                  className={"tg" + (itemEnabled && hooksEnabled ? " on" : "") + (!hooksEnabled ? " disabled" : "")}
                  title={!hooksEnabled ? "请先开启总开关" : itemEnabled ? "点击禁用该钩子" : "点击启用该钩子"}
                  onClick={() => {
                    if (!hooksEnabled) {
                      toast("请先开启钩子总开关。");
                      return;
                    }
                    toggleHookItem(hookId, !itemEnabled);
                  }}
                >
                  <i></i>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
