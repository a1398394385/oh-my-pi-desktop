'use strict';

// 移植自 token-monitor src/shared/config.js，仅保留限额链路用到的三个函数。
// 数据目录默认落在 omp-desktop profile 的 agent 目录下，可用环境变量覆盖。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sharedDataDir(options = {}) {
  const env = options.env || process.env;
  if (env.OMP_DESKTOP_LIMITS_DIR) return env.OMP_DESKTOP_LIMITS_DIR;
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, '.omp', 'profiles', 'omp-desktop', 'agent', 'limits-data');
}

function readJson(filePath, fallback = null) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read ${filePath}: ${error.message}`);
    return fallback;
  }
  if (!content.trim()) return fallback;
  try {
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Could not parse JSON in ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

module.exports = { readJson, sharedDataDir, writeJsonAtomic };
