'use strict';

// Ported from token-monitor src/shared/config.js, keeping only the three
// functions the limits pipeline uses. The data dir defaults to the agent dir
// of the omp-desktop profile and can be overridden via environment variables.

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
