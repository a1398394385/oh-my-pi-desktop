// 思考级别菜单（原 composer.js buildThinkMenu + 点击绑定平移）：
// 只列当前模型支持的档位（英文原版 low/medium/…，auto/off 由 store 补齐）。
// 有会话走宿主下发；新建态落 S.newSessionThinking + localStorage。
import { useLayoutEffect, useRef } from "react";
import { S, useStore, send, notify, activeOpen, getSupportedThinkingForModel } from "../../store.js";
import { placeComposerMenu } from "./place.js";

export default function ThinkMenu({ btnRef, composerRef, onClose }) {
  useStore();
  const s = activeOpen();
  const menuRef = useRef(null);
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const levels = getSupportedThinkingForModel(s?.model || S.newSessionModel);
  const curThinking = s?.thinking || S.newSessionThinking;

  const pickLevel = (lv) => {
    if (s) {
      send({ type: "set_thinking", sessionId: s.sessionId, level: lv });
    } else {
      S.newSessionThinking = lv;
      S.newSessionDirty = true; // 手选后：后续 models 帧不再用配置默认覆盖
      try { localStorage.setItem("omp-new-thinking", lv); } catch {}
      notify();
    }
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
