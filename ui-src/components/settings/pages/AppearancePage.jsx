// 设置页：外观（pg-appearance）。界面主题/字体/字号、代码主题/行号/换行/字号、双主题代码预览。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-appearance">，
// 绑定参照 ui/settings/index.js 的 initSettings（themeSel/fontSel/num-ctl/tgLineNo/tgWrap）。
import { useEffect, useState } from "react";
import { S, useStore, send, toast, uiPrefs } from "../../../store.js";
import Icon from "../../../Icon.jsx";
import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

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

// ---------- 减弱动态效果（omp-motion：system 跟随系统 / on 强制减弱 / off 强制动画） ----------
function currentMotionMode() {
  try { return localStorage.getItem("omp-motion") || "system"; } catch { return "system"; }
}
function applyMotion(mode) {
  // system 时移除属性回落 media query；on/off 由 html[data-motion] 强制规则接管
  if (mode === "system") delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = mode;
  try { localStorage.setItem("omp-motion", mode); } catch {}
}
function themeLabel(mode) {
  return mode === "system" ? "◐ 跟随系统" : mode === "light" ? "☀️ 浅色" : "🌙 深色";
}

// 本地偏好落盘（旧版 saveUiPrefs）+ 外观应用（旧版 applyAppearance）
const FONT_STACKS = {
  default: "var(--sans)",
  zcode: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  songti: '"Songti SC", "STSong", "SimSun", serif',
  kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  heiti: '"Heiti SC", "SimHei", "STHeiti", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const FONT_LABELS = { default: "系统默认", zcode: "ZCode 默认", pingfang: "苹方 / PingFang SC", songti: "宋体 / Songti SC", kaiti: "楷体 / KaiTi SC", heiti: "黑体 / Heiti SC", mono: "等宽" };
function saveUiPrefs() {
  try { localStorage.setItem("omp-ui-settings", JSON.stringify(uiPrefs)); } catch {}
}
function applyAppearance() {
  const root = document.documentElement;
  root.style.setProperty("--ui-fs", uiPrefs.uiFontSize + "px");
  root.style.setProperty("--code-fs", uiPrefs.codeFontSize + "px");
  root.style.setProperty("--ui-font", FONT_STACKS[uiPrefs.uiFont] || "var(--sans)");
  root.dataset.lineNumbers = uiPrefs.lineNumbers ? "on" : "off";
  root.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  root.dataset.showThinking = uiPrefs.showThinking ? "on" : "off";
}

// ---------- 下拉选择器：旧版 wireSel 的受控等价物 ----------
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

// 字号步进（旧版 stepFont： clamp -> save -> apply）
function stepFont(key, delta, min, max) {
  uiPrefs[key] = Math.min(max, Math.max(min, uiPrefs[key] + delta));
  saveUiPrefs();
  applyAppearance();
}

export default function AppearancePage() {
  useStore();
  void S; // 主题回包等全局帧统一经 useStore 触发重渲染

  const [theme, setTheme] = useState(currentThemeMode());
  const [font, setFont] = useState(uiPrefs.uiFont || "default");
  const [uiFs, setUiFs] = useState(uiPrefs.uiFontSize);
  const [codeFs, setCodeFs] = useState(uiPrefs.codeFontSize);
  const [lineNo, setLineNo] = useState(!!uiPrefs.lineNumbers);
  const [wrap, setWrap] = useState(!!uiPrefs.codeWrap);
  // 预览卡「当前生效」标签跟随实际明暗（dataset.theme 是全局唯一事实来源）
  const [dark, setDark] = useState(document.documentElement.dataset.theme !== "light");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setDark(document.documentElement.dataset.theme !== "light");
    mq.addEventListener("change", sync);
    const timer = setInterval(sync, 1000); // dataset.theme 变化无事件，低成本轮询兜底
    return () => {
      mq.removeEventListener("change", sync);
      clearInterval(timer);
    };
  }, []);

  const pickTheme = (mode) => {
    setTheme(mode);
    applyTheme(mode);
    send({ type: "set_setting", key: "appearance.theme", value: mode });
  };
  const pickFont = (f) => {
    setFont(f);
    uiPrefs.uiFont = f;
    saveUiPrefs();
    applyAppearance();
  };
  const [motion, setMotion] = useState(currentMotionMode());
  const pickMotion = (mode) => {
    setMotion(mode);
    applyMotion(mode);
  };
  const toggleLineNo = () => {
    const on = !lineNo;
    setLineNo(on);
    uiPrefs.lineNumbers = on;
    saveUiPrefs();
    applyAppearance();
  };
  const toggleWrap = () => {
    const on = !wrap;
    setWrap(on);
    uiPrefs.codeWrap = on;
    saveUiPrefs();
    applyAppearance();
  };
  // 字号步进（范围沿用旧版 settings/index.js 的 clamp：界面 11-18、代码 10-18）
  const stepUiFs = (d) => {
    stepFont("uiFontSize", d, 11, 18);
    setUiFs(uiPrefs.uiFontSize);
  };
  const stepCodeFs = (d) => {
    stepFont("codeFontSize", d, 10, 18);
    setCodeFs(uiPrefs.codeFontSize);
  };

  return (
    <div className="set-page" id="pg-appearance">
      <div className="set-tt">外观</div>
      <div className="set-group-tt">界面设置</div>
      <div className="set-group-desc">设置应用主题和界面文字大小。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>界面主题</b><span>选择浅色、深色或跟随系统主题。</span></div>
          <Sel
            label={themeLabel(theme)}
            options={[
              { v: "dark", label: "🌙 深色", ck: theme === "dark" ? "✓" : "" },
              { v: "light", label: "☀️ 浅色", ck: theme === "light" ? "✓" : "" },
              { v: "system", label: "◐ 跟随系统", ck: theme === "system" ? "✓" : "" },
            ]}
            onPick={pickTheme}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>字体样式</b><span>全局字体族（代码块与 Git Diff 内容除外）；指定字体不可用时回退系统默认。</span></div>
          <Sel
            label={FONT_LABELS[font] || "系统默认"}
            options={Object.entries(FONT_LABELS).map(([v, label]) => ({ v, label, ck: v === font ? "✓" : "" }))}
            onPick={pickFont}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>字体大小</b><span>调整全局文字大小（代码块与 Git Diff 内容除外）。</span></div>
          <div className="num-ctl">
            <button type="button" className="num-btn" id="uiFsMinus" onClick={() => stepUiFs(-1)}>−</button>
            <div className="num" id="uiFsVal">{uiFs} <i>px</i></div>
            <button type="button" className="num-btn" id="uiFsPlus" onClick={() => stepUiFs(1)}>+</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>减弱动态效果</b><span>跟随系统的减弱动态设置，或强制开启 / 关闭应用内动画减弱（当前影响加载转圈）。</span></div>
          <div className="mcp-type-pills">
            {[["system", "跟随系统"], ["on", "开启"], ["off", "关闭"]].map(([v, label]) => (
              <button
                type="button"
                key={v}
                className={"mcp-type-pill" + (motion === v ? " on" : "")}
                onClick={() => pickMotion(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="set-group-tt">代码设置</div>
      <div className="set-group-desc">设置代码内容的主题、字号和显示方式，不受界面字号影响。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>浅色代码主题</b><span>浅色界面下代码内容使用的高亮主题。</span></div>
          <Sel
            label="GitHub Light"
            options={[{ v: "github", label: "GitHub Light", ck: "✓" }]}
            onPick={() => toast("浅色代码主题目前固定 GitHub Light")}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>深色代码主题</b><span>深色界面下代码内容使用的高亮主题。</span></div>
          <Sel
            label="GitHub Dark"
            options={[{ v: "github", label: "GitHub Dark", ck: "✓" }]}
            onPick={() => toast("深色代码主题目前固定 GitHub Dark")}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>显示行号</b><span>在代码内容和差异视图中显示行号。</span></div>
          <div className={"tg" + (lineNo ? " on" : "")} id="tgLineNo" onClick={toggleLineNo}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>长行自动换行</b><span>代码内容过长时自动换行。</span></div>
          <div className={"tg" + (wrap ? " on" : "")} id="tgWrap" onClick={toggleWrap}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>代码字号</b><span>调整代码块、文件预览和差异视图的默认字号。</span></div>
          <div className="num-ctl">
            <button type="button" className="num-btn" id="codeFsMinus" onClick={() => stepCodeFs(-1)}>−</button>
            <div className="num" id="codeFsVal">{codeFs} <i>px</i></div>
            <button type="button" className="num-btn" id="codeFsPlus" onClick={() => stepCodeFs(1)}>+</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">代码预览</div>
      <div className="set-group-desc">同时预览浅色与深色代码主题，当前界面使用的主题会标记为「当前生效」。</div>
      <div className="pv-grid">
        <div className="pv-card">
          <div className="pv-head">浅色预览<span className="pv-sub">GitHub Light</span><span className={"tag" + (dark ? "" : " on")} id="pvTagLight">{dark ? "浅色" : "当前生效"}</span></div>
          <div className="pv-code light">
            <div><span className="ln">1</span><span className="tk-k">const</span> <span className="tk-v">themePreview</span>: ThemeConfig = {"{"}</div>
            <div><span className="ln">2</span>&nbsp;&nbsp;surface: <span className="tk-s">"sidebar"</span>,</div>
            <div><span className="ln">3</span>&nbsp;&nbsp;accent: <span className="tk-s">"#339CFF"</span>,</div>
            <div><span className="ln">4</span>&nbsp;&nbsp;contrast: <span className="tk-n">45</span>,</div>
            <div><span className="ln">5</span>{"}"};</div>
          </div>
        </div>
        <div className="pv-card">
          <div className="pv-head">深色预览<span className="pv-sub">GitHub Dark</span><span className={"tag" + (dark ? " on" : "")} id="pvTagDark">{dark ? "当前生效" : "深色"}</span></div>
          <div className="pv-code dark">
            <div><span className="ln">1</span><span className="tk-k">const</span> <span className="tk-v2">themePreview</span>: <span className="tk-t2">ThemeConfig</span> = {"{"}</div>
            <div><span className="ln">2</span>&nbsp;&nbsp;surface: <span className="tk-s2">"sidebar"</span>,</div>
            <div><span className="ln">3</span>&nbsp;&nbsp;accent: <span className="tk-s2">"#339CFF"</span>,</div>
            <div><span className="ln">4</span>&nbsp;&nbsp;contrast: <span className="tk-n2">45</span>,</div>
            <div><span className="ln">5</span>{"}"};</div>
          </div>
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-appearance"]} />
    </div>
  );
}
