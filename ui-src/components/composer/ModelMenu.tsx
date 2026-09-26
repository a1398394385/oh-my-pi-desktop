// 模型菜单（原 composer.js buildModelMenu + pickModel 平移）：
// 一级列供应商（› 指示），悬停 180ms 意图延时 / 点击向右弹出该供应商的模型浮层。
// 浮层渲染为 #composer 直接子节点（fragment 兄弟位，原版挂 composerEl 规避 .menu.model
// 的 overflow-y:auto 裁切）；有会话走宿主 set_model，新建态落 localStorage。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useAppStore, pickModelId } from "../../store";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";

type ModelMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

export default function ModelMenu({ btnRef, composerRef, onClose }: ModelMenuProps) {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const modelNames = useAppStore((st) => st.modelNames);
  const curModel = s?.model || newSessionModel;
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>()); // prov -> 供应商行元素（flyout 顶部对齐用）
  const [flyProv, setFlyProv] = useState<string | null>(null); // 当前二级浮层的供应商
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null); // 浮层关闭宽限
  const switchT = useRef<ReturnType<typeof setTimeout> | null>(null); // 行切换悬停意图延时

  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  // 卸载清计时器
  useEffect(() => () => { clearTimeout(hideT.current ?? undefined); clearTimeout(switchT.current ?? undefined); }, []);

  // 浮层坐标：#composer 相对（offsetParent）。二级列表向上展开——底缘对齐供应商行底缘
  // （两菜单 padding 均 5px，+5 让末行与行高对齐），不再向下撑出窗口下缘；上方空间不足则
  // 限高 + 内部滚动，顶缘最多到视口上沿 4px。菜单滚动时扣除 scrollTop。注意不得钳位到 0：
  // 菜单一 carousel 般向上超出 composer 时 offsetTop 为负，浮层必须跟着行走到 composer 上方，
  // 钳位会让浮层整体下滑错位。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const comp = composerRef.current;
    const row = rowRefs.current.get(flyProv ?? "");
    const fly = flyRef.current;
    if (!menu || !comp || !row || !fly || !flyProv) return;
    const z = useAppStore.getState().zoomLevel || 1;
    fly.style.maxHeight = "";
    fly.style.overflowY = "";
    const rowBottom = menu.offsetTop + row.offsetTop - menu.scrollTop + row.offsetHeight;
    fly.style.top = "auto";
    fly.style.bottom = comp.clientHeight - rowBottom - 5 + "px";
    const availAbove = Math.round((comp.getBoundingClientRect().top - 4) / z) + rowBottom + 5;
    if (fly.offsetHeight > availAbove) {
      fly.style.maxHeight = Math.max(80, availAbove) + "px";
      fly.style.overflowY = "auto";
    }
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px"; // 与一级菜单边框交叠 4px，视觉无缝
    if (fly.getBoundingClientRect().right > window.innerWidth - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px"; // 右缘越界翻左
    }
  }, [flyProv]);

  // 模型选中：有会话走宿主下发，新建态落 localStorage（手选后不再被配置默认覆盖）
  const pickModel = (id: string) => {
    pickModelId(id);
    onClose();
  };

  // 按 provider 分组（宿主下发 id 形如 "provider/modelId"）
  const groups = new Map<string, [string, string][]>();
  for (const [id, name] of modelNames) {
    const prov = id.split("/")[0];
    if (!groups.has(prov)) groups.set(prov, []);
    groups.get(prov)!.push([id, name]);
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
              clearTimeout(hideT.current ?? undefined);
              if (prov === flyProv) return;
              clearTimeout(switchT.current ?? undefined);
              switchT.current = setTimeout(() => setFlyProv(prov), 180);
            }}
            onMouseLeave={() => clearTimeout(switchT.current ?? undefined)}
            onClick={(e) => {
              e.stopPropagation();
              clearTimeout(hideT.current ?? undefined);
              clearTimeout(switchT.current ?? undefined);
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
          onMouseEnter={() => { clearTimeout(hideT.current ?? undefined); clearTimeout(switchT.current ?? undefined); }}
          onMouseLeave={() => {
            clearTimeout(hideT.current ?? undefined);
            hideT.current = setTimeout(() => setFlyProv(null), 150);
          }}
        >
          {/* flyProv  truthy 时 groups 必有该键（分组自建）；?? [] 仅为满足严格类型 */}
          {(groups.get(flyProv) ?? []).map(([id, name]) => (
            <div className="mi" data-model={id} key={id} onClick={() => pickModel(id)}>
              <span className="ck">{curModel === id ? "✓" : ""}</span>{name}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
