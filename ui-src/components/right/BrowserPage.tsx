// 右栏浏览器页：UI 复刻 ZCode EmbeddedBrowserPaneParts（工具栏/地址栏/空态/加载错误态）。
// 渲染载体：Tauri v2 无窗口内子 webview（WKWebView 限制，tauri::Webview 仅建窗时用），
// 故用 iframe 承载页面 + tauri-plugin-opener 兜底「外部浏览器打开」（跨域下无法读
// 标题/前进后退，导航栈由本组件自维护——ZCode 侦察报告的推荐替代方案）。
import { useEffect, useRef, useState } from "react";
import Icon from "../../Icon";
import { invoke, toast, type TimerHandle } from "../../store";

// ---------- URL 归一化（embeddedBrowserHelpers.normalizeBrowserUrl 简化版） ----------
// 无 scheme 时：localhost/回环/内网 IP/显式端口 -> http，其余 -> https（对齐现代浏览器地址栏）
const LOOPBACK_RE = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const HOST_PORT_RE = /^[\w.-]+:\d+([\/?#]|$)/;
export function normalizeBrowserUrl(raw: unknown): string | null {
  let u = String(raw ?? "").trim();
  if (!u) return null;
  if (/^javascript:/i.test(u)) return null; // 禁止伪协议注入 iframe
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
    u = LOOPBACK_RE.test(u) || HOST_PORT_RE.test(u) ? "http://" + u : "https://" + u;
  }
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}
// 地址栏回显：去掉 https:// 与末尾斜杠
function displayBrowserUrl(href: string): string {
  try {
    const u = new URL(href);
    const s = u.host + u.pathname + u.search + u.hash;
    return s.endsWith("/") && u.pathname === "/" ? s.slice(0, -1) : s;
  } catch {
    return href;
  }
}

// 加载超时：超过即视为加载失败（iframe 跨域不给错误事件，只能超时兜底）
const LOAD_TIMEOUT_MS = 20000;

async function openExternal(url: string) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    toast(`打开链接失败：${err}`);
  }
}

