// 设置页：键盘快捷键（pg-keyboard）。条目来自 ui-src/keys.js 的注册表——展示与绑定同源，
// 键位对齐 omp 命令行（组件内绑定的键也在注册表登记，本页只读）。
import { SHORTCUT_GROUPS } from "../../../keys";

// keys.js 注册表条目形状（未补类型，按字面量收窄）
interface ShortcutItem {
  keys: string[]; // 键帽展示
  label: string;
}
interface ShortcutGroup {
  title: string;
  desc: string;
  items: ShortcutItem[];
}
const GROUPS = SHORTCUT_GROUPS as ShortcutGroup[];

export default function KeyboardPage() {
  return (
    <div className="set-page" id="pg-keyboard">
      <div className="set-tt">键盘快捷键</div>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="set-group-tt">{g.title}</div>
          <div className="set-group-desc">{g.desc}</div>
          <div className="set-card">
            {g.items.map((it) => (
              <div className="srow" key={it.label + it.keys.join("")}>
                <div className="srow-tx"><b>{it.label}</b></div>
                <div className="sc-keys">
                  {it.keys.map((k, i) => <span className="sc-key" key={i}>{k}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
