// 审批卡（ask/confirm/editor 对话框）：ZCodium PermissionDialog 同款——
// 「等待确认」标题 + 问题正文 + 编号选项行 + 底部键盘提示与确认钮。
// 交互对齐 ZCodium：单击选中、再单击 / 回车 / 确认钮应答，数字键直接应答，上下 / Tab 移动选中；
// editable（editor 对话框）时「提交」行内嵌输入（ZCodium 反馈行样式，空输入按取消处理）。
// 应答后 answer 定格（chosen/dim/disabled），本地点击即时生效。
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";

// 审批请求条目（store 从 host approval 帧构造）：answer/prefill 由本卡就地写回
interface ApprovalItem {
  title?: string;
  options: string[];
  editable?: boolean;
  requestId: string;
  answer?: string | null;
  prefill?: string;
}

export default function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0); // 确认按钮读取最新选项，不依赖 React 下一次渲染
  const select = (i: number) => {
    selectedRef.current = i;
    setSelected(i);
  };
  const [chosen, setChosen] = useState(-1); // 应答行下标（本地定格；重挂载回落到 answer 比对）
  const listRef = useRef<HTMLDivElement | null>(null);
  const inpRef = useRef<HTMLInputElement | null>(null);
  const answered = item.answer !== null;
  const n = item.options.length;
  // editable 协议固定 options 含「提交」：该行内嵌输入，其余行是纯选项
  const inpIdx = item.editable ? item.options.indexOf("提交") : -1;

  const choose = (i: number) => {
    if (item.answer !== null) return;
    const opt = item.options[i];
    let answer: string | null | undefined = opt;
    if (item.editable) {
      if (opt === "提交") answer = inpRef.current!.value.trim() || null; // 空输入按取消处理（editable 行必已挂载）
      else answer = undefined;
    }
    setChosen(i);
    // 答案写回挂起审批条目：按 requestId 定位，拷贝数组与元素替换（selector 与 _v 订阅方都能感知）
    useAppStore.setState((st) => {
      for (const [p, sess] of st.openSessions) {
        const list = sess.pendingApprovals;
        const j = list?.findIndex((r) => r.requestId === item.requestId) ?? -1;
        if (!list || j < 0) continue;
        const pendingApprovals = list.slice();
        pendingApprovals[j] = { ...list[j], answer: answer ?? opt };
        return { openSessions: new Map(st.openSessions).set(p, { ...sess, pendingApprovals }) };
      }
      return {};
    });
    useAppStore.getState().send({ type: "approval_response", requestId: item.requestId, answer });
  };

  // 选中并聚焦第 i 行（editable 行聚焦内嵌输入）
  const focusRow = (i: number) => {
    select(i);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
  };
  const move = (from: number, d: number) => focusRow((from + d + n) % n);

  // 行键盘：数字键直接应答；上下 / 左右 / Tab 移动；回车应答本行（对齐 ZCodium PermissionDialog）
  const onRowKey = (i: number) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key >= "1" && e.key <= String(n)) {
      e.preventDefault();
      choose(Number(e.key) - 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(i, -1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(i);
    }
  };

  // 内嵌输入键盘（ZCodium 反馈行同款）：回车提交、上下 / Tab 换行、Esc 失焦；
  // stopPropagation——输入行按键不触发全局快捷键（Esc 中断生成等）
  const onInpKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(inpIdx);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      move(inpIdx, -1);
    } else if (e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault();
      move(inpIdx, 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      inpRef.current?.blur();
    }
  };

  // 挂载聚焦选中行（数字 / 回车快捷键即刻可用）；已有输入焦点时不抢（用户可能正在打字）
  useEffect(() => {
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)) return;
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (row?.querySelector("input") ?? row)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frozenChosen = answered
    ? chosen >= 0
      ? chosen
      : typeof item.answer === "string"
        ? item.options.indexOf(item.answer)
        : -1
    : -1;

  return (
    <div className="approval-card">
      <div className="approval-head">等待确认</div>
      <div className="approval-title">{item.title}</div>
      <div className="approval-list" role="listbox" aria-label="确认选项" ref={listRef}>
        {item.options.map((opt, i) => {
          const num = answered && i === frozenChosen ? "✓" : `${i + 1}.`;
          const cls =
            "approval-opt" +
            (i === inpIdx ? " has-input" : "") +
            (!answered && i === selected ? " sel" : "") +
            (answered ? (i === frozenChosen ? " chosen sel" : " dim") : "");
          const sel = !answered && i === selected;
          if (i === inpIdx) {
            // 非受控输入：输入只写回 item.prefill（全量重绘时保住已输入内容），不触发重渲染
            return (
              <div
                key={opt}
                data-idx={i}
                className={cls}
                role="option"
                aria-selected={sel || (answered && i === frozenChosen)}
                onFocus={() => !answered && select(i)}
                onClick={(e) => {
                  if (e.target !== inpRef.current) inpRef.current?.focus();
                }}
              >
                <span className="approval-num">{num}</span>
                <input
                  type="text"
                  className="approval-inp"
                  placeholder="输入内容后提交…"
                  defaultValue={item.prefill || ""}
                  disabled={answered}
                  ref={inpRef}
                  onChange={(e) => { item.prefill = e.target.value; }}
                  onKeyDown={onInpKey}
                />
              </div>
            );
          }
          return (
            <button
              key={opt}
              type="button"
              data-idx={i}
              className={cls}
              role="option"
              aria-selected={sel || (answered && i === frozenChosen)}
              tabIndex={sel ? 0 : -1}
              disabled={answered}
              onFocus={() => !answered && select(i)}
              onKeyDown={onRowKey(i)}
              onClick={() => (sel ? choose(i) : focusRow(i))}
            >
              <span className="approval-num">{num}</span>
              <span className="approval-label">{opt}</span>
            </button>
          );
        })}
      </div>
      {!answered && (
        <div className="approval-foot">
          <span className="approval-hint">
            <Icon name="info" size={14} />
            使用 Tab / 上下键选择，回车确认
          </span>
          <button type="button" className="approval-confirm" onClick={() => choose(selectedRef.current)}>
            确认
          </button>
        </div>
      )}
    </div>
  );
}
