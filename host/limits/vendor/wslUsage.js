'use strict';

// Trimmed from token-monitor src/shared/wslUsage.js. The original enumerates
// WSL distros on Windows for grok to scan sessions; the omp-desktop host runs
// on macOS/Linux desktops where WSL does not apply, so this always returns an
// empty list (matching the original's behavior on non-win32 platforms).

async function listRunningWslDistros() {
  return [];
}

module.exports = { listRunningWslDistros };
