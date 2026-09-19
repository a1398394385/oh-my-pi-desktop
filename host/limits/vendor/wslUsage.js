'use strict';

// 裁剪自 token-monitor src/shared/wslUsage.js。原版在 Windows 上枚举 WSL
// 发行版供 grok 扫描会话;omp-desktop 宿主跑在 macOS/Linux 桌面,无 WSL
// 概念,这里恒返回空列表(与原版在非 win32 平台的行为一致)。

async function listRunningWslDistros() {
  return [];
}

module.exports = { listRunningWslDistros };
