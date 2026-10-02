// Sole renderer of settings rows: expands placement sections into settings rows; row structure
// reuses .srow, the control layer uses Radix primitives
// (Switch/Select/Input/Textarea, ui/components/ui/, visually aligned with the old .tg/.sel/.inp).
// Labels resolve per language: zh-CN looks up the zh pack, en resolves through
// the empty en pack and falls back to the schema's own ui.label/description
// (so new upstream keys never render blank); keys without ui (advanced page)
// fall back to "key name + type/default". Controls dispatch on def.type,
// writes go back via set_setting.
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { useAppStore, send, toast } from "../../store";
import { t } from "../../i18n";
import Icon from "../../Icon";
import { SETTINGS_ZH, OPTS_ZH, GROUPS_ZH, DARK_THEMES, LIGHT_THEMES } from "../../i18n/locales/settings-zh-CN";
import { SETTINGS_EN, OPTS_EN, GROUPS_EN } from "../../i18n/locales/settings-en";
import { expandSection, type Section, type SchemaDef } from "./placement";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

// def.type → i18n key (falls back to the raw type string; zh values match the old
// ZH_TYPE table verbatim)
const TYPE_LABEL_KEYS: Record<string, string> = {
  boolean: "settingsPage.schema.typeBoolean",
  number: "settingsPage.schema.typeNumber",
  string: "settingsPage.schema.typeString",
  enum: "settingsPage.schema.typeEnum",
  array: "settingsPage.schema.typeArray",
  record: "settingsPage.schema.typeRecord",
};

// Dropdown option shape (v matches SchemaSel's selected value and onPick callback)
interface SelOption {
  v: string;
  label: string;
}

// Composer shape options (mirrors omp's getComposerShapeOptions; the schema
// declares ui.options = "runtime", so this hardcoded list is the only source —
// labels come from the language-specific opts dictionary, falling back to the
// settingsPage pack when the dictionary has no entry).
function composerShapeOptions(opts: Record<string, Record<string, string>>): SelOption[] {
  return [
    { v: "band", label: opts["composer.shape"]?.["band"] ?? t("settingsPage.schema.shapeBand") },
    { v: "box", label: opts["composer.shape"]?.["box"] ?? t("settingsPage.schema.shapeBox") },
    { v: "claude", label: opts["composer.shape"]?.["claude"] ?? t("settingsPage.schema.shapeClaude") },
    { v: "pi", label: opts["composer.shape"]?.["pi"] ?? t("settingsPage.schema.shapePi") },
    { v: "borderless", label: opts["composer.shape"]?.["borderless"] ?? t("settingsPage.schema.shapeBorderless") },
    { v: "rule", label: opts["composer.shape"]?.["rule"] ?? t("settingsPage.schema.shapeRule") },
    { v: "field", label: opts["composer.shape"]?.["field"] ?? t("settingsPage.schema.shapeField") },
    { v: "rail", label: opts["composer.shape"]?.["rail"] ?? t("settingsPage.schema.shapeRail") },
  ];
}

/** Resolve the available option list of a setting from the schema and omp source code */
function resolveSettingOptions(k: string, def: SchemaDef, opts: Record<string, Record<string, string>>): SelOption[] {
  if (k === "composer.shape") return composerShapeOptions(opts);
  if (k === "theme.dark") return DARK_THEMES.map((t) => ({ v: t, label: opts["theme.dark"]?.[t] ?? t }));
  if (k === "theme.light") return LIGHT_THEMES.map((t) => ({ v: t, label: opts["theme.light"]?.[t] ?? t }));

  if (Array.isArray(def.ui?.options) && def.ui.options.length > 0) {
    return def.ui.options.map((o) => {
      const vStr = String(o.value ?? "");
      return {
        v: vStr,
        label: opts[k]?.[vStr] ?? o.label ?? vStr,
      };
    });
  }
  if (Array.isArray(def.values) && def.values.length > 0) {
    return def.values.map((v) => {
      const vStr = String(v ?? "");
      return {
        v: vStr,
        label: opts[k]?.[vStr] ?? vStr,
      };
    });
  }
  if (opts[k] && Object.keys(opts[k]).length > 0) {
    return Object.entries(opts[k]).map(([v, label]) => ({
      v,
      label,
    }));
  }
  return [];
}

