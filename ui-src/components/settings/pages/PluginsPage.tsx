// 设置页：插件（pg-plugins）。
// 提供插件与扩展发现总开关、配置项（SchemaRows）及已安装插件列表展示。
import { useState } from "react";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import type { PluginAssetItem } from "../../../types/frames";

export default function PluginsPage() {
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const plugins = agentAssets?.plugins as PluginAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);

  // 状态判定：hostSettings 尚未落地时不盲猜
  const known = typeof hostSettings?.pluginsEnabled === "boolean";
  const pluginsEnabled = known && !!hostSettings?.pluginsEnabled;

  const togglePlugins = () => {
    const next = !pluginsEnabled;
    send({ type: "set_plugins_enabled", enabled: next });
    toast(next ? "已开启插件与扩展发现，新建会话生效" : "已关闭插件与扩展发现，新建会话生效");
  };

  const onRefresh = () => {
    setSpin(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpin(false), 500);
  };

  return (
    <div className="set-page" id="pg-plugins">
      <div className="flex items-center justify-between mb-[25px]">
        <div className="set-tt mb-0">插件</div>
        <button
          type="button"
          className={"icon-btn pg-refresh" + (spin ? " spin" : "")}
          id="pluginsRefreshBtn"
          title="刷新插件列表"
          onClick={onRefresh}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>

      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>启用插件与扩展发现</b>
            <span>允许 Agent 自动发现并加载用户及项目中的插件与扩展功能（设置会话 <code>disableExtensionDiscovery: false</code>）。开关对新建会话生效。</span>
          </div>
          <div
            className={"tg" + (pluginsEnabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgPlugins"
            title={pluginsEnabled ? "点击停用插件发现" : "点击启用插件发现"}
            onClick={togglePlugins}
          >
            <i></i>
          </div>
        </div>
      </div>


      <div className="set-group-tt">配置项</div>
      <div className="set-group-desc">控制插件与扩展的超时时间、市场自动更新模式及自定义加载路径。</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-plugins"]} />

      <div className="set-group-tt">已安装插件</div>
      <div className="set-group-desc">系统检测到的可用插件清单。可通过 <code>omp</code> 命令行管理安装。</div>
      <div className="set-card" id="pluginsList">
        {!agentAssets ? (
          emptyRow("加载中…")
        ) : !plugins || plugins.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <b>未检测到已安装的插件</b>
              <span>可通过命令行 <code>omp plugin install &lt;package&gt;</code> 安装插件，或在上方外部扩展路径中配置自定义路径。</span>
            </div>
          </div>
        ) : (
          plugins.map((p) => (
            <div className="srow" key={p.path || p.name}>
              <div className="srow-tx">
                <b>
                  {p.name}
                  {p.version && <span style={{ marginLeft: 8, fontSize: "0.85em", color: "var(--dim)" }}>v{p.version}</span>}
                  {p.scope && <span style={{ marginLeft: 6, fontSize: "0.8em", color: "var(--dim)" }}>[{p.scope === "user" ? "用户" : "项目"}]</span>}
                </b>
                <span>{p.description || p.path || "已安装插件"}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
