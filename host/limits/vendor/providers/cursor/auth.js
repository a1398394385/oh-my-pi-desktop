'use strict';

// Cursor account-key helper.
//
// Cursor accounts are caller-injected only (see limits.js). The credential
// store, desktop-database and CLI subprocess helpers that used to live here
// were removed so provider fetches never read machine-local state; only the
// stable `user_*` id extractor remains, used to derive account keys.

function canonicalCursorUserId(value) {
  const match = String(value || '').match(/user_[A-Za-z0-9_]+/);
  return match?.[0] || '';
}

module.exports = {
  canonicalCursorUserId
};
