// 设置页：常规（pg-general）。Profile 切换 / 界面语言 / 主题 / 网络环境变量 / 更新与行为。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-general">，
// 绑定参照 ui/settings/index.js 的 initSettings / applyHostSettings / saveDesktopField。
import { useEffect, useRef, useState } from "react";
import { S, useStore, send, toast, uiPrefs } from "../../../store.js";
import Icon from "../../../Icon.jsx";

// ---------- 主题（旧版 shell.js applyTheme 的等价物；General 与 Appearance 各持一份） ----------
const themeMq = window.matchMedia("(prefers-color-scheme: dark)");
function currentThemeMode() {
  try { return localStorage.getItem("omp-theme") || "dark"; } catch { return "dark"; }
}
function applyTheme(mode) {
  const dark = mode === "system" ? themeMq.matches : mode === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("omp-theme", mode); } catch {}
}
function themeLabel(mode) {
  return mode === "system" ? "◐ 跟随系统" : mode === "light" ? "☀️ 浅色" : "🌙 深色";
}
function genThemeLabel(mode) {
  return mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色";
}

// 本地偏好落盘（旧版 saveUiPrefs）
function saveUiPrefs() {
  try { localStorage.setItem("omp-ui-settings", JSON.stringify(uiPrefs)); } catch {}
}
// 外观应用（旧版 applyAppearance：字号/字体/行号/换行/思考块 data 属性）
const FONT_STACKS = {
  default: "var(--sans)",
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}

