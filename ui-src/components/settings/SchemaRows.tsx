// 设置行唯一渲染器：把 placement 段展开为设置行；行结构复用 .srow，控件层走 Radix 基件
// （Switch/Select/Input/Textarea，ui/components/ui/，视觉对齐原 .tg/.sel/.inp）。
// 中文文案查 SETTINGS_ZH；缺省回落 schema 的 ui.label/description（底座加键不致空白）；
// 无 ui 的键（高级页）回落为「键名 + 类型/默认」。控件按 def.type 分派，改后经 set_setting 回写。
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { useAppStore, send, toast } from "../../store";
import Icon from "../../Icon";
import { SETTINGS_ZH, OPTS_ZH, GROUPS_ZH } from "./settings-zh";
import { expandSection, type Section, type SchemaDef } from "./placement";
import { Switch } from "../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

// def.type → 中文类型名（缺省回落原始 type 字符串）
const ZH_TYPE: Record<string, string> = { boolean: "布尔", number: "数字", string: "字符串", enum: "枚举", array: "数组", record: "对象" };

// 下拉选项形状（v 与 SchemaSel 选中值、onPick 回调一致）
interface SelOption {
  v: string;
  label: string;
}

interface SchemaSelProps {
  current: unknown; // 当前值来自 WS 回包 values，形状不明，按 unknown 处理
  options: SelOption[];
  onPick: (v: string) => void;
}

// 下拉：Radix Select（trigger 胶囊 / 弹层 .menu 视觉由基件承担）；选中即发（enum 专用）
function SchemaSel({ current, options, onPick }: SchemaSelProps) {
  const sel = options.find((o) => o.v === current);
  return (
    <Select value={sel ? sel.v : ""} onValueChange={onPick}>
      <SelectTrigger>
        <SelectValue placeholder={String(current ?? "")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.v} value={o.v}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface SchemaRowProps {
  k: string; // 设置键名（SETTINGS_SCHEMA 的键）
  def: SchemaDef;
  value: unknown; // 当前值来自 WS 回包，形状由 def.type 决定但此处不明，按 unknown 处理
}

function SchemaRow({ k, def, value }: SchemaRowProps) {
  const zh = SETTINGS_ZH[k];
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
    desc = `类型 ${ZH_TYPE[def.type] ?? def.type}｜默认 ${JSON.stringify(def.default)}`;
    adv = true;
  }

  const type = def.type;
  const cred = def.credential === true;

  // 输入类控件的本地编辑态 + 回填守卫（仅回填未聚焦的输入，聚焦中不打扰）
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
        else toast("JSON 格式无效");
      } catch {
        toast("JSON 格式无效");
      }
    } else {
      send({ type: "set_setting", key: k, value: text });
    }
  };

  let ctl: ReactElement;
  if (type === "boolean") {
    ctl = (
      <Switch checked={!!value} onCheckedChange={(v) => send({ type: "set_setting", key: k, value: v })} />
    );
  } else if (type === "enum") {
    const opts = Array.isArray(def.ui?.options)
      ? def.ui.options.map((o) => ({ v: o.value, label: OPTS_ZH[k]?.[o.value] ?? o.label ?? o.value }))
      : (def.values ?? []).map((v) => ({ v, label: OPTS_ZH[k]?.[v] ?? v }));
    ctl = <SchemaSel current={value} options={opts} onPick={(v) => send({ type: "set_setting", key: k, value: v })} />;
  } else if (type === "record") {
    ctl = <Textarea rows={3} ref={inputRef as RefObject<HTMLTextAreaElement | null>} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />; // 同一 ref 复用于 input/textarea,仅在 activeElement 比较处读取,收窄安全
  } else if (type === "number") {
    ctl = <Input type="number" ref={inputRef as RefObject<HTMLInputElement | null>} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
  } else {
    // string / string+credential(password) / array(逗号)
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
  sections?: Section[] | null; // 各页 placement 段；缺省时整体不渲染
}

export default function SchemaRows({ sections }: SchemaRowsProps) {
  const schema = useAppStore((s) => s.settingsSchema);
  const hostSettings = useAppStore((s) => s.hostSettings);
  const conditions = hostSettings?.conditions || {};
  const values = hostSettings?.values || {};
  if (!schema || !sections) return null;

  const out: ReactElement[] = [];
  for (const section of sections) {
    const keys = expandSection(section, schema).filter((k) => {
      const cond = schema[k].ui?.condition;
      // 条件隐藏：已知条件且为 false 则不渲染；未知/缺省条件渲染
      return !(cond && conditions[cond] === false);
    });
    if (keys.length === 0) continue;
    // 组标题：titleZh ?? GROUPS_ZH[组名] ?? 组名
    let title = section.titleZh;
    if (!title && section.from) {
      const group = section.from.slice(section.from.indexOf("/") + 1);
      title = GROUPS_ZH[group] ?? group;
    }
    out.push(
      <div key={section.from ?? title ?? out.length}>
        <div className="set-group-tt">
          {title}
          {section.hint && (
            <span className="gtt-hint" data-hint={section.hint}>
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
