// Settings hub shared pieces: Promise-style confirm dialog, OMP login banner / paste-code
// dialog, empty-state row, provider icon map.
// Ported from ui/settings/providers.js (confirmDialog / showLoginBanner / showLoginPrompt)
// and PROV_IC at the top of ui/settings/index.js; dialog DOM language (.lp-mask/.lp-box/
// .login-banner) is 1:1 with the old version.
import { useEffect, useState } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore, setBump, send } from "../../store";
import { t } from "../../i18n";

// Provider icon map (ported verbatim from PROV_IC at the top of ui/settings/index.js)
export const PROV_IC: Record<string, string> = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// Props of the generic confirm dialog (all optional except title, all with defaults)
export interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}

// Generic confirm dialog: reuses the login paste-code lp-mask/lp-box dialog language; the
// confirm button turns red on danger. Returns Promise<boolean>; clicking the mask or cancel
// resolves false (replaces native confirm, consistent look under WKWebView).
// Imperative API: each call mounts an independent React root on document.body and unmounts
// on close (equivalent of the old version's direct DOM mounting).
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

// Bottom progress bar while login is in flight: status + cancel button (manual interrupt
// after closing the browser auth page).
// Data source: loginBanner selector (store handles login_progress / login_done replies; null = hidden).
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

// Paste-code dialog of the login flow (host relays via login_prompt). Data source:
// loginPromptData selector ({ id, message, secret, reqId }); both confirm and cancel reply
// login_prompt_reply (empty string = cancel); mask click only closes the dialog — the host
// side still waits for input (old semantics preserved).
export function LoginPrompt() {
  const msg = useAppStore((s) => s.loginPromptData); // reply payload, shape see LoginPromptFrame
  const [text, setText] = useState("");
  // Clear the input on each new dialog (id change)
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

// Empty-state row: loading and empty-data placeholder for settings card lists
// (agents / commands / hooks etc.).
// Default srow row shape (<div class="srow"><div class="srow-tx"><span>…); MCP / skills
// pages pass cls="mcp-empty-row" / "skill-empty-row" to override with the old empty-state classes.
export function emptyRow(text: string, cls?: string) {
  if (cls) return <div className={cls}><span>{text}</span></div>;
  return <div className="srow"><div className="srow-tx"><span>{text}</span></div></div>;
}