// ---------- 下拉选择器：旧版 wireSel 的受控等价物（.sel/.menu/.mi 结构 1:1） ----------
function Sel({ label, options, onPick }) {
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
      {label} <Icon name="caret" className="caret-svg" />
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
  useStore(); // 订阅 S.hostSettings / uiPrefs 相关回包
  const hs = S.hostSettings;
  const env = hs?.desktopEnv || {};

  // ---------- 本地表单态 ----------
  const proxyRef = useRef(null);
  const noProxyRef = useRef(null);
  const caRef = useRef(null);
  const askRef = useRef(null);
  const [proxy, setProxy] = useState(env.httpProxy || "");
  const [noProxy, setNoProxy] = useState(env.noProxy || "");
  const [ca, setCa] = useState(env.caCerts || "");
  const [askTimeout, setAskTimeout] = useState(hs?.askTimeout ? String(hs.askTimeout) : "");
  // host 设置回包后回填（输入框聚焦时不打扰，对应旧版 applyHostSettings 的 fill 守卫）
  useEffect(() => {
    const e2 = S.hostSettings?.desktopEnv || {};
    if (document.activeElement !== proxyRef.current) setProxy(e2.httpProxy || "");
    if (document.activeElement !== noProxyRef.current) setNoProxy(e2.noProxy || "");
    if (document.activeElement !== caRef.current) setCa(e2.caCerts || "");
    if (document.activeElement !== askRef.current) {
      setAskTimeout(S.hostSettings?.askTimeout ? String(S.hostSettings.askTimeout) : "");
    }
  }, [hs]);
  const [theme, setTheme] = useState(currentThemeMode());
  const [showThinking, setShowThinking] = useState(!!uiPrefs.showThinking);
  const [sleepOn, setSleepOn] = useState(!!(hs?.sleepPrevention && hs.sleepPrevention !== "off"));
  useEffect(() => {
    setSleepOn(!!(S.hostSettings?.sleepPrevention && S.hostSettings.sleepPrevention !== "off"));
  }, [hs]);

  // ---------- 交互 ----------
  const switchProfile = (name) => {
    const target = String(name || "").trim();
    if (!target) return;
    toast(`正在切换至 Profile: ${target}…`);
    send({ type: "switch_profile", profile: target });
  };
  const newProfile = () => {
    const input = window.prompt("请输入新 Profile 名称（仅支持小写字母、数字、短横线、下划线）：");
    if (!input) return;
    const name = input.trim();
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      toast("Profile 名称不合法：仅支持字母、数字、点、短横线、下划线");
      return;
    }
    switchProfile(name);
  };
  const pickTheme = (mode) => {
    setTheme(mode);
    applyTheme(mode);
    // 旧版只写本地；此处同步通知宿主持久化
    send({ type: "set_setting", key: "appearance.theme", value: mode });
  };
  const toggleThinking = () => {
    const on = !showThinking;
    setShowThinking(on);
    uiPrefs.showThinking = on;
    saveUiPrefs();
    applyAppearance();
    send({ type: "set_setting", key: "hideThinkingBlock", value: !on });
  };
  const toggleSleep = () => {
    const on = !sleepOn;
    setSleepOn(on);
    send({ type: "set_setting", key: "power.sleepPrevention", value: on ? "system" : "off" });
  };
  // 网络三件套：整包发送 desktopEnv（旧版 saveDesktopField 语义）
  const saveEnv = (field, val) => {
    const merged = { httpProxy: proxy, noProxy: noProxy, caCerts: ca, [field]: val };
    send({ type: "set_desktop_env", ...merged });
  };
  const saveAskTimeout = () => {
    const raw = parseFloat(askTimeout);
    const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    send({ type: "set_setting", key: "ask.timeout", value: secs });
    toast(`提问超时时间已保存：${secs} 秒${secs === 0 ? "（永不超时）" : ""}`);
  };

  // ---------- Profile 下拉数据（数据契约：S.hostSettings.availableProfiles: string[]） ----------
  const activeProfile = hs?.activeProfile || "omp-desktop";
  const profiles = Array.isArray(hs?.availableProfiles) && hs.availableProfiles.length
    ? hs.availableProfiles
    : [activeProfile];
  const profileDesc = hs?.profileAgentDir
    ? `当前目录: ${hs.profileAgentDir}`
    : "切换不同的底座 Profile（隔离会话、模型、认证与扩展）。";

  return (
    <div className="set-page" id="pg-general">
      <div className="set-tt">常规 <span className="stag" id="langTag">简体中文</span></div>
      <div className="set-group-tt">Profile 环境</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>当前 Profile</b><span id="profilePathDesc">{profileDesc}</span></div>
          <div className="srow-ctl" style={{ gap: 8 }}>
            <Sel
              label={activeProfile}
              options={profiles.map((p) => ({
                v: p,
                label: p === "default" ? "default (全局默认)" : p,
                ck: p === activeProfile ? "✓" : "",
              }))}
              onPick={(p) => { if (p !== activeProfile) switchProfile(p); }}
            />
            <button className="save-btn" id="newProfileBtn" title="新建并切换到新 Profile" onClick={newProfile}>+ 新建</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">应用</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>界面语言</b><span>选择应用 UI 的显示语言。目前仅提供简体中文。</span></div>
          <Sel
            label="简体中文"
            options={[
              { v: "zh-CN", label: "简体中文", ck: "✓" },
              { v: "zh-TW", label: "繁體中文", disabled: true, sub: "未实现" },
              { v: "en", label: "English", disabled: true, sub: "未实现" },
            ]}
            onPick={() => {}}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>主题</b><span>界面设置（深色 / 浅色 / 系统）。</span></div>
          <Sel
            label={genThemeLabel(theme)}
            options={[
              { v: "dark", label: "🌙 深色", ck: theme === "dark" ? "✓" : "" },
              { v: "light", label: "☀️ 浅色", ck: theme === "light" ? "✓" : "" },
              { v: "system", label: "◐ 跟随系统", ck: theme === "system" ? "✓" : "" },
            ]}
            onPick={pickTheme}
          />
        </div>
      </div>
      <div className="set-group-tt">终端</div>
      <div className="set-card">
        <div className="srow unavailable">
          <div className="srow-tx"><b>继承系统终端 Profile</b><span>当前应用没有内置终端面板，无法继承登录 shell 环境。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>终端字体</b><span>无内置终端，字体覆盖无对象。</span></div>
          <div className="srow-ctl"><span className="inp disabled">不可用</span></div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>增强 Find 和 Grep</b><span>ZCode 自带 bfs/ugrep 增强；omp 没有对等产品开关。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
      </div>
      <div className="set-group-tt">网络</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>HTTP 代理</b><span>写入宿主环境变量 HTTP(S)_PROXY。留空则直连。修改后建议重启应用。</span></div>
          <div className="srow-ctl">
            <input className="inp" id="proxyInput" placeholder="例如 http://127.0.0.1:7890" value={proxy} ref={proxyRef}
              onChange={(e) => setProxy(e.target.value)} />
            <button className="save-btn" id="proxySave" onClick={() => saveEnv("httpProxy", proxy.trim())}>保存</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>不使用代理的地址</b><span>NO_PROXY，多个规则用英文逗号分隔。</span></div>
          <div className="srow-ctl">
            <input className="inp" id="noProxyInput" placeholder="localhost,127.0.0.1,::1" value={noProxy} ref={noProxyRef}
              onChange={(e) => setNoProxy(e.target.value)} />
            <button className="save-btn" id="noProxySave" onClick={() => saveEnv("noProxy", noProxy.trim())}>保存</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>自定义证书</b><span>PEM 根证书路径，注入 NODE_EXTRA_CA_CERTS。</span></div>
          <div className="srow-ctl">
            <input className="inp" id="caInput" placeholder="例如 /Users/name/certs/root-ca.pem" value={ca} ref={caRef}
              onChange={(e) => setCa(e.target.value)} />
            <button className="save-btn" id="caSave" onClick={() => saveEnv("caCerts", ca.trim())}>保存</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">更新与行为</div>
      <div className="set-card">
        <div className="srow unavailable">
          <div className="srow-tx"><b>Chrome 硬件加速</b><span>Tauri WKWebView 没有对等开关。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>接受提前收到预览版更新</b><span>本应用未接入自动更新通道。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>自动下载并安装更新</b><span>本应用未接入自动更新通道。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>保持电脑运行</b><span>任务执行期间用 caffeinate 阻止系统睡眠（macOS）。</span></div>
          <div className={"tg" + (sleepOn ? " on" : "")} id="tgSleep" onClick={toggleSleep}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>提问超时时间</b><span>omp ask.timeout：提问无人响应 N 秒后自动选择推荐项；0 = 永不超时（默认）。</span></div>
          <div className="srow-ctl">
            <input className="inp" id="askTimeoutInput" type="number" min="0" step="1" placeholder="0" value={askTimeout} ref={askRef}
              onChange={(e) => setAskTimeout(e.target.value)} />
            <button className="save-btn" id="askTimeoutSave" onClick={saveAskTimeout}>保存</button>
          </div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>完整保留模型 I/O</b><span>会话已以 JSONL 落盘，没有单独的完整 I/O 审计开关。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>显示思考过程</b><span>在消息流中展示模型的思考内容。对应 omp hideThinkingBlock。</span></div>
          <div className={"tg" + (showThinking ? " on" : "")} id="tgThinking" onClick={toggleThinking}><i></i></div>
        </div>
      </div>
    </div>
  );
}
