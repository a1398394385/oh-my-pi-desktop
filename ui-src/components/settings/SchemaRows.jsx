// 设置行唯一渲染器：把 placement 段展开为设置行，复用既有 .srow/.tg/.sel/.inp 控件语言。
// 中文文案查 SETTINGS_ZH；缺省回落 schema 的 ui.label/description（底座加键不致空白）；
// 无 ui 的键（高级页）回落为「键名 + 类型/默认」。控件按 def.type 分派，改后经 set_setting 回写。
import { useEffect, useRef, useState } from "react";
import { S, useStore, send, toast } from "../../store.js";
import Icon from "../../Icon.jsx";
import { SETTINGS_ZH, OPTS_ZH, GROUPS_ZH } from "./settings-zh.js";
import { expandSection } from "./placement.js";

const ZH_TYPE = { boolean: "布尔", number: "数字", string: "字符串", enum: "枚举", array: "数组", record: "对象" };

// 下拉：复用 GeneralPage Sel 的 .sel/.menu/.mi 结构；选中即发（enum 专用）
function SchemaSel({ current, options, onPick }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const sel = options.find((o) => o.v === current);
  return (
    <div
      className="sel"
      ref={boxRef}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {sel ? sel.label : String(current ?? "")} <Icon name="caret" size={14} className="caret-svg" />
      <div className={"menu" + (open ? " open" : "")}>
        {options.map((o) => (
          <div
            key={String(o.v)}
            className="mi"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onPick(o.v);
            }}
          >
            <span className="ck">{o.v === current ? "✓" : ""}</span>
            {o.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function SchemaRow({ k, def, value }) {
  const zh = SETTINGS_ZH[k];
  let label, desc, warn;
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
  const inputRef = useRef(null);
  const fmt = (v) =>
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

  let ctl;
  if (type === "boolean") {
    ctl = (
      <div className={"tg" + (value ? " on" : "")} onClick={() => send({ type: "set_setting", key: k, value: !value })}>
        <i></i>
      </div>
    );
  } else if (type === "enum") {
    const opts = Array.isArray(def.ui?.options)
      ? def.ui.options.map((o) => ({ v: o.value, label: OPTS_ZH[k]?.[o.value] ?? o.label ?? o.value }))
      : (def.values ?? []).map((v) => ({ v, label: OPTS_ZH[k]?.[v] ?? v }));
    ctl = <SchemaSel current={value} options={opts} onPick={(v) => send({ type: "set_setting", key: k, value: v })} />;
  } else if (type === "record") {
    ctl = <textarea className="inp" rows={3} ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
  } else if (type === "number") {
    ctl = <input className="inp" type="number" ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
  } else {
    // string / string+credential(password) / array(逗号)
    ctl = (
      <input
        className="inp"
        type={cred ? "password" : "text"}
        ref={inputRef}
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

export default function SchemaRows({ sections }) {
  useStore();
  const schema = S.settingsSchema;
  const conditions = S.hostSettings?.conditions || {};
  const values = S.hostSettings?.values || {};
  if (!schema || !sections) return null;

  const out = [];
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
