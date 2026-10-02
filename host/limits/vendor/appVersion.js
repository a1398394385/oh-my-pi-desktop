'use strict';

// Ported from token-monitor src/shared/appVersion.js. The original reads
// token-monitor's package.json; this one identifies as omp-desktop directly
// (the version number is meaningless to the limits pipeline).

function appVersion() {
  return 'omp-desktop';
}

module.exports = { appVersion };