export default function BrowserPage() {
  // 导航栈：跨域 iframe 读不到 history，前进/后退由自建栈驱动
  const [stack, setStack] = useState<string[]>([]); // 已加载 URL 序列（含当前）
  const [idx, setIdx] = useState(-1); // 当前在栈中的位置
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false); // 加载失败态（超时/abort）
  const [nonce, setNonce] = useState(0); // reload 用：同 URL 强制重载
  const [addr, setAddr] = useState(""); // 地址栏输入值
  const [menuOpen, setMenuOpen] = useState(false);
  const loadTimer = useRef<TimerHandle | undefined>(undefined); // DOM setTimeout 句柄；undefined 语义同原版 null（clearTimeout 容忍）

  const current = idx >= 0 ? stack[idx] : null;
  const canBack = idx > 0;
  const canForward = idx < stack.length - 1;

  // 导航：压栈截掉前向分支，驱动 iframe 换 src
  const navigate = (href: string | null) => {
    if (!href) {
      toast("无效的网址");
      return;
    }
    clearTimeout(loadTimer.current);
    setStack((prev) => [...prev.slice(0, idx + 1), href]);
    setIdx((i) => i + 1);
    setAddr(displayBrowserUrl(href));
    setLoading(true);
    setFailed(false);
    loadTimer.current = setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, LOAD_TIMEOUT_MS);
  };

  const goBack = () => {
    if (!canBack) return;
    clearTimeout(loadTimer.current);
    setIdx(idx - 1);
    setAddr(displayBrowserUrl(stack[idx - 1]));
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };
  const goForward = () => {
    if (!canForward) return;
    clearTimeout(loadTimer.current);
    setIdx(idx + 1);
    setAddr(displayBrowserUrl(stack[idx + 1]));
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };
  const reload = () => {
    if (!current) return;
    clearTimeout(loadTimer.current);
    setLoading(true);
    setFailed(false);
    setNonce((n) => n + 1);
    loadTimer.current = setTimeout(() => { setLoading(false); setFailed(true); }, LOAD_TIMEOUT_MS);
  };
  const retry = () => {
    setFailed(false);
    reload();
  };

  // iframe 加载完成（跨域页也能触发 load——只要服务器返回了内容）
  const onIframeLoad = () => {
    clearTimeout(loadTimer.current);
    setLoading(false);
    setFailed(false);
  };

  // 卸载清超时
  useEffect(() => () => clearTimeout(loadTimer.current), []);
  // 更多菜单随全局菜单协调关闭
  useEffect(() => {
    const close = () => setMenuOpen(false);
    document.addEventListener("omp:close-menus", close);
    return () => document.removeEventListener("omp:close-menus", close);
  }, []);

  const submitAddr = () => {
    const href = normalizeBrowserUrl(addr);
    if (!href) {
      toast("无效的网址");
      return;
    }
    if (href === current) reload();
    else navigate(href);
  };

  return (
    <div className="bpane">
      {/* 工具栏：后退 / 前进 / 刷新 / 地址栏 / 外部打开 / 更多 */}
      <div className="bpane-bar">
        <button className="icon-btn" title="后退" disabled={!canBack} onClick={goBack}>
          <Icon name="back" size={14} />
        </button>
        <button className="icon-btn" title="前进" disabled={!canForward} onClick={goForward}>
          <Icon name="forward" size={14} />
        </button>
        <button className="icon-btn" title="刷新" disabled={!current} onClick={reload}>
          <Icon name="rotateRight" size={14} />
        </button>
        <div className={"bpane-addr" + (loading ? " loading" : "")}>
          {loading && <span className="bpane-spin" />}
          <input
            className="bpane-input"
            value={addr}
            placeholder="输入网址，回车打开"
            spellCheck={false}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAddr();
              if (e.key === "Escape") setAddr(current ? displayBrowserUrl(current) : "");
            }}
            onFocus={(e) => e.target.select()}
          />
        </div>
        <button
          className="icon-btn"
          title="在外部浏览器打开"
          disabled={!current}
          onClick={() => current && openExternal(current)}
        >
          <Icon name="externalOpen" size={14} />
        </button>
        <div className="bpane-more-wrap">
          <button
            className="icon-btn"
            title="更多"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
          >
            <Icon name="dots" size={15} />
          </button>
          {menuOpen && (
            <div className="menu open bpane-menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="mi"
                disabled={!current}
                onClick={() => {
                  setMenuOpen(false);
                  if (current) navigator.clipboard.writeText(current).then(() => toast("已复制链接")).catch(() => toast("复制失败"));
                }}
              >
                <span className="mi-ic"><Icon name="globe" size={14} /></span>
                复制链接
              </button>
              <button
                className="mi"
                disabled={!current}
                onClick={() => {
                  setMenuOpen(false);
                  if (current) openExternal(current);
                }}
              >
                <span className="mi-ic"><Icon name="externalOpen" size={14} /></span>
                在外部浏览器打开
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 视口：空态 / iframe / 加载错误态 三态叠加 */}
      <div className="bpane-view">
        {!current && (
          <div className="bpane-empty">
            <span className="bpane-empty-ic"><Icon name="globe" size={30} /></span>
            <div className="bpane-empty-tt">在地址栏输入网址开始浏览</div>
            <div className="bpane-empty-sub">
              部分网站禁止被嵌入（X-Frame-Options），无法在此显示时可在外部浏览器打开。
            </div>
          </div>
        )}
        {current && (
          <iframe
            key={idx + ":" + nonce}
            className="bpane-frame"
            src={current}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            onLoad={onIframeLoad}
          />
        )}
        {current && failed && (
          <div className="bpane-err">
            <span className="bpane-err-ic"><Icon name="shieldWarn" size={26} /></span>
            <div className="bpane-err-tt">页面无法加载</div>
            <div className="bpane-err-sub">
              网站可能拒绝了嵌入请求，或网络不可用。可重试，或在外部浏览器打开。
            </div>
            <div className="bpane-err-acts">
              <button className="btn" onClick={retry}>重试</button>
              <button className="btn" onClick={() => openExternal(current)}>外部打开</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
