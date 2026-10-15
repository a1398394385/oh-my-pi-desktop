'use strict';

// Trimmed from token-monitor src/shared/collector.js: keeps only
// tokscaleCommand(), which cursor/auth.js needs. The binary is resolved first
// from the @tokscale/cli-<platform> package (an optionalDependency of this
// repo); when absent, falls back to the JS entry of the tokscale npm package.

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

// Same shape as the original: { bin, prefixArgs, env }. Runs the native
// binary directly when available; otherwise executes tokscale's JS entry with
// the current JS runtime (Bun/Node both work).
function tokscaleCommand() {
  const bundled = locateBundledBinary();
  if (bundled) return { bin: bundled, prefixArgs: [], env: process.env };
  const binJs = tokscaleBinJs();
  if (binJs) return { bin: process.execPath, prefixArgs: [binJs], env: process.env };
  // Neither available: return a command that is guaranteed to fail on spawn;
  // cursor/auth treats it as unavailable
  return { bin: 'tokscale-not-installed', prefixArgs: [], env: process.env };
}

module.exports = { tokscaleCommand };
