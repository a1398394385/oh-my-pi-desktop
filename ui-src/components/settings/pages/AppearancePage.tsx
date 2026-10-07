// Settings page: appearance (pg-appearance). UI theme/font/font size, code theme/line
// numbers/wrap/font size, dual-theme code preview.
// Old reference: <div class="set-page" id="pg-appearance"> in git show 464131d:ui/index.html,
// bindings per initSettings in ui/settings/index.js (themeSel/fontSel/num-ctl/tgLineNo/tgWrap).
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, toast } from "../../../store";
import { t as ti } from "../../../i18n";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { saveUiPrefs, applyAppearance, FONT_STACKS } from "../../../appearance";
import { saveTheme, saveMotion } from "../../../shell";
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";
import { THEMES, resolveTheme, type ThemeId } from "../../../theme-registry";

// Dropdown option (1:1 with the old .mi; ck/sub/disabled all optional)
interface SelOption {
  v: string;
  label: ReactNode;
  ck?: string;
  sub?: string;
  disabled?: boolean;
}

// Sel dropdown props
interface SelProps {
  label: ReactNode;
  options: SelOption[];
  onPick: (v: string) => void;
}

// Theme icons aligned with ZCodium THEME_MODES (lucide line layer: monitor/sun/moon)
function themeIcon(mode: string): string {
  return mode === "system" ? "monitor" : mode === "light" ? "sun" : "moon";
}
function themeLabel(themeId: string): ReactNode {
  if (themeId === "system") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Icon name="monitor" size={14} />
        {ti("settingsPage.appearance.themeSystem")}
      </span>
    );
  }
  const entry = THEMES[themeId as ThemeId];
  if (!entry) return themeId;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon name={entry.mode === "light" ? "sun" : "moon"} size={14} />
      {ti(THEME_LABEL_KEYS[themeId] || entry.name)}
    </span>
  );
}

// Font display-name key table: values are i18n keys resolved via t() at render time
const FONT_LABEL_KEYS: Record<string, string> = {
  default: "settingsPage.appearance.fontDefault",
  zcode: "settingsPage.appearance.fontZcode",
  pingfang: "settingsPage.appearance.fontPingfang",
  songti: "settingsPage.appearance.fontSongti",
  kaiti: "settingsPage.appearance.fontKaiti",
  heiti: "settingsPage.appearance.fontHeiti",
  mono: "settingsPage.appearance.fontMono",
};

const THEME_LABEL_KEYS: Record<string, string> = {
  dark: "settingsPage.appearance.themeDark",
  light: "settingsPage.appearance.themeLight",
  midnight: "settingsPage.appearance.themeMidnight",
  "warm-paper": "settingsPage.appearance.themeWarmPaper",
  "deep-think": "settingsPage.appearance.themeDeepThink",
  coral: "settingsPage.appearance.themeCoral",
};

// ---------- Dropdown selector: controlled equivalent of the old wireSel ----------
function Sel({ label, options, onPick }: SelProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      releaseDropdown(close);
    };
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

// Font-size stepping (old stepFont: clamp -> save -> apply; uiPrefs written as a fresh object + bump)
function stepFont(key: "uiFontSize" | "codeFontSize", delta: number, min: number, max: number): void {
  useAppStore.setState((st) => ({
    uiPrefs: { ...st.uiPrefs, [key]: Math.min(max, Math.max(min, st.uiPrefs[key] + delta)) },
  }));
  saveUiPrefs();
  applyAppearance();
}

