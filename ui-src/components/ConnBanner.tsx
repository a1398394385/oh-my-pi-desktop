// 连接看门狗横幅：宿主连接持续失败超阈值时，在主区顶部给出可操作恢复面
// （对照 PI-Desktop #850 的启动看门狗——把「静默等不到宿主」变成「可重试、可取证」）。
// 自动重试环（ws.ts scheduleReconnect）持续在跑，横幅不中断不替代它：连上即消失。
// 退出/关闭走窗口自身控件（交通灯/标题栏），此处不重复提供。
import { useEffect, useState } from "react";
import { useAppStore } from "../store";

// 阈值取 30s：覆盖宿主冷启动的最坏路径（模型目录走代理刷新可 >15s），
// 又早于 Rust 侧 ws_url 的 60s 超时——两者之间用户就该看到可操作提示
const SHOW_AFTER_MS = 30_000;

export default function ConnBanner() {
  const connected = useAppStore((s) => s.connected);
  const connText = useAppStore((s) => s.connText);
  const connFailSince = useAppStore((s) => s.connFailSince);
  const [now, setNow] = useState(Date.now());

  // 失败期间每秒刷新一次（驱动「已等待 Ns」与阈值判定）；连接正常时无定时器
  useEffect(() => {
    if (connected || connFailSince == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connected, connFailSince]);

  if (connected || connFailSince == null) return null;
  const waited = now - connFailSince;
  if (waited < SHOW_AFTER_MS) return null;

  const copyDiagnostics = () => {
    const report = [
      "omp-desktop 连接诊断",
      `等待时长: ${Math.round(waited / 1000)}s`,
      `状态: ${connText}`,
      `平台: ${navigator.platform}`,
      `UA: ${navigator.userAgent}`,
      `时间: ${new Date().toISOString()}`,
    ].join("\n");
    void navigator.clipboard.writeText(report);
    useAppStore.getState().toast("诊断信息已复制");
  };

  return (
    <div className="conn-banner" role="alert">
      <span className="conn-banner-text">
        宿主连接异常：{connText}（已等待 {Math.round(waited / 1000)}s，自动重试中）
      </span>
      <span className="sp"></span>
      <button className="save-btn" onClick={() => void useAppStore.getState().connect()}>
        立即重试
      </button>
      <button className="save-btn" onClick={copyDiagnostics}>
        复制诊断
      </button>
    </div>
  );
}
