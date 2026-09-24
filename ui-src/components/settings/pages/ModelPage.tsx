// 设置·模型页（原 ui/settings/models.js 419 行 + providers.js 289 行平移）：
// 左列 = 模型角色入口 + 已认证供应商分组列表（凭证在上 / models.yml 配置在下）；
// 右卡四视图 = 供应商详情（模型启停 + 配额 + 登出）/ 模型角色（@role 二级级联分配）/
//              添加供应商（卡片网格）/ 供应商详情页（登录 / API key 二选一）。
// 视图开关与选中项沿用 store 字段（mpAddView / mpRolesView / mpDetailProv / selectedProvider），
// 登录横幅与粘贴码弹窗来自 ../common.jsx。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAppStore, setBump, send, toast } from "../../../store";
import type { TimerHandle } from "../../../store";
import Icon from "../../../Icon";
import { PROV_IC, confirmDialog } from "../common";

// 目录模型条目（modelCatalog 字段，models_catalog 回包落地；字段为 host 下发）
interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  context?: number | null;
  vision?: boolean;
  authSource?: string; // "cred" 存储凭证 / "config" models.yml 手写
}

// 模型角色条目（modelRoles 字段）
interface ModelRole {
  id: string;
  name: string;
  tag?: string | null; // 宿主 ModelRoleEntry 为 string | null
  value?: string | null; // 未配置为 null/缺省
}

// 配额单窗口（provider_limits_result 内 windows 元素；字段均可能缺省）
interface LimitWindow {
  label?: string;
  kind?: string;
  metric?: string; // "credits" 余额类窗口不渲染进度条
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetsAt?: string | number | null;
}

// 供应商配额结果（providerLimits 落地结构；accounts 为多账号扩展，字段形状同顶层）
interface ProviderLimits {
  provider: string;
  label?: string;
  unsupported?: boolean;
  status?: string;
  windows: LimitWindow[];
  balance?: { amount?: number | null; currency?: string } | null;
  accounts?: Array<Partial<ProviderLimits> & { label?: string; accountLabel?: string }>;
}

// 内置角色的用途说明（自定义角色显示通用文案；名称/tag 以 host 传的底座元数据为准）
// Record 而非字面量联合：RolesView 用任意 role.id 索引
const ROLE_DESC: Record<string, string> = {
  default: "新会话与未指定角色任务的默认模型",
  smol: "快速轻量任务：标题生成、上下文预扫描等",
  slow: "深度思考（Thinking）链路使用的模型",
  vision: "图像 / 视觉理解任务",
  plan: "规划（Architect）模式使用的模型",
  commit: "生成提交信息的模型",
  tiny: "在线标题、记忆、分类等微型任务",
  task: "子智能体（subagent）默认模型",
  advisor: "子智能体的第二意见评审模型",
};

// 配额窗口标签 + 百分比/重置时间格式化（原 ui/ringpop.js fmtLimitWindow 平移）
// Record 而非字面量联合：raw 为任意 host 下发的窗口名
const LIMIT_LABELS: Record<string, string> = { "5-hour": "5小时", "5h": "5小时", weekly: "每周", daily: "每日", session: "会话" };
function fmtLimitWindow(w: LimitWindow): { label: string; pct: number | null; reset: string } {
  const pct = w.usedPercent != null ? Math.round(w.usedPercent) : w.remainingPercent != null ? 100 - Math.round(w.remainingPercent) : null;
  let reset = "";
  if (w.resetsAt) {
    const t = new Date(w.resetsAt);
    const withinDay = t.getTime() - Date.now() < 24 * 3600 * 1000;
    reset = withinDay
      ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
      : `${t.getMonth() + 1}月${t.getDate()}日`;
  }
  const raw = w.label || w.kind || "";
  return { label: LIMIT_LABELS[raw.toLowerCase()] ?? raw, pct, reset };
}

