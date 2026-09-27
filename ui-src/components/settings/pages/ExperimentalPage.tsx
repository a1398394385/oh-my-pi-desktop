// 设置页：实验性功能（pg-experimental）。
// 二级分类 1：ACP 上下文压缩（总开关 + 阈值 / 目标线 / 上下文窗口 / 候选建议 / 用户消息保护）
// 二级分类 2：会话与检索（历史会话检索 read_session_context）
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

export default function ExperimentalPage() {
  const hostSettings = useAppStore((s) => s.hostSettings);

  const known = typeof hostSettings?.acpEnabled === "boolean";
  const enabled = known && !!hostSettings?.acpEnabled;
  const ctxKnown = typeof hostSettings?.sessionContextEnabled === "boolean";
  const ctxEnabled = ctxKnown && !!hostSettings?.sessionContextEnabled;

  const acpConfig = hostSettings?.acpConfig;
  const maxLimit = acpConfig?.maxContextLimit || "55%";
  const minLimit = acpConfig?.minContextLimit || "45%";
  const candidates = acpConfig?.candidates ?? false;
  const protectUser = acpConfig?.protectUserMessages ?? true;

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
    </div>
  );
}