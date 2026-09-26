// 设置页：常规（pg-general）。Profile 切换 / 界面语言 / 主题 / 网络环境变量 / 更新与行为。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-general">，
// 绑定参照 ui/settings/index.js 的 initSettings / applyHostSettings / saveDesktopField。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import type { DesktopEnv } from "../../../types/frames";

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
    toast(next ? "已开启终端环境继承（下次新建终端生效）" : "已关闭终端环境继承（下次新建终端生效）");
  };
  const saveTerminalFont = () => {
    const f = terminalFont.trim();
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalFont: f },
    }));
    saveUiPrefs();
    toast(f ? `终端字体已保存：${f}` : "已恢复默认终端字体栈");
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
    toast(`提问超时时间已保存：${secs} 秒${secs === 0 ? "（永不超时）" : ""}`);
  };

  // ---------- Profile 下拉数据（数据契约：hostSettings.availableProfiles: string[]） ----------
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
      </div>
      <div className="set-group-tt">终端</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>继承系统终端 Profile</b>
            <span>启动内置终端时作为登录 Shell 运行，自动加载 ~/.zprofile、PATH 等系统与用户登录环境。</span>
          </div>
          <div className={"tg" + (terminalInherit ? " on" : "")} id="tgTerminalInherit" onClick={toggleTerminalInherit}>
            <i></i>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b>终端字体</b>
            <span>右栏内置终端的等宽字体家族。留空则使用默认等宽字体栈。</span>
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
            <button className="save-btn" id="termFontSave" onClick={saveTerminalFont}>保存</button>
          </div>
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
      <div className="set-group-tt">行为与交互</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>提问超时时间</b><span>omp ask.timeout：提问无人响应 N 秒后自动选择推荐项；0 = 永不超时（默认）。</span></div>
          <div className="srow-ctl">
            <input className="inp" id="askTimeoutInput" type="number" min="0" step="1" placeholder="0" value={askTimeout} ref={askRef}
              onChange={(e) => setAskTimeout(e.target.value)} />
            <button className="save-btn" id="askTimeoutSave" onClick={saveAskTimeout}>保存</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>显示思考过程</b><span>在消息流中展示模型的思考内容。对应 omp hideThinkingBlock。</span></div>
          <div className={"tg" + (showThinking ? " on" : "")} id="tgThinking" onClick={toggleThinking}><i></i></div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-general"]} />
    </div>
  );
}