// 配额明细单段（原 ui/ringpop.js buildLimitsSection 平移为组件）。
// 条形色带按索引取 token 色环（旧版 4 色硬编码 palette 的 token 等价：accent/purple/orange/green）
const LIMIT_BAR_COLORS = ["var(--accent)", "var(--purple)", "var(--orange)", "var(--green)"];
function LimitsSection({ limits }: { limits: ProviderLimits }) {
  let body: ReactNode;
  if (limits.unsupported) {
    body = "该供应商暂不支持限额查询";
  } else if (limits.status === "notConfigured") {
    body = "未配置该供应商凭证";
  } else if (!limits.windows?.length && !limits.balance) {
    body = "限额暂不可用";
  } else {
    // 余额类供应商（host 侧 synthesize 的 metric:'credits' 窗口 + balance）只显示余额数字，
    // 不渲染进度条和百分比；有百分比窗口的供应商仍按窗口渲染
    const pctWindows = limits.windows.filter((w) => w.metric !== "credits");
    if (!pctWindows.length && limits.balance?.amount != null) {
      body = (
        <div className="lx-bal">余额 {limits.balance.amount} {limits.balance.currency ?? ""}</div>
      );
    } else if (!pctWindows.length) {
      body = "限额暂不可用";
    } else {
      body = (
        <>
          <div className="lx-grid">
            {pctWindows.slice(0, 4).map((w, i) => {
              const item = fmtLimitWindow(w);
              return (
                <div className="lx-col" key={i}>
                  <div className="lx-top"><span>{item.label}</span></div>
                  <div className="lx-mid">
                    {item.pct != null ? `${item.pct}%` : "—"}
                    {item.reset ? <span> · {item.reset}</span> : null}
                  </div>
                  <div className="lx-bar">
                    <i style={{ width: `${item.pct != null ? Math.min(100, item.pct) : 0}%`, background: LIMIT_BAR_COLORS[i % 4] }} />
                  </div>
                </div>
              );
            })}
          </div>
          {limits.balance?.amount != null && (
            <div className="lx-bal">余额 {limits.balance.amount} {limits.balance.currency ?? ""}</div>
          )}
        </>
      );
    }
  }
  return (
    <div className="cx-sec lx-sec">
      <div className="lx-head">
        <b>剩余额度</b>
        <span className="lx-prov">{limits.label ?? ""}</span>
      </div>
      <div className="lx-body">{body}</div>
    </div>
  );
}

// 供应商配额段：consume providerLimits（store.js 的 provider_limits_result 落地）。
// 旧响应污染判定平移：provider 未变才渲染数据，否则回退「配额读取中…」占位。
function QuotaSection({ provider }: { provider: string }) {
  const lim = useAppStore((s) => s.providerLimits);
  if (!lim || lim.provider !== provider) {
    return <div className="mp-lim">配额读取中…</div>;
  }
  // 多账号：逐账号各渲染一段（头部右侧显示账号身份）；单账号走原有单段路径
  if (Array.isArray(lim.accounts) && lim.accounts.length > 1) {
    return (
      <div className="mp-lim">
        {lim.accounts.map((a, i) => (
          <LimitsSection key={i} limits={{ ...lim, ...a, label: a.label || a.accountLabel || `账号 ${i + 1}` }} />
        ))}
      </div>
    );
  }
  return (
    <div className="mp-lim">
      <LimitsSection limits={lim} />
    </div>
  );
}

// 角色选择器当前值显示：未配置 →「默认」；精确匹配目录模型 → 模型名；其余（别名/带级别后缀）→ 原文
function roleSelLabel(role: ModelRole): string {
  if (!role.value) return role.id === "default" ? "未设置" : "默认";
  const hit = useAppStore.getState().modelCatalog.find((m) => m.id === role.value);
  if (hit) return hit.name;
  return role.value;
}

