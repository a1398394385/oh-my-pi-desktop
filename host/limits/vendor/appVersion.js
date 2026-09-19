'use strict';

// 移植自 token-monitor src/shared/appVersion.js。原版读 token-monitor 的
// package.json;这里直接标识为 omp-desktop(版本号对限额链路无意义)。

function appVersion() {
  return 'omp-desktop';
}

module.exports = { appVersion };
