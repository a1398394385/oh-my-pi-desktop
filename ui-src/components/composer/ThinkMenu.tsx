// 思考级别菜单（原 composer.js buildThinkMenu + 点击绑定平移）：
// 只列当前模型支持的档位（英文原版 low/medium/…，auto/off 由 store 补齐）。
// 有会话走宿主下发；新建态落 S.newSessionThinking + localStorage。
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { S, useStore, activeOpen, getSupportedThinkingForModel, pickThinkingLevel } from "../../store";
import { placeComposerMenu } from "./place";

type ThinkMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ThinkMenu({ btnRef, composerRef, onClose }: ThinkMenuProps) {
  useStore();
  const s = activeOpen();
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const levels: string[] = getSupportedThinkingForModel(s?.model || S.newSessionModel);
  const curThinking = s?.thinking || S.newSessionThinking;

  const pickLevel = (lv: string) => {
    pickThinkingLevel(lv);
    onClose();
  };

  return (
    <div className="menu open" id="thinkMenu" ref={menuRef}>
      <div className="mh">推理强度</div>
      {levels.map((lv) => (
        <div className="mi" data-level={lv} key={lv} onClick={() => pickLevel(lv)}>
          <span className="ck">{curThinking === lv ? "✓" : ""}</span>{lv}
        </div>
      ))}
    </div>
  );
}