// 角色行的模型选择器：二级级联（一级供应商行 + hover 右弹浮层），交互对齐输入框模型菜单
// （180ms 悬停意图延时 / 150ms 宽限关闭 / 右缘越界翻左）。浮层挂在 .sel 下而非一级菜单内——
// .menu.model 带 overflow-y:auto 会裁掉绝对定位子元素。宽度由 .mp-role-sel / .mp-role-menu 统一。
function RolePicker({ role, allModels }: { role: ModelRole; allModels: CatalogModel[] }) {
  const [open, setOpen] = useState(false);
  const [flyProv, setFlyProv] = useState<string | null>(null); // 当前二级浮层的供应商
  const selRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>()); // prov -> 供应商行元素（flyout 顶部对齐用）
  const hideT = useRef<TimerHandle | undefined>(undefined); // 浮层关闭宽限
  const switchT = useRef<TimerHandle | undefined>(undefined); // 行切换悬停意图延时

  // 卸载清计时器
  useEffect(() => () => { clearTimeout(hideT.current); clearTimeout(switchT.current); }, []);

  // 点击选择器外关闭（旧版 closeAllMenus 的全局等价）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!selRef.current?.contains(e.target as Node | null)) {
        clearTimeout(hideT.current);
        clearTimeout(switchT.current);
        setOpen(false);
        setFlyProv(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // 浮层坐标：.sel 相对（offsetParent），一级菜单下弹对齐行位（两菜单 padding 均 5px，-5 对齐首行），
  // 浮层与一级菜单边框交叠 4px；右缘越界翻到左侧弹出。越界判定用设置滚动容器（#setBody）可视右缘
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const fly = flyRef.current;
    if (!menu || !fly || !flyProv) return;
    const row = rowRefs.current.get(flyProv);
    if (!row) return;
    fly.style.top = menu.offsetTop + row.offsetTop - menu.scrollTop - 5 + "px";
    fly.style.left = menu.offsetLeft + menu.offsetWidth - 4 + "px";
    const bound = selRef.current?.closest("#setBody") ?? document.body;
    if (fly.getBoundingClientRect().right > bound.getBoundingClientRect().right - 8) {
      fly.style.left = Math.max(0, menu.offsetLeft - fly.offsetWidth + 4) + "px";
    }
  }, [flyProv, open]);

  const pick = (value: string) => {
    if ((role.value ?? null) !== value) send({ type: "set_model_role", role: role.id, value });
    setOpen(false);
    setFlyProv(null);
  };

  const byProv = new Map<string, CatalogModel[]>();
  for (const m of allModels) {
    if (!byProv.has(m.provider)) byProv.set(m.provider, []);
    byProv.get(m.provider)!.push(m); // 上一行 has() 已建组必命中
  }

  return (
    <div
      className="sel mp-role-sel"
      role="button"
      ref={selRef}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
        if (open) setFlyProv(null);
      }}
    >
      <span>{roleSelLabel(role)}</span>
      <span className="caret-svg"><Icon name="caret" size={14} /></span>
      {open && (
        <div className="menu model mp-role-menu open" ref={menuRef}>
          {[...byProv].map(([prov, models]) => (
            <div
              className={"mi prov" + (prov === flyProv ? " on" : "")}
              key={prov}
              ref={(el) => { if (el) rowRefs.current.set(prov, el); else rowRefs.current.delete(prov); }}
              // 行切换加 180ms 悬停意图延时：指针斜向穿过中间行去够浮层时不抢焦
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
              <span className="sub"><Icon name="chevronRight" size={14} /></span>
            </div>
          ))}
        </div>
      )}
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
          {byProv.get(flyProv)!.map((m) => (
            <div className={"mi" + (role.value === m.id ? " on" : "")} key={m.id} onClick={(e) => { e.stopPropagation(); pick(m.id); }}>
              <span className="ck">{role.value === m.id ? "✓" : ""}</span>{m.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 右卡：模型角色视图（srow 行 + 二级级联模型选择器 + 自定义角色删除按钮）
function RolesView() {
  // 目录全量（含未启用模型）：角色值可指向任意目录模型，host 校验与底座解析均走 availableModels 全量
  const allModels = useAppStore((s) => s.modelCatalog);
  const modelRoles = useAppStore((s) => s.modelRoles);
  return (
    <>
      <div className="mp-head">
        <b>模型角色</b>
        <span className="sp" />
        <span className="tag">{(modelRoles?.length ?? 0)} 个角色</span>
      </div>
      <div className="set-group-desc mp-role-desc">为不同用途的任务分配模型；未设置时按内置优先级解析。对新会话生效。</div>
      {(modelRoles ?? []).map((role) => (
        <div className="srow mp-role-row" key={role.id}>
          <div className="srow-tx">
            <b>
              {role.name}
              {role.tag ? <span className="tag">{role.tag}</span> : null}
            </b>
            <span>
              {[
                ROLE_DESC[role.id] ?? "自定义角色",
                role.value && !allModels.some((m) => m.id === role.value) ? `配置值: ${role.value}` : null,
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="srow-ctl">
            <RolePicker role={role} allModels={allModels} />
            {/* 按钮列与自定义行的删除按钮同列对齐：内置角色放 X 清除（有值时；= 传 null 回继承默认），
                自定义角色放 trash 删除（.skill-trash-btn 全站删除语言；传 null = 从 modelRoles 移除） */}
            {role.id in ROLE_DESC ? (
              role.value ? (
                <button
                  type="button"
                  className="mp-role-clear"
                  title="清除选择（继承默认）"
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: "set_model_role", role: role.id, value: null });
                  }}
                >
                  <Icon name="xmark" size={14} />
                </button>
              ) : null
            ) : (
              <button
                type="button"
                className="skill-trash-btn"
                title="删除自定义角色"
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await confirmDialog({
                    title: `确定删除自定义角色 "${role.name}" 吗？`,
                  });
                  if (ok) send({ type: "set_model_role", role: role.id, value: null });
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

// OMP 登录流程启动（原 ui/settings/providers.js startProviderLogin 平移）
function startProviderLogin(id: string) {
  if (useAppStore.getState().loginBusy) {
    toast("已有登录流程进行中，可点击底部进度条取消");
    return;
  }
  const reqId = useAppStore.getState().loginReqId + 1;
  // 旧版 showLoginBanner("…正在启动登录…")；React 版横幅数据在 store.loginBanner，由组件渲染
  setBump({ loginBusy: true, loginReqId: reqId, loginBanner: `${id}：正在启动登录…` });
  send({ type: "provider_login", provider: id, reqId });
}

// 「添加供应商」视图：右卡两列圆角卡片，列出全部受支持供应商（原 renderAddProviderView 平移）。
// 纯渲染不发请求：凭证数由各视图入口显式 send get_all_providers 拉取（此处再发会与
// all_providers 响应处理器互调成无限重绘）。
// PROV_IC 本地放宽为 Record：页面用任意供应商 id 索引（common.tsx 侧保持原导出不动）
const provIc: Record<string, string> = PROV_IC;
function AddProviderView() {
  const allProvidersCache = useAppStore((s) => s.allProvidersCache);
  return (
    <>
      <div className="mp-head"><b>＋ 添加供应商</b></div>
      <div className="set-group-desc">点击供应商卡片进入详情页，可选登录或配置 API key；最后一个「手动添加供应商」走配置层 models.yml。</div>
      {allProvidersCache == null ? (
        <div className="set-group-desc">读取中…</div>
      ) : (
        <div className="ap-grid">
          {allProvidersCache.map((p) => (
            <div className="ap-card ap-card2" key={p.id} onClick={() => { setBump({ mpDetailProv: p }); }}>
              <div className="ap-l1">
                <span className="pv-ic">{provIc[p.id] || "✦"}</span>
                <span className="flex-1 min-w-0 truncate text-ui-base text-text">{p.id}</span>
              </div>
              <div className="ap-l2">
                <span className="tag ap-vendor">{p.label}</span>
                {p.accounts > 0 ? <span className="flex-none ml-auto text-ui-xs text-green">已配置 · {p.accounts}</span> : null}
              </div>
            </div>
          ))}
          {/* 末位固定卡片：手动添加 = 配置层 models.yml */}
          <div
            className="ap-card ap-card2"
            onClick={() => {
              send({ type: "open_models_config" });
              toast("已打开 models.yml，保存后回来刷新即可");
            }}
          >
            <div className="ap-l1">
              <span className="pv-ic">✎</span>
              <span className="flex-1 min-w-0 truncate text-ui-base text-text">手动添加供应商</span>
            </div>
            <div className="ap-l2">
              <span className="tag ap-vendor">models.yml</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 供应商详情页：登录 与 配置 API key 二选一（原 renderProviderDetail 平移，表单受控）
function ProviderDetailView() {
  const p = useAppStore((s) => s.mpDetailProv);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false); // 保存进行中：输入框置灰、按钮转圈，直到 provider_key_done 回包把本视图切回列表
  if (!p) return null;
  return (
    <>
      <div className="mp-head">
        <button
          type="button"
          className="save-btn"
          onClick={() => {
            setBump({ mpDetailProv: null });
            // 返回列表时重拉凭证数：详情页里可能刚发生登录/登出
            send({ type: "get_all_providers" });
          }}
        >
          ← 返回
        </button>
        <b>{provIc[p.id] || "✦"} {p.id}</b>
        <span className="tag">{p.label}</span>
      </div>
      {/* 登录方式（供应商有 OMP 登录流时提供） */}
      {p.login ? (
        <>
          <div className="ap-card pd-login" onClick={() => startProviderLogin(p.id)}>
            <span className="pv-ic">🌐</span>
            <span className="flex-1 min-w-0 truncate text-ui-base text-text">登录</span>
            <span className="tag">浏览器授权</span>
          </div>
          {/* 分隔线：短于卡片宽度，左右不触边；不支持登录的供应商不渲染 */}
          <div className="pd-div" />
        </>
      ) : null}
      {/* API key 方式（所有供应商可用）：标签在上，圆角输入框在下 */}
      <div className="pd-key">
        <div className="srow-tx">
          <b>API Key</b>
          <span>粘贴供应商的 API key，保存后立即生效。</span>
        </div>
        <div className="pd-key-row">
          <input
            className={"inp" + (saving ? " disabled" : "")}
            type="password"
            placeholder="sk-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            type="button"
            className={"save-btn" + (saving ? " busy" : "")}
            disabled={saving}
            onClick={() => {
              const k = key.trim();
              if (!k) {
                toast("请输入 API key");
                return;
              }
              setSaving(true);
              send({ type: "provider_set_key", provider: p.id, key: k });
            }}
          >
            {saving ? <Icon name="refresh" size={14} /> : "保存"}
          </button>
        </div>
      </div>
    </>
  );
}

// 右卡：选中供应商详情（模型启停 + 配额 + 登出）
function ProviderModelsView({ prov, models }: { prov: string; models: CatalogModel[] }) {
  const anyOn = models.some((m) => m.enabled);
  const logout = async () => {
    const ok = await confirmDialog({
      title: `登出 ${prov}`,
      message: "该供应商的全部账号凭证将被移除，模型从可选列表消失；进行中的会话不受影响。",
      confirmText: "登出",
      danger: true,
    });
    if (!ok) return;
    send({ type: "provider_logout", provider: prov });
    toast("正在登出…");
  };
  return (
    <>
      <div className="mp-head">
        <b>{(provIc[prov] || "✦") + " " + prov}</b>
        <span className="sp" />
        <span className="tag">{models.length} 个模型</span>
        {/* 凭证类供应商提供登出（多账号一次登出全部凭证，与 CLI auth-broker logout 一致）；
            config 类（models.yml 手写 apiKey）优先级高于存储凭证，删除凭证无效，不显示按钮 */}
        {models[0]?.authSource === "cred" ? (
          <button type="button" className="save-btn danger" onClick={logout}>登出</button>
        ) : null}
      </div>
      {/* 供应商配额：命中 host 侧 60s 缓存，切换供应商即重查（发送见 ModelPage effect） */}
      <QuotaSection provider={prov} />
      <div className="mp-ml"><span>模型列表</span></div>
      {models.map((m) => (
        <div className="mp-row" key={m.id}>
          <span>{m.name}</span>
          {/* 上下文按二进制单位：204800 → 200k、1048576 → 1M */}
          {m.context ? (
            <span className="tag">
              {m.context >= 1048576 ? Math.round(m.context / 1048576) + "M" : m.context >= 1024 ? Math.round(m.context / 1024) + "k" : String(m.context)}
            </span>
          ) : null}
          {m.vision ? <span className="tag">视觉</span> : null}
          <span className="sp" />
          <div
            className={"tg" + (m.enabled ? " on" : "")}
            onClick={() => {
              if (m.enabled && useAppStore.getState().modelCatalog.filter((x) => x.enabled).length <= 1) {
                toast("至少保留一个启用模型");
                return;
              }
              send({ type: "set_enabled_model", id: m.id, enabled: !m.enabled });
            }}
          >
            <i />
          </div>
        </div>
      ))}
      {!anyOn ? (
        <div className="set-group-desc" style={{ marginTop: "8px" }}>该供应商下暂无启用模型。</div>
      ) : null}
    </>
  );
}

export default function ModelPage() {
  const modelCatalog = useAppStore((s) => s.modelCatalog);
  const mpAddView = useAppStore((s) => s.mpAddView);
  const mpRolesView = useAppStore((s) => s.mpRolesView);
  const mpDetailProv = useAppStore((s) => s.mpDetailProv);
  let selectedProvider = useAppStore((s) => s.selectedProvider);
  // 左列分组：provider -> models（modelCatalog，models_catalog 回包落地）
  const groups = new Map<string, CatalogModel[]>();
  for (const m of modelCatalog) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider)!.push(m);
  }
  // 选中项兜底：非角色视图且未选中 / 选中的供应商已不在目录时，取第一个分组
  //（渲染期静默写 store，同旧 S 写语义不 bump；条件收敛，不会反复触发）
  if (!mpRolesView && (!selectedProvider || !groups.has(selectedProvider))) {
    selectedProvider = groups.keys().next().value ?? null;
    useAppStore.setState({ selectedProvider });
  }
  // 分组：登录/API key 凭证在上，models.yml 配置在下，中间横线 + 组标识
  const credEntries: Array<[string, CatalogModel[]]> = [];
  const configEntries: Array<[string, CatalogModel[]]> = [];
  for (const entry of groups) {
    (entry[1][0]?.authSource === "config" ? configEntries : credEntries).push(entry);
  }
  const sel = selectedProvider;
  const models = (sel ? groups.get(sel) : undefined) || []; // sel 为 null 时原样得 undefined → [],等价
  const showProvDetail = !mpAddView && !mpRolesView && groups.size > 0;
  // 供应商配额：命中 host 侧 60s 缓存，进入详情 / 切换供应商即重查
  useEffect(() => {
    if (showProvDetail && sel) send({ type: "get_provider_limits", provider: sel });
  }, [showProvDetail, sel]);

  return (
    <div className="set-page" id="pg-model">
      <div className="set-tt">模型设置</div>
      <div className="set-desc-row">
        <span className="text-ui-sm text-faint">管理自定义模型供应商，配置后可在聊天时选择使用。</span>
        <span className="sp" />
        <button
          type="button"
          className="icon-btn pg-refresh"
          title="刷新"
          onClick={() => {
            send({ type: "reload_settings" });
            send({ type: "get_models_catalog" });
          }}
        >
          <Icon name="refresh" size={17} />
        </button>
        <button
          className="add-btn"
          type="button"
          onClick={() => {
            setBump({ mpAddView: true, mpRolesView: false });
            // 进入添加视图时拉最新凭证数，登出后「已配置」回显即时收敛
            send({ type: "get_all_providers" });
          }}
        >
          ＋ 添加供应商
        </button>
      </div>
      <div className="set-card mp">
        <div className="mp-l">
          {/* 模型角色入口：全局 @role → 模型分配，置于供应商列表之上 */}
          <div
            className={"pv" + (mpRolesView ? " on" : "")}
            onClick={() => {
              setBump({ mpAddView: false, mpRolesView: true });
              send({ type: "get_model_roles" });
            }}
          >
            <span className="pv-ic"><Icon name="sliders" size={14} /></span>
            <span className="flex-1 min-w-0 truncate font-semibold">模型角色</span>
          </div>
          <div className="pd-div mp-div" />
          <div className="set-sec mp-grp">已认证供应商</div>
          {credEntries.map(([prov, ms]) => (
            <div
              className={"pv" + (!mpRolesView && prov === sel ? " on" : "")}
              key={prov}
              onClick={() => {
                setBump({ mpAddView: false, mpRolesView: false, selectedProvider: prov });
              }}
            >
              <span className="pv-ic">{provIc[prov] || "✦"}</span>
              <span className="flex-1 min-w-0 truncate font-semibold">{prov}</span>
              {ms.some((m) => m.enabled) ? <span className="dot" /> : null}
            </div>
          ))}
          {credEntries.length > 0 && configEntries.length > 0 ? <div className="pd-div mp-div" /> : null}
          {configEntries.length > 0 ? <div className="set-sec mp-grp">配置文件</div> : null}
          {configEntries.map(([prov, ms]) => (
            <div
              className={"pv" + (!mpRolesView && prov === sel ? " on" : "")}
              key={prov}
              onClick={() => {
                setBump({ mpAddView: false, mpRolesView: false, selectedProvider: prov });
              }}
            >
              <span className="pv-ic">{provIc[prov] || "✦"}</span>
              <span className="flex-1 min-w-0 truncate font-semibold">{prov}</span>
              {ms.some((m) => m.enabled) ? <span className="dot" /> : null}
            </div>
          ))}
          {groups.size === 0 ? (
            <div className="pv">暂无可用模型</div>
          ) : null}
        </div>
        <div className="mp-r">
          {mpAddView ? (
            mpDetailProv ? <ProviderDetailView /> : <AddProviderView />
          ) : mpRolesView ? (
            <RolesView />
          ) : showProvDetail ? (
            // sel 在协议数据下必已选(groups 非空才有此分支),! 断言同原版直传
            <ProviderModelsView prov={sel!} models={models} />
          ) : (
            <div className="set-group-desc">
              {groups.size === 0 ? "宿主未连接或没有已认证模型。" : "左侧选择供应商。"}
            </div>
          )}
        </div>
      </div>
      {/* 登录进行中横幅 + 粘贴码弹窗已上提至 Settings 壳根部（common.jsx），切页不中断登录 */}
    </div>
  );
}
