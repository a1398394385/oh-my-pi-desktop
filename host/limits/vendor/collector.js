'use strict';

// 裁剪自 token-monitor src/shared/collector.js:只保留 cursor/auth.js 需要的
// tokscaleCommand()。二进制优先从 @tokscale/cli-<platform> 包解析
// (本仓 optionalDependencies),找不到时回退 tokscale npm 包的 JS 入口。

const fs = require('node:fs');
const path = require('node:path');

const PLATFORM_PACKAGES = {
  'darwin-arm64': '@tokscale/cli-darwin-arm64',
  'darwin-x64': '@tokscale/cli-darwin-x64',
  'linux-arm64': '@tokscale/cli-linux-arm64-gnu',
  'linux-x64': '@tokscale/cli-linux-x64-gnu',
  'win32-x64': '@tokscale/cli-win32-x64'
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function locateBundledBinary() {
  const pkgName = PLATFORM_PACKAGES[platformKey()];
  if (!pkgName) return null;
  const binaryName = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
  try {
    const pkgJson = require.resolve(`${pkgName}/package.json`);
    const binPath = path.join(path.dirname(pkgJson), 'bin', binaryName);
    if (fs.existsSync(binPath)) return binPath;
  } catch (_) {}
  return null;
}

function tokscaleBinJs() {
  try {
    return require.resolve('tokscale/bin.js');
  } catch (_) {
    return '';
  }
}

// 与原版同构:{ bin, prefixArgs, env }。有原生二进制直接跑;否则用
// 当前 JS 运行时执行 tokscale 的 JS 入口(Bun/Node 均可)。
function tokscaleCommand() {
  const bundled = locateBundledBinary();
  if (bundled) return { bin: bundled, prefixArgs: [], env: process.env };
  const binJs = tokscaleBinJs();
  if (binJs) return { bin: process.execPath, prefixArgs: [binJs], env: process.env };
  // 都没有:给一个必然 spawn 失败的命令,cursor/auth 会按不可用处理
  return { bin: 'tokscale-not-installed', prefixArgs: [], env: process.env };
}

module.exports = { tokscaleCommand };
