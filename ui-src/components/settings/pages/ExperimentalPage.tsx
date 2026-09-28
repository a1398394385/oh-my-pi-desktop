// 设置页：实验性功能（pg-experimental）。
// 二级分类 1：ACP 上下文压缩（总开关 + 阈值 / 目标线 / 上下文窗口 / 候选建议 / 用户消息保护）
// 二级分类 2：会话与检索（历史会话检索 read_session_context）
// 二级分类 3：缓存保活（pi-kimi-keepalive 桌面移植版，总开关 + 探测参数配置化，omp-desktop.json 随 profile 独立）
// 样式语言与外观页一致：set-page / set-tt / set-group-tt / set-group-desc / set-card / .srow / .tg / .sel / .inp。
import { useEffect, useState, type ReactNode } from "react";
import { useAppStore, send } from "../../../store";
import Icon from "../../../Icon";
import type { AcpConfig } from "../../../types/frames";

const MAX_LIMIT_OPTIONS = ["35%", "45%", "50%", "55%", "60%", "70%", "80%"];
const MIN_LIMIT_OPTIONS = ["25%", "35%", "40%", "45%", "50%", "60%"];

interface SelOption {
  v: string;
  label: ReactNode;
  ck?: string;
}

function Sel({
  label,
  options,
  onPick,
  disabled,
}: {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div
      className={"sel" + (disabled ? " disabled" : "")}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {label} <Icon name="caret" size={14} className="caret-svg" />
      {open && (
        <div className="menu open">
          {options.map((o) => (
            <div
              key={o.v}
              className="mi"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(o.v);
              }}
            >
              <span className="ck">{o.ck ?? ""}</span>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** ms → "8m"/"1h30m"/"45s" 展示（host 侧解析接受同一语法回写） */
function fmtDur(ms: number): string {
  if (ms <= 0) return "0";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec ? `${sec}s` : ""}`;
  return `${sec}s`;
}

/** 缓存保活参数行输入（受控 + onBlur 提交 + 回推真值刷新，照 ACP 上下文窗口输入模式） */
function KaInput({
  value,
  placeholder,
  disabled,
  onSubmit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="srow-ctl">
      <input
        className={"inp" + (disabled ? " disabled" : "")}
        style={{ width: 170 }}
        placeholder={placeholder}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v.trim() !== value) onSubmit(v.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
}

export default function ExperimentalPage() {
  const hostSettings = useAppStore((s) => s.hostSettings);

  const known = typeof hostSettings?.acpEnabled === "boolean";
  const enabled = known && !!hostSettings?.acpEnabled;
  const ctxKnown = typeof hostSettings?.sessionContextEnabled === "boolean";
  const ctxEnabled = ctxKnown && !!hostSettings?.sessionContextEnabled;
  const kaKnown = typeof hostSettings?.keepaliveEnabled === "boolean";
  const kaEnabled = kaKnown && !!hostSettings?.keepaliveEnabled;
  const kaConfig = hostSettings?.keepaliveConfig;
  const kaMode = kaConfig?.mode ?? "default";
  const kaTargets = kaConfig?.targets ?? [];
  const modelCatalog = useAppStore((s) => s.modelCatalog);

  const acpConfig = hostSettings?.acpConfig;
  const maxLimit = acpConfig?.maxContextLimit || "55%";
  const minLimit = acpConfig?.minContextLimit || "45%";
  const candidates = acpConfig?.candidates ?? false;
  const protectUser = acpConfig?.protectUserMessages ?? true;
  const sysPrompt = acpConfig?.systemPrompt ?? false;

  const [cwInput, setCwInput] = useState(acpConfig?.contextWindow || "");
  useEffect(() => {
    setCwInput(acpConfig?.contextWindow || "");
  }, [acpConfig?.contextWindow]);

  const updateAcp = (patch: Partial<AcpConfig>) => {
    send({ type: "set_acp_config", config: patch });
    if (typeof patch.enabled === "boolean") {
      send({ type: "set_acp_enabled", enabled: patch.enabled });
    }
  };

  // 缓存保活参数写回：host 读-合并-写 omp-desktop.json keepalive 段（非法值忽略该字段并回推真值刷新输入框）
  const updateKa = (patch: Record<string, unknown>) => {
    send({ type: "set_keepalive_config", config: patch });
  };

  return (
    <div className="set-page" id="pg-experimental">
      <div className="set-tt">实验性功能</div>

      {/* 二级分类 1：ACP 上下文压缩 */}
      <div className="set-group-tt">ACP 上下文压缩</div>
      <div className="set-group-desc">Active Context Pruning：长对话主动折叠压缩与上下文管理套件。</div>
      <div className="set-card">
        {/* 1. 总开关 */}
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              启用 ACP 上下文压缩
              <span className="srow-wn-inline">!!! 重启应用生效，开关此功能会破坏历史会话的工具列表结构，导致大模型缓存失效</span>
            </b>
            <span>为新建会话注册 compress / decompress / search_context 等上下文管理工具，模型可把长对话区间折叠成可随时还原的摘要块。开关只影响此后打开的会话。</span>
          </div>
          <div
            className={"tg" + (enabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgAcp"
            onClick={() => updateAcp({ enabled: !enabled })}
          >
            <i></i>
          </div>
        </div>

        {/* 2. 开始提醒阈值（软提醒） */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>开始提醒阈值（软提醒）</b>
            <span>上下文用量达到此比例时开始注入温和的效率提醒，提示模型提早折叠已不需要的对话，保持上下文精简。</span>
          </div>
          <Sel
            label={minLimit}
            disabled={!enabled}
            options={MIN_LIMIT_OPTIONS.map((v) => ({
              v,
              label: v === "45%" ? "45%（推荐）" : v,
              ck: minLimit === v ? "✓" : "",
            }))}
            onPick={(v) => updateAcp({ minContextLimit: v })}
          />
        </div>

        {/* 3. 强制压缩阈值（强提醒） */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>强制压缩阈值（强提醒）</b>
            <span>上下文用量达到此上限时触发紧急强警告，要求模型在下一次回复中必须立即执行压缩。</span>
          </div>
          <Sel
            label={maxLimit}
            disabled={!enabled}
            options={MAX_LIMIT_OPTIONS.map((v) => ({
              v,
              label: v === "55%" ? "55%（推荐）" : v,
              ck: maxLimit === v ? "✓" : "",
            }))}
            onPick={(v) => updateAcp({ maxContextLimit: v })}
          />
        </div>

        {/* 4. 上下文窗口容量覆盖 */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>上下文窗口容量覆盖</b>
            <span>固定用于计算用量百分比的上下文窗口大小（如 1M、200K、2000000）。留空则自动取当前模型的上下文窗口大小。</span>
          </div>
          <div className="srow-ctl">
            <input
              className={"inp" + (enabled ? "" : " disabled")}
              style={{ width: 170 }}
              placeholder="自动（模型默认）"
              value={cwInput}
              disabled={!enabled}
              onChange={(e) => setCwInput(e.target.value)}
              onBlur={() => {
                if (cwInput.trim() !== (acpConfig?.contextWindow || "")) {
                  updateAcp({ contextWindow: cwInput.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>

        {/* 5. 候选区间建议 */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>候选区间建议</b>
            <span>在 acp_status 和状态报告中启用微任务/片段级（Micro/Episode）压缩候选区间建议。</span>
          </div>
          <div
            className={"tg" + (candidates ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ candidates: !candidates });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 6. 保护用户提问 */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>保护用户提问</b>
            <span>在模型进行上下文折叠时保护用户原始提问消息，仅允许折叠中间工具调用与过程输出。</span>
          </div>
          <div
            className={"tg" + (protectUser ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ protectUserMessages: !protectUser });
            }}
          >
            <i></i>
          </div>
        </div>

        {/* 7. 系统提示词防复读 */}
        <div className={"srow" + (enabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>系统提示词防复读</b>
            <span>为新建会话追加 ACP 注记说明段：告知模型 &lt;dcp-message-id&gt; 标签是宿主注入的边界元数据，禁止在自己的回复里复读、模仿这些标签与摘要内容。只影响此后创建的会话。</span>
          </div>
          <div
            className={"tg" + (sysPrompt ? " on" : "") + (enabled ? "" : " disabled")}
            onClick={() => {
              if (!enabled) return;
              updateAcp({ systemPrompt: !sysPrompt });
            }}
          >
            <i></i>
          </div>
        </div>
      </div>

      {/* 二级分类 2：会话与检索 */}
      <div className="set-group-tt">会话与检索</div>
      <div className="set-group-desc">会话历史查询与上下文检索工具。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              历史会话检索
              <span className="srow-wn-inline">!!! 重启应用生效，开关此功能会破坏历史会话的工具列表结构，导致大模型缓存失效</span>
            </b>
            <span>为新建会话注册 read_session_context 工具，模型可按字面关键词检索本机已落盘的 Pi 会话历史，并展开命中处的原始对话。开关只影响此后打开的会话。</span>
          </div>
          <div
            className={"tg" + (ctxEnabled ? " on" : "") + (ctxKnown ? "" : " disabled")}
            id="tgSessionContext"
            onClick={() => send({ type: "set_session_context_enabled", enabled: !ctxEnabled })}
          >
            <i></i>
          </div>
        </div>
      </div>

      {/* 二级分类 3：缓存保活 */}
      <div className="set-group-tt">缓存保活</div>
      <div className="set-group-desc">Kimi (kimi-code) 前缀缓存保活探测（pi-kimi-keepalive 桌面移植版），配置存本 profile 的 omp-desktop.json，随 profile 独立。</div>
      <div className="set-card">
        {/* 1. 总开关：本应用是否加载扩展 */}
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              启用缓存保活
              <span className="srow-wn-inline">!!! 重启应用生效，只影响此后创建的会话；探测是真实计费请求，按 cache-read 价计</span>
            </b>
            <span>会话空闲时按配置节奏（默认 8 分钟）把最后一次真实请求原样重放为小型探测调用，保住目标模型的自动前缀缓存不过期。与插件中心/钩子总开关互斥：两者开启时以 ~/.omp/plugins 发现的原版为准，本开关不生效。</span>
          </div>
          <div
            className={"tg" + (kaEnabled ? " on" : "") + (kaKnown ? "" : " disabled")}
            id="tgKeepalive"
            onClick={() => send({ type: "set_keepalive_enabled", enabled: !kaEnabled })}
          >
            <i></i>
          </div>
        </div>

        {/* 2. 保活模型（可多选；空 = 不探测任何模型） */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>保活模型</b>
            <span>选择要保活前缀缓存的模型（可多个，点击已选胶囊移除）。只有会话真的向目标模型发过请求后才开始探测；捕获是单槽的，同一会话内多个目标模型会互相覆盖，建议只选各会话的主模型。</span>
            {kaTargets.length > 0 && (
              <div className="ka-targets">
                {kaTargets.map((id) => {
                  const m = modelCatalog.find((x) => x.id === id);
                  return (
                    <span
                      key={id}
                      className="ka-target"
                      title="点击移除"
                      onClick={() => {
                        if (!kaEnabled) return;
                        updateKa({ targets: kaTargets.filter((t) => t !== id) });
                      }}
                    >
                      {m ? m.name : id}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <Sel
            label="+ 添加模型"
            disabled={!kaEnabled || modelCatalog.filter((m) => !kaTargets.includes(m.id)).length === 0}
            options={modelCatalog
              .filter((m) => !kaTargets.includes(m.id))
              .map((m) => ({ v: m.id, label: m.name, ck: "" }))}
            onPick={(v) => updateKa({ targets: [...kaTargets, v] })}
          />
        </div>

        {/* 3. 探测模式 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>探测模式</b>
            <span>固定节奏：按下方节奏值匀速探测。自适应（smart）：8 分钟起步，连续 3 次命中且上下文 ≤200k 时节奏 +30s 逐步拉长以省探测费，一次未命中即回落并暂停，需重新选择 smart 恢复。</span>
          </div>
          <Sel
            label={kaMode === "smart" ? "自适应" : "固定节奏"}
            disabled={!kaEnabled}
            options={[
              { v: "default", label: "固定节奏", ck: kaMode === "default" ? "✓" : "" },
              { v: "smart", label: "自适应", ck: kaMode === "smart" ? "✓" : "" },
            ]}
            onPick={(v) => updateKa({ mode: v })}
          />
        </div>

        {/* 4. 探测节奏（固定模式生效；smart 自管） */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>探测节奏</b>
            <span>固定模式下的探测间隔，支持 "8m"、"4m30s"、"90s" 写法，最短 30s。自适应模式自行管理节奏，此项禁用。</span>
          </div>
          <KaInput
            value={kaConfig ? fmtDur(kaConfig.intervalMs) : ""}
            placeholder="8m"
            disabled={!kaEnabled || kaMode === "smart"}
            onSubmit={(v) => updateKa({ intervalMs: v })}
          />
        </div>

        {/* 5. 空闲停止时限 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>空闲停止时限</b>
            <span>会话闲置超过此时限后停止探测，避免挂夜空烧配额；填 0 表示永不停止。</span>
          </div>
          <KaInput
            value={kaConfig ? (kaConfig.maxIdleMs === 0 ? "0" : fmtDur(kaConfig.maxIdleMs)) : ""}
            placeholder="1h"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxIdleMs: v })}
          />
        </div>

        {/* 6. 连续未命中暂停 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>连续未命中暂停</b>
            <span>连续 N 次探测未命中前缀缓存后暂停探测（命中即清零）；缓存行为变化时及时止损，下一轮真实请求自动恢复。</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxMissStreak) : ""}
            placeholder="1"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxMissStreak: v })}
          />
        </div>

        {/* 7. 连续失败熔断 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>连续失败熔断</b>
            <span>连续 N 次探测失败（网络错误、HTTP 5xx）后暂停探测；认证失败（401/403）不计数、立即暂停。</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxErrorStreak) : ""}
            placeholder="3"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxErrorStreak: v })}
          />
        </div>

        {/* 8. 会话花费上限 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>会话花费上限（USD）</b>
            <span>单会话探测预估花费达到此值后暂停；按模型定价估算（约每次 = 全上下文 × cache-read 价）。填 0 表示不设上限。</span>
          </div>
          <KaInput
            value={kaConfig ? (kaConfig.spendCapUsd === null ? "0" : String(kaConfig.spendCapUsd)) : ""}
            placeholder="1.0"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ spendCapUsd: v })}
          />
        </div>

        {/* 9. 最小提示 tokens */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>最小提示 tokens</b>
            <span>探测请求的提示小于此 token 数时不算未命中（短上下文本就无缓存收益，避免误熔断）。</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.minPromptTokens) : ""}
            placeholder="512"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ minPromptTokens: v })}
          />
        </div>

        {/* 10. 探测输出上限 */}
        <div className={"srow" + (kaEnabled ? "" : " disabled")}>
          <div className="srow-tx">
            <b>探测输出上限</b>
            <span>探测请求的 max_tokens 钳制值（1..4096）。输出按全价计费，保持小值即可，无需调大。</span>
          </div>
          <KaInput
            value={kaConfig ? String(kaConfig.maxOutputTokens) : ""}
            placeholder="16"
            disabled={!kaEnabled}
            onSubmit={(v) => updateKa({ maxOutputTokens: v })}
          />
        </div>
      </div>
    </div>
  );
}