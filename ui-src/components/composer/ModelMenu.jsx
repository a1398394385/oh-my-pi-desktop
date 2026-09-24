// 模型菜单（原 composer.js buildModelMenu + pickModel 平移）：
// 一级列供应商（› 指示），悬停 180ms 意图延时 / 点击向右弹出该供应商的模型浮层。
// 浮层渲染为 #composer 直接子节点（fragment 兄弟位，原版挂 composerEl 规避 .menu.model
// 的 overflow-y:auto 裁切）；有会话走宿主 set_model，新建态落 localStorage。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { S, useStore, send, notify, activeOpen, modelNames, pickModelId } from "../../store.js";
import Icon from "../../Icon.jsx";
import { placeComposerMenu } from "./place.js";

export default function ModelMenu({ btnRef, composerRef, onClose }) {
  useStore();
  const s = activeOpen();
  const curModel = s?.model || S.newSessionModel;
  const menuRef = useRef(null);
  const flyRef = useRef(null);
  const rowRefs = useRef(new Map()); // prov -> 供应商行元素（flyout 顶部对齐用）
  const [flyProv, setFlyProv] = useState(null); // 当前二级浮层的供应商
  const hideT = useRef(0); // 浮层关闭宽限
  const switchT = useRef(0); // 行切换悬停意图延时

  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  // 卸载清计时器
  useEffect(() => () => { clearTimeout(hideT.current); clearTimeout(switchT.current); }, []);

  // 浮层坐标：#composer 相对（offsetParent），顶部对齐供应商行（两菜单 padding 均 5px，
  // -5 让首行与行高对齐），菜单滚动时扣除 scrollTop。注意不得钳位到 0：菜单一 carousel 般
  // 向上超出 composer 时 offsetTop 为负，浮层必须跟着行走到 composer 上方，钳位会让浮层整体下滑错位
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const row = rowRefs.current.get(flyProv);
    const fly = flyRef.current;
    if (!menu || !row || !fly || !flyProv) return;
    fly.style.top = menu.offsetTop + row.offsetTop - menu.scrollTop - 5 + "px";
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px"; // 与一级菜单边框交叠 4px，视觉无缝
    if (fly.getBoundingClientRect().right > window.innerWidth - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px"; // 右缘越界翻左
    }
  }, [flyProv]);

  // 模型选中：有会话走宿主下发，新建态落 localStorage（手选后不再被配置默认覆盖）
  const pickModel = (id) => {
    pickModelId(id);
    onClose();
  };

  // 按 provider 分组（宿主下发 id 形如 "provider/modelId"）
  const groups = new Map();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov).push([id, name]);
  }

  if (modelNames.size === 0) {
    return (
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        <div className="mi empty" style={{ color: "var(--dim)", cursor: "default", justifyContent: "center", padding: "8px 12px" }}>
          未配置可用模型
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        {[...groups].map(([prov]) => (
          <div
            className={"mi prov" + (prov === flyProv ? " on" : "")}
            key={prov}
            ref={(el) => { if (el) rowRefs.current.set(prov, el); else rowRefs.current.delete(prov); }}
            // 行切换加 180ms 悬停意图延时：指针斜向穿过中间行去够浮层时不抢焦
            // （浮层 mouseenter 会取消待切换），停够才换供应商；点击仍即时展开/收起
            onMouseEnter={() => {
              clearTimeout(hideT.current);
              if (prov === flyProv) return;
              clearTimeout(switchT.current);
              switchT.current = setTimeout(() => setFlyProv(prov), 180);
            }}
            onMouseLeave={() => clearTimeout(switchT.current)}
            onClick={(e) => {
              e.stopPropagation();
              clearTimeout(hideT.current);
              clearTimeout(switchT.current);
              setFlyProv(prov === flyProv ? null : prov);
            }}
          >
            {prov}
            <span className="sub"><Icon name="chevronRight" size={10} /></span>
          </div>
        ))}
      </div>
      {flyProv && (
        <div
          className="menu flyout open"
          ref={flyRef}
          onMouseEnter={() => { clearTimeout(hideT.current); clearTimeout(switchT.current); }}
          onMouseLeave={() => {
            clearTimeout(hideT.current);
            hideT.current = setTimeout(() => setFlyProv(null), 150);
          }}
        >
          {groups.get(flyProv).map(([id, name]) => (
            <div className="mi" data-model={id} key={id} onClick={() => pickModel(id)}>
              <span className="ck">{curModel === id ? "✓" : ""}</span>{name}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
