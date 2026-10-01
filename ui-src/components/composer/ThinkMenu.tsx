// 思考级别菜单（原 composer.js buildThinkMenu + 点击绑定平移）：
// 只列当前模型支持的档位（英文原版 low/medium/…，auto/off 由 store 补齐）。
// 有会话走宿主下发；新建态落 newSessionThinking + localStorage。
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, getSupportedThinkingForModel, pickThinkingLevel } from "../../store";
import { placeComposerMenu } from "./place";

type ThinkMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ThinkMenu({ btnRef, composerRef, onClose }: ThinkMenuProps) {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  // 无赋值订阅：档位目录在 models/ready 帧到达时换 Map 引用，订阅引用才能在目录
  // 刷新后重渲染（getSupportedThinkingForModel 内部 getState 读最新表）
  useAppStore((st) => st.modelEfforts);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const levels: string[] = getSupportedThinkingForModel(s?.model || newSessionModel);
  const curThinking = s?.thinking || newSessionThinking;

  const pickLevel = (lv: string) => {
    pickThinkingLevel(lv);
    onClose();
  };

  return (
    <div className="menu open" id="thinkMenu" ref={menuRef}>
      <div className="mh">{t("composer.reasoning")}</div>
      {levels.map((lv) => (
        <div className="mi" data-level={lv} key={lv} onClick={() => pickLevel(lv)}>
          <span className="ck">{curThinking === lv ? "✓" : ""}</span>{lv}
        </div>
      ))}
    </div>
  );
}
