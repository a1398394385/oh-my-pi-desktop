// 设置页：常规（pg-general）。Profile 切换 / 界面语言 / 主题 / 网络环境变量 / 更新与行为。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-general">，
// 绑定参照 ui/settings/index.js 的 initSettings / applyHostSettings / saveDesktopField。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import i18next, { type AppLang } from "../../../i18n";
import { invoke } from "../../../store/ws";
import type { DesktopEnv } from "../../../types/frames";

// Native names for the language badge and picker labels (never translated)
const LANG_NATIVE: Record<AppLang, string> = { "zh-CN": "简体中文", en: "English" };

// 下拉选项（旧版 .mi 一一对应；ck/sub/disabled 均可选）
interface SelOption {
  v: string;
  label: ReactNode;
  ck?: string;
  sub?: string;
  disabled?: boolean;
}

// Sel 下拉选择器 props
interface SelProps {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
}

// 本地偏好落盘（旧版 saveUiPrefs；读 store 真实引用序列化，勿用 liveRef——其枚举不转发）
function saveUiPrefs() {
  try { localStorage.setItem("omp-ui-settings", JSON.stringify(useAppStore.getState().uiPrefs)); } catch {}
}
// 外观应用（旧版 applyAppearance：字号/字体/行号/换行/思考块 data 属性）
const FONT_STACKS: Record<string, string> = {
  default: "var(--sans)",
  zcode: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
function applyAppearance() {
  const p = useAppStore.getState().uiPrefs;
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", p.uiFontSize + "px");
  root.style.setProperty("--code-fs", p.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[p.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = p.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = p.codeWrap ? "on" : "off";
  root.dataset.showThinking = p.showThinking ? "on" : "off";
}

// ---------- 下拉选择器：旧版 wireSel 的受控等价物（.sel/.menu/.mi 结构 1:1） ----------
function Sel({ label, options, onPick }: SelProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <div
      className="sel"
      data-sel={label}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {label} <Icon name="caret" size={14} className="caret-svg" />
      <div className={"menu" + (open ? " open" : "")}>
        {options.map((o) => (
          <div
            key={o.v}
            className={"mi" + (o.disabled ? " disabled" : "")}
            onClick={(e) => {
              e.stopPropagation();
              if (o.disabled) return;
              setOpen(false);
              onPick(o.v);
            }}
          >
            {o.ck !== undefined && <span className="ck">{o.ck}</span>}
            {o.label}
            {o.sub && <span className="sub">{o.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GeneralPage() {
  const hs = useAppStore((s) => s.hostSettings); // selector 订阅回包刷新
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const env: DesktopEnv = hs?.desktopEnv ?? { httpProxy: "", noProxy: "", caCerts: "" }; // 首帧前兜底,同原版 {} 语义

  // ---------- 本地表单态 ----------
  const proxyRef = useRef<HTMLInputElement>(null);
  const noProxyRef = useRef<HTMLInputElement>(null);
  const caRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [proxy, setProxy] = useState(env.httpProxy || "");
  const [noProxy, setNoProxy] = useState(env.noProxy || "");
  const [ca, setCa] = useState(env.caCerts || "");
  const [askTimeout, setAskTimeout] = useState(hs?.values?.["ask.timeout"] ? String(hs.values["ask.timeout"]) : "");
  // host 设置回包后回填（输入框聚焦时不打扰，对应旧版 applyHostSettings 的 fill 守卫）
  useEffect(() => {
    const e2: DesktopEnv = hs?.desktopEnv ?? { httpProxy: "", noProxy: "", caCerts: "" };
    if (document.activeElement !== proxyRef.current) setProxy(e2.httpProxy || "");
    if (document.activeElement !== noProxyRef.current) setNoProxy(e2.noProxy || "");
    if (document.activeElement !== caRef.current) setCa(e2.caCerts || "");
    if (document.activeElement !== askRef.current) {
      setAskTimeout(hs?.values?.["ask.timeout"] ? String(hs.values["ask.timeout"]) : "");
    }
  }, [hs]);
  const [showThinking, setShowThinking] = useState(!!useAppStore.getState().uiPrefs.showThinking);
  const [terminalInherit, setTerminalInherit] = useState(
    useAppStore.getState().uiPrefs.terminalInheritProfile !== false
  );
  const [terminalFont, setTerminalFont] = useState(
    useAppStore.getState().uiPrefs.terminalFont || ""
  );
  const termFontRef = useRef<HTMLInputElement>(null);

  // ---------- 交互 ----------
  const switchProfile = (name: string) => {
    const target = String(name || "").trim();
    if (!target) return;
    toast(t("settingsPage.general.switchingProfile", { name: target }));
    send({ type: "switch_profile", profile: target });
    // Re-send the locale after a profile switch: the host re-reads the new
    // profile's config on switch, so push the frontend's language preference
    // again to keep the host aligned. WS is ordered — set_locale lands after
    // the switch_profile handling.
    send({ type: "set_locale", lang: useAppStore.getState().uiPrefs.lang });
  };
  const newProfile = () => {
    const input = window.prompt(t("settingsPage.general.newProfilePrompt"));
    if (!input) return;
    const name = input.trim();
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      toast(t("settingsPage.general.profileNameInvalid"));
      return;
    }
    switchProfile(name);
  };
  const toggleThinking = () => {
    const on = !showThinking;
    setShowThinking(on);
    // uiPrefs 换新对象写入 + bump（等价旧 mutate + 本地 setState 驱动的可见性）
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, showThinking: on } }));
    saveUiPrefs();
    applyAppearance();
    send({ type: "set_setting", key: "hideThinkingBlock", value: !on });
  };
  const toggleTerminalInherit = () => {
    const next = !terminalInherit;
    setTerminalInherit(next);
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalInheritProfile: next },
    }));
    saveUiPrefs();
    toast(next ? t("settingsPage.general.terminalInheritOn") : t("settingsPage.general.terminalInheritOff"));
  };
  const saveTerminalFont = () => {
    const f = terminalFont.trim();
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalFont: f },
    }));
    saveUiPrefs();
    toast(f ? t("settingsPage.general.terminalFontSaved", { font: f }) : t("settingsPage.general.terminalFontReset"));
  };
  // Language switch: persist to uiPrefs, switch i18next, notify the host.
  // <App key={lang}> in main.tsx re-mounts the tree, so the new locale applies
  // immediately without a restart. zh-TW stays a disabled placeholder.
  const pickLang = (v: string) => {
    if (v !== "zh-CN" && v !== "en") return;
    if (v === useAppStore.getState().uiPrefs.lang) return;
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, lang: v } }));
    saveUiPrefs();
    void i18next.changeLanguage(v);
    send({ type: "set_locale", lang: v });
    // Rebuild the native menu with the new locale (no-op outside Tauri).
    invoke?.("set_menu_language", { lang: v })?.catch((err: unknown) =>
      console.warn("set_menu_language:", err),
    );
  };
  // 网络三件套：整包发送 desktopEnv（旧版 saveDesktopField 语义）
  const saveEnv = (field: string, val: string) => {
    const merged = { httpProxy: proxy, noProxy: noProxy, caCerts: ca, [field]: val };
    send({ type: "set_desktop_env", ...merged });
  };
  const saveAskTimeout = () => {
    const raw = parseFloat(askTimeout);
    const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    send({ type: "set_setting", key: "ask.timeout", value: secs });
    toast(t("settingsPage.general.askTimeoutSaved", { secs, suffix: secs === 0 ? t("settingsPage.general.neverTimeout") : "" }));
  };

  // ---------- Profile 下拉数据（数据契约：hostSettings.availableProfiles: string[]） ----------
  const activeProfile = hs?.activeProfile || "default";
  const profiles = Array.isArray(hs?.availableProfiles) && hs.availableProfiles.length
    ? hs.availableProfiles
    : [activeProfile];
  const profileDesc = hs?.profileAgentDir
    ? t("settingsPage.general.profileDescDir", { dir: hs.profileAgentDir })
    : t("settingsPage.general.profileDescDefault");

  return (
    <div className="set-page" id="pg-general">
      <div className="set-tt">{t("settingsPage.nav.general")} <span className="stag" id="langTag">{LANG_NATIVE[lang]}</span></div>
      <div className="set-group-tt">{t("settingsPage.general.groupProfile")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.currentProfile")}</b><span id="profilePathDesc">{profileDesc}</span></div>
          <div className="srow-ctl" style={{ gap: 8 }}>
            <Sel
              label={activeProfile}
              options={profiles.map((p) => ({
                v: p,
                label: p === "default" ? t("settingsPage.general.profileDefaultEntry") : p,
                ck: p === activeProfile ? "✓" : "",
              }))}
              onPick={(p) => { if (p !== activeProfile) switchProfile(p); }}
            />
            <button className="save-btn" id="newProfileBtn" title={t("settingsPage.general.newProfileTitle")} onClick={newProfile}>{t("settingsPage.general.newProfileBtn")}</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupApp")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("common.languageLabel")}</b><span>{t("settingsPage.general.langDesc")}</span></div>
          <Sel
            label={LANG_NATIVE[lang]}
            options={[
              { v: "zh-CN", label: "简体中文", ck: lang === "zh-CN" ? "✓" : "" },
              { v: "zh-TW", label: "繁體中文", disabled: true, sub: t("settingsPage.general.zhTwPending") },
              { v: "en", label: "English", ck: lang === "en" ? "✓" : "" },
            ]}
            onPick={pickLang}
          />
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupTerminal")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.general.terminalInheritTitle")}</b>
            <span>{t("settingsPage.general.terminalInheritDesc")}</span>
          </div>
          <div className={"tg" + (terminalInherit ? " on" : "")} id="tgTerminalInherit" onClick={toggleTerminalInherit}>
            <i></i>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.general.terminalFontTitle")}</b>
            <span>{t("settingsPage.general.terminalFontDesc")}</span>
          </div>
          <div className="srow-ctl">
            <input
              className="inp"
              id="termFontInput"
              placeholder='ui-monospace, "SF Mono", Menlo, monospace'
              value={terminalFont}
              ref={termFontRef}
              onChange={(e) => setTerminalFont(e.target.value)}
            />
            <button className="save-btn" id="termFontSave" onClick={saveTerminalFont}>{t("common.save")}</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupNetwork")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.httpProxyTitle")}</b><span>{t("settingsPage.general.httpProxyDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="proxyInput" placeholder={t("settingsPage.general.httpProxyPlaceholder")} value={proxy} ref={proxyRef}
              onChange={(e) => setProxy(e.target.value)} />
            <button className="save-btn" id="proxySave" onClick={() => saveEnv("httpProxy", proxy.trim())}>{t("common.save")}</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.noProxyTitle")}</b><span>{t("settingsPage.general.noProxyDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="noProxyInput" placeholder="localhost,127.0.0.1,::1" value={noProxy} ref={noProxyRef}
              onChange={(e) => setNoProxy(e.target.value)} />
            <button className="save-btn" id="noProxySave" onClick={() => saveEnv("noProxy", noProxy.trim())}>{t("common.save")}</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.caTitle")}</b><span>{t("settingsPage.general.caDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="caInput" placeholder={t("settingsPage.general.caPlaceholder")} value={ca} ref={caRef}
              onChange={(e) => setCa(e.target.value)} />
            <button className="save-btn" id="caSave" onClick={() => saveEnv("caCerts", ca.trim())}>{t("common.save")}</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupBehavior")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.askTimeoutTitle")}</b><span>{t("settingsPage.general.askTimeoutDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="askTimeoutInput" type="number" min="0" step="1" placeholder="0" value={askTimeout} ref={askRef}
              onChange={(e) => setAskTimeout(e.target.value)} />
            <button className="save-btn" id="askTimeoutSave" onClick={saveAskTimeout}>{t("common.save")}</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.showThinkingTitle")}</b><span>{t("settingsPage.general.showThinkingDesc")}</span></div>
          <div className={"tg" + (showThinking ? " on" : "")} id="tgThinking" onClick={toggleThinking}><i></i></div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-general"]} />
    </div>
  );
}
