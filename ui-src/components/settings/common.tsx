// 设置中心公共件：Promise 风格确认弹窗、OMP 登录横幅 / 粘贴码弹窗、空态行、供应商图标映射。
// 平移自 ui/settings/providers.js（confirmDialog / showLoginBanner / showLoginPrompt）与
// ui/settings/index.js 顶部 PROV_IC；弹窗 DOM 语言（.lp-mask/.lp-box/.login-banner）与旧版 1:1。
import { useEffect, useState } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore, setBump, send } from "../../store";
import { t } from "../../i18n";

// 供应商图标映射（原 ui/settings/index.js 顶部 PROV_IC 原样平移）
export const PROV_IC: Record<string, string> = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// 通用二次确认弹窗入参（均带默认值，除 title 外皆可省略）
export interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}

// 通用二次确认弹窗：复用登录粘贴码的 lp-mask/lp-box 弹窗语言，danger 时确认钮走红。
// 返回 Promise<boolean>，点遮罩/取消均视为 false（替代原生 confirm，WKWebView 下观感统一）。
// 命令式 API：每次调用往 document.body 挂一个独立 React root，关闭即卸载（旧版 DOM 直挂的等价物）。
export function confirmDialog({ title, message = "", confirmText, danger = false }: ConfirmDialogProps): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (val: boolean) => {
      root.unmount();
      host.remove();
      resolve(val);
    };
    root.render(
      createElement("div", {
        className: "lp-mask",
        onClick: (e) => { if (e.target === e.currentTarget) done(false); },
      },
        createElement("div", { className: "lp-box" },
          createElement("div", { className: "lp-msg" }, title),
          message ? createElement("div", { className: "cf-msg" }, message) : null,
          createElement("div", { className: "lp-row" },
            createElement("button", { type: "button", className: "save-btn", onClick: () => done(false) }, t("common.cancel")),
            createElement("button", {
              type: "button",
              className: "save-btn" + (danger ? " danger" : ""),
              autoFocus: true,
              onClick: () => done(true),
            }, confirmText ?? t("common.confirm")),
          ),
        ),
      ),
    );
  });
}

// 登录进行中底部进度条：显示状态 + 取消按钮（关浏览器授权页后可手动中断）。
// 数据源 loginBanner selector（store 的 login_progress / login_done 回包落地；null = 隐藏）。
export function LoginBanner() {
  const loginBanner = useAppStore((s) => s.loginBanner);
  if (loginBanner == null) return null;
  return (
    <div className="login-banner" id="loginBanner">
      <span>{loginBanner}</span>
      <button type="button" className="save-btn" onClick={() => send({ type: "provider_login_cancel" })}>
        {t("settingsPage.login.cancelLogin")}
      </button>
    </div>
  );
}

// 登录流程的粘贴码弹窗（host 经 login_prompt 中转）。数据源 loginPromptData selector
// （{ id, message, secret, reqId }）；确定/取消均回 login_prompt_reply（空串 = 取消），
// 遮罩点击仅关闭弹窗——host 侧流程仍等输入（旧版语义保留）。
export function LoginPrompt() {
  const msg = useAppStore((s) => s.loginPromptData); // 回包负载，形状见 LoginPromptFrame
  const [text, setText] = useState("");
  // 每次新弹窗（id 变化）清空输入框
  useEffect(() => { setText(""); }, [msg?.id]);
  if (!msg) return null;
  const close = () => { setBump({ loginPromptData: null }); };
  const reply = (t: string) => {
    send({ type: "login_prompt_reply", id: msg.id, text: t });
    close();
  };
  return (
    <div
      className="lp-mask"
      id="loginPromptMask"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => { if (e.key === "Enter") reply(text); }}
    >
      <div className="lp-box">
        <div className="lp-msg">{msg.message || t("settingsPage.login.authPrompt")}</div>
        <input
          className="inp"
          type={msg.secret ? "password" : "text"}
          placeholder={t("settingsPage.login.authPlaceholder")}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <div className="lp-row">
          <button type="button" className="save-btn" onClick={() => reply(text)}>{t("common.confirm")}</button>
          <button type="button" className="save-btn" onClick={() => reply("")}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// 空态行：设置卡片列表（agents / commands / hooks 等）的加载中与空数据占位。
// 默认 srow 行形态（<div class="srow"><div class="srow-tx"><span>…）；MCP / 技能页传
// cls="mcp-empty-row" / "skill-empty-row" 覆盖为旧版对应空态类。
export function emptyRow(text: string, cls?: string) {
  if (cls) return <div className={cls}><span>{text}</span></div>;
  return <div className="srow"><div className="srow-tx"><span>{text}</span></div></div>;
}