export default function AppearancePage() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<string>(useAppStore.getState().uiPrefs.theme);
  const [font, setFont] = useState(useAppStore.getState().uiPrefs.uiFont || "default");
  const [uiFs, setUiFs] = useState(useAppStore.getState().uiPrefs.uiFontSize);
  const [codeFs, setCodeFs] = useState(useAppStore.getState().uiPrefs.codeFontSize);
  const [lineNo, setLineNo] = useState(!!useAppStore.getState().uiPrefs.lineNumbers);
  const [wrap, setWrap] = useState(!!useAppStore.getState().uiPrefs.codeWrap);
  // Preview card "currently active" tag follows the actual light/dark state.
  const [dark, setDark] = useState(document.documentElement.dataset.themeMode === "dark");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setDark(document.documentElement.dataset.themeMode === "dark");
    mq.addEventListener("change", sync);
    const timer = setInterval(sync, 1000); // dataset.theme changes fire no event; cheap polling as a fallback
    return () => {
      mq.removeEventListener("change", sync);
      clearInterval(timer);
    };
  }, []);

  const pickTheme = (mode: string) => {
    const theme = mode === "system" ? "system" : resolveTheme(mode);
    setTheme(theme);
    saveTheme(theme);
  };
  const pickFont = (f: string) => {
    setFont(f);
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, uiFont: f } }));
    saveUiPrefs();
    applyAppearance();
  };
  const [motion, setMotion] = useState<string>(useAppStore.getState().uiPrefs.motion);
  const pickMotion = (mode: string) => {
    setMotion(mode);
    saveMotion(mode === "on" || mode === "off" ? mode : "system");
  };
  const toggleLineNo = () => {
    const on = !lineNo;
    setLineNo(on);
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, lineNumbers: on } }));
    saveUiPrefs();
    applyAppearance();
  };
  const toggleWrap = () => {
    const on = !wrap;
    setWrap(on);
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, codeWrap: on } }));
    saveUiPrefs();
    applyAppearance();
  };
  // Font-size stepping (range keeps the old clamp in settings/index.js: UI 11-18, code 10-18)
  const stepUiFs = (d: number) => {
    stepFont("uiFontSize", d, 11, 18);
    setUiFs(useAppStore.getState().uiPrefs.uiFontSize);
  };
  const stepCodeFs = (d: number) => {
    stepFont("codeFontSize", d, 10, 18);
    setCodeFs(useAppStore.getState().uiPrefs.codeFontSize);
  };

  return (
    <div className="set-page" id="pg-appearance">
      <div className="set-tt">{t("settingsPage.nav.appearance")}</div>
      <div className="set-group-tt">{t("settingsPage.appearance.groupInterface")}</div>
      <div className="set-group-desc">{t("settingsPage.appearance.interfaceDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.themeTitle")}</b><span>{t("settingsPage.appearance.themeDesc")}</span></div>
          <Sel
            label={themeLabel(theme)}
            options={[
              { v: "system", label: themeLabel("system"), ck: theme === "system" ? "✓" : "" },
              ...Object.keys(THEMES).map((id) => ({
                v: id,
                label: themeLabel(id),
                ck: theme === id ? "✓" : "",
              })),
            ]}
            onPick={pickTheme}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.fontTitle")}</b><span>{t("settingsPage.appearance.fontDesc")}</span></div>
          <Sel
            label={t(FONT_LABEL_KEYS[font] || "settingsPage.appearance.fontDefault")}
            options={Object.entries(FONT_LABEL_KEYS).map(([v, k]) => ({ v, label: t(k), ck: v === font ? "✓" : "" }))}
            onPick={pickFont}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.fontSizeTitle")}</b><span>{t("settingsPage.appearance.fontSizeDesc")}</span></div>
          <div className="num-ctl">
            <button type="button" className="num-btn" id="uiFsMinus" onClick={() => stepUiFs(-1)}>−</button>
            <div className="num" id="uiFsVal">{uiFs} <i>px</i></div>
            <button type="button" className="num-btn" id="uiFsPlus" onClick={() => stepUiFs(1)}>+</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.motionTitle")}</b><span>{t("settingsPage.appearance.motionDesc")}</span></div>
          <div className="mcp-type-pills">
            {[["system", t("settingsPage.appearance.motionSystem")], ["on", t("settingsPage.appearance.motionOn")], ["off", t("settingsPage.appearance.motionOff")]].map(([v, label]) => (
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
      <div className="set-group-tt">{t("settingsPage.appearance.groupCode")}</div>
      <div className="set-group-desc">{t("settingsPage.appearance.codeDesc")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.lightThemeTitle")}</b><span>{t("settingsPage.appearance.lightThemeDesc")}</span></div>
          <Sel
            label="GitHub Light"
            options={[{ v: "github", label: "GitHub Light", ck: "✓" }]}
            onPick={() => toast(t("settingsPage.appearance.lightThemeToast"))}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.darkThemeTitle")}</b><span>{t("settingsPage.appearance.darkThemeDesc")}</span></div>
          <Sel
            label="GitHub Dark"
            options={[{ v: "github", label: "GitHub Dark", ck: "✓" }]}
            onPick={() => toast(t("settingsPage.appearance.darkThemeToast"))}
          />
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.lineNumbersTitle")}</b><span>{t("settingsPage.appearance.lineNumbersDesc")}</span></div>
          <div className={"tg" + (lineNo ? " on" : "")} id="tgLineNo" onClick={toggleLineNo}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.wrapTitle")}</b><span>{t("settingsPage.appearance.wrapDesc")}</span></div>
          <div className={"tg" + (wrap ? " on" : "")} id="tgWrap" onClick={toggleWrap}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.appearance.codeFontSizeTitle")}</b><span>{t("settingsPage.appearance.codeFontSizeDesc")}</span></div>
          <div className="num-ctl">
            <button type="button" className="num-btn" id="codeFsMinus" onClick={() => stepCodeFs(-1)}>−</button>
            <div className="num" id="codeFsVal">{codeFs} <i>px</i></div>
            <button type="button" className="num-btn" id="codeFsPlus" onClick={() => stepCodeFs(1)}>+</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.appearance.groupPreview")}</div>
      <div className="set-group-desc">{t("settingsPage.appearance.previewDesc")}</div>
      <div className="pv-grid">
        <div className="pv-card">
          <div className="pv-head">{t("settingsPage.appearance.previewLightTitle")}<span className="pv-sub">GitHub Light</span><span className={"tag" + (dark ? "" : " on")} id="pvTagLight">{dark ? t("settingsPage.appearance.previewLightTag") : t("settingsPage.appearance.previewActive")}</span></div>
          <div className="pv-code light">
            <div><span className="ln">1</span><span className="tk-k">const</span> <span className="tk-v">themePreview</span>: ThemeConfig = {"{"}</div>
            <div><span className="ln">2</span>&nbsp;&nbsp;surface: <span className="tk-s">"sidebar"</span>,</div>
            <div><span className="ln">3</span>&nbsp;&nbsp;accent: <span className="tk-s">"#339CFF"</span>,</div>
            <div><span className="ln">4</span>&nbsp;&nbsp;contrast: <span className="tk-n">45</span>,</div>
            <div><span className="ln">5</span>{"}"};</div>
          </div>
        </div>
        <div className="pv-card">
          <div className="pv-head">{t("settingsPage.appearance.previewDarkTitle")}<span className="pv-sub">GitHub Dark</span><span className={"tag" + (dark ? " on" : "")} id="pvTagDark">{dark ? t("settingsPage.appearance.previewActive") : t("settingsPage.appearance.previewDarkTag")}</span></div>
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