interface SchemaSelProps {
  settingKey: string;
  settingType: string;
  current: unknown;
  options: SelOption[];
  onPick: (v: unknown) => void;
}

// Dropdown: Radix Select (trigger capsule / popover .menu visuals carried by the primitives); send on pick
function SchemaSel({ settingKey, settingType, current, options, onPick }: SchemaSelProps) {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  // Special compatibility for compaction.thresholdPercent and compaction.thresholdTokens: values of -1 or "" map to "default"
  const isDefaultThreshold =
    (settingKey === "compaction.thresholdPercent" || settingKey === "compaction.thresholdTokens") &&
    (current === -1 || current === "-1" || current === "" || current === undefined || current === null);

  const curStr = isDefaultThreshold ? "default" : String(current ?? "");
  const sel = options.find((o) => String(o.v) === curStr);

  const handlePick = (pickedValue: string) => {
    const rawVal = pickedValue === "__empty__" ? "" : pickedValue;
    if (settingKey === "compaction.thresholdPercent" || settingKey === "compaction.thresholdTokens") {
      if (rawVal === "default") {
        onPick(-1);
        return;
      }
    }
    if (settingType === "number") {
      const n = Number(rawVal);
      onPick(Number.isFinite(n) ? n : rawVal);
    } else if (settingType === "boolean") {
      onPick(rawVal === "true");
    } else {
      onPick(rawVal);
    }
  };

  const selectedValue = sel ? (sel.v || "__empty__") : "";

  return (
    <Select value={selectedValue} onValueChange={handlePick}>
      <SelectTrigger>
        <SelectValue placeholder={sel ? sel.label : curStr || t("settingsPage.schema.selectPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => {
          const itemVal = o.v || "__empty__";
          return (
            <SelectItem key={itemVal} value={itemVal}>
              {o.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

interface SchemaRowProps {
  k: string; // settings key name (a key of SETTINGS_SCHEMA)
  def: SchemaDef;
  value: unknown; // current value from a WS reply; shape depends on def.type but is unknown here, so typed as unknown
}

function SchemaRow({ k, def, value }: SchemaRowProps) {
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const zh = (lang === "zh-CN" ? SETTINGS_ZH : SETTINGS_EN)[k];
  let label: string | undefined, desc: string | undefined, warn: string | undefined;
  let adv = false;
  if (zh) {
    label = zh.label;
    desc = zh.description;
    warn = zh.warning;
  } else if (def.ui) {
    label = def.ui.label;
    desc = def.ui.description;
    warn = def.ui.warning;
  } else {
    label = k;
    // Auto-generated fallback: type name + default, both from the language pack
    // (zh keeps the original formatting verbatim).
    desc = t("settingsPage.schema.advDesc", { type: TYPE_LABEL_KEYS[def.type] ? t(TYPE_LABEL_KEYS[def.type]) : def.type, def: JSON.stringify(def.default) });
    adv = true;
  }

  const type = def.type;
  const cred = def.credential === true;

  // Local edit state for input controls + refill guard (only refill inputs that aren't focused; never disturb while focused)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const fmt = (v: unknown): string =>
    type === "array"
      ? Array.isArray(v)
        ? v.join(", ")
        : ""
      : type === "record"
        ? JSON.stringify(v ?? {}, null, 2)
        : v === undefined || v === null
          ? ""
          : String(v);
  const [text, setText] = useState(fmt(value));
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (type === "number") {
      const n = Number(text);
      if (Number.isFinite(n)) send({ type: "set_setting", key: k, value: n });
    } else if (type === "array") {
      const arr = text.split(",").map((s) => s.trim()).filter(Boolean);
      send({ type: "set_setting", key: k, value: arr });
    } else if (type === "record") {
      try {
        const o = JSON.parse(text);
        if (typeof o === "object" && o && !Array.isArray(o)) send({ type: "set_setting", key: k, value: o });
        else toast(t("settingsPage.schema.jsonInvalid"));
      } catch {
        toast(t("settingsPage.schema.jsonInvalid"));
      }
    } else {
      send({ type: "set_setting", key: k, value: text });
    }
  };

  const opts = resolveSettingOptions(k, def, lang === "zh-CN" ? OPTS_ZH : OPTS_EN);
  const isChoiceSetting =
    type === "enum" ||
    (opts.length > 0 && (type === "number" || type === "string")) ||
    def.ui?.options === "runtime";

  let ctl: ReactElement;
  if (type === "boolean" && opts.length === 0) {
    ctl = (
      <Switch checked={!!value} onCheckedChange={(v) => send({ type: "set_setting", key: k, value: v })} />
    );
  } else if (isChoiceSetting && opts.length > 0) {
    ctl = (
      <SchemaSel
        settingKey={k}
        settingType={type}
        current={value}
        options={opts}
        onPick={(v) => send({ type: "set_setting", key: k, value: v })}
      />
    );
  } else if (type === "record") {
    ctl = <Textarea rows={3} ref={inputRef as RefObject<HTMLTextAreaElement | null>} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />; // same ref reused for input/textarea, only read at the activeElement comparison, narrowing is safe
  } else if (type === "number") {
    ctl = <Input type="number" ref={inputRef as RefObject<HTMLInputElement | null>} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
  } else {
    // string / string+credential(password) / array(comma-separated)
    ctl = (
      <Input
        type={cred ? "password" : "text"}
        ref={inputRef as RefObject<HTMLInputElement | null>}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
    );
  }

  return (
    <div className="srow">
      <div className="srow-tx">
        <b className={adv ? "adv-key" : undefined}>{label}</b>
        {warn && <span className="srow-wn">{warn}</span>}
        {desc && <span>{desc}</span>}
      </div>
      <div className="srow-ctl">{ctl}</div>
    </div>
  );
}

interface SchemaRowsProps {
  sections?: Section[] | null; // placement sections for the page; when absent, render nothing
}

export default function SchemaRows({ sections }: SchemaRowsProps) {
  const schema = useAppStore((s) => s.settingsSchema);
  const hostSettings = useAppStore((s) => s.hostSettings);
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const groups = lang === "zh-CN" ? GROUPS_ZH : GROUPS_EN;
  const conditions = hostSettings?.conditions || {};
  const values = hostSettings?.values || {};
  if (!schema || !sections) return null;

  const out: ReactElement[] = [];
  for (const section of sections) {
    const keys = expandSection(section, schema).filter((k) => {
      const cond = schema[k].ui?.condition;
      // Conditional hiding: don't render when the condition is known and false; render when unknown/absent
      return !(cond && conditions[cond] === false);
    });
    if (keys.length === 0) continue;
    // Group title: per-language section title (titleZh / titleEn) ?? language
    // group dictionary ?? raw group name; hint likewise falls back zh → en.
    let title = lang === "zh-CN" ? section.titleZh : (section.titleEn ?? section.titleZh);
    if (!title && section.from) {
      const group = section.from.slice(section.from.indexOf("/") + 1);
      title = groups[group] ?? group;
    }
    const hint = lang === "zh-CN" ? section.hint : (section.hintEn ?? section.hint);
    out.push(
      <div key={section.from ?? title ?? out.length}>
        <div className="set-group-tt">
          {title}
          {hint && (
            <span className="gtt-hint" data-hint={hint}>
              <Icon name="info" size={14} />
            </span>
          )}
        </div>
        <div className="set-card">
          {keys.map((k) => (
            <SchemaRow key={k} k={k} def={schema[k]} value={values[k]} />
          ))}
        </div>
      </div>,
    );
  }
  return <>{out}</>;
}
