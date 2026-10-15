'use strict';

// Antigravity limits provider: OMP's managed Google accounts only. Reached
// through providerFetchers() in src/shared/limits/collector.js.

const antigravityOAuth = require('./oauth');
const {
  normalizeLimitProvider
} = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
  cleanPlanText,
  nowIso,
  planLabelFromParts,
  providerStatusFromError
} = require('../../limits/providerHelpers');

function antigravityPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  const raw = cleanPlanText(text, ['google', 'ai']);
  if (!raw) return '';
  return planLabelFromParts(raw);
}

function mapAntigravitySnapshot(snapshot, { nowMs, source = 'rpc', account = null } = {}) {
  const updatedAt = nowIso(nowMs ?? Date.now());
  const accountEmail = String(snapshot?.accountEmail || account?.accountEmail || '').trim().toLowerCase();
  const accountLabel = snapshot?.accountPlan ? antigravityPlanLabelFromParts(snapshot.accountPlan) : '';
  const accountKeySeed = accountEmail || snapshot?.accountPlan || account?.id || 'default';
  const windows = Array.isArray(snapshot?.windows)
    ? snapshot.windows.map((window) => ({
        kind: window.kind,
        label: window.name,
        usedPercent: typeof window.remainingFraction === 'number'
          ? Math.max(0, Math.min(100, (1 - window.remainingFraction) * 100))
          : null,
        resetsAt: window.resetTime || null,
        resetDescription: window.resetDescription || '',
        windowMinutes: window.kind === 'session' ? 300 : window.kind === 'weekly' ? 10_080 : null,
        showMeter: window.showMeter !== false
      }))
    : (snapshot?.pools || []).map((pool) => ({
        kind: 'weekly',
        label: pool.name,
        usedPercent: Math.max(0, Math.min(100, (1 - pool.remainingFraction) * 100)),
        resetsAt: pool.resetTime || null,
        windowMinutes: null
      }));
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: accountEmail ? antigravityOAuth.accountKey(accountEmail) : hashKey('antigravity', accountKeySeed),
    accountLabel,
    accountEmail,
    source,
    sourceDetail: snapshot?.sourceDetail || '',
    // OAuth can identify the account and plan even when Google withholds both
    // quota payloads. Preserve that identity, but do not present an empty
    // response as a live zero-usage quota.
    status: windows.length > 0 ? 'ok' : 'unavailable',
    updatedAt,
    windows
  });
}

function antigravityAccountError(account, error, nowMs) {
  const verificationRequired = error?.status === 'verificationRequired';
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: account?.accountKey || antigravityOAuth.accountKey(account?.accountEmail),
    accountLabel: '',
    accountEmail: account?.accountEmail || '',
    source: 'oauth',
    sourceDetail: 'oauth',
    status: verificationRequired
      ? 'unauthorized'
      : error?.status === 'permissionDenied' ? 'unavailable' : providerStatusFromError(error),
    ...(verificationRequired ? { actionRequired: 'accountVerification' } : {}),
    updatedAt: nowIso(nowMs),
    windows: []
  });
}

async function fetchAntigravityLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const scope = options.limitRefreshScope?.provider === 'antigravity' ? options.limitRefreshScope : null;
  const accounts = antigravityOAuth.normalizeManagedAccounts(
    options.antigravityManagedAccounts || deps.antigravityManagedAccounts,
    { includeCredentials: true }
  )
    .filter((account) => account.enabled !== false)
    .filter((account) => !scope
      || (!scope.accountKey || scope.accountKey === account.accountKey)
      && (!scope.accountEmail || scope.accountEmail === account.accountEmail));

  // Quota data may only come from OMP's own credentials. Without a managed
  // account there is nothing left to read: the local RPC probe — and with it
  // the language-server process scan, the listening-port lookup and the
  // installed-app OAuth client discovery — is gone.
  if (accounts.length === 0 && !scope) {
    return normalizeLimitProvider({
      provider: 'antigravity',
      accountKey: '',
      accountLabel: '',
      source: '',
      status: 'notConfigured',
      updatedAt: nowIso(nowMs),
      windows: []
    });
  }

  // OMP-managed accounts are the only remaining source, so there is never a
  // local snapshot to merge into the remote rows (the merge block below is
  // therefore inert).
  const localPromise = Promise.resolve(null);
  const remotePromise = Promise.all(accounts.map(async (account) => {
    try {
      const snapshot = await antigravityOAuth.fetchRemoteSnapshot(account, {
        ...deps,
        onCredentialRenewed: (managedAccount, credentials, previous) => (
          deps.onAntigravityCredentialsRenewed?.({ account: managedAccount, credentials, previous })
        )
      });
      return mapAntigravitySnapshot(snapshot, { nowMs, source: 'oauth', account });
    } catch (error) {
      return antigravityAccountError(account, error, nowMs);
    }
  }));
  const [local, remote] = await Promise.all([localPromise, remotePromise]);
  const providers = [...remote];
  if (local?.accountKey) {
    const duplicateIndex = providers.findIndex((provider) => provider.accountKey === local.accountKey);
    if (duplicateIndex >= 0) {
      const existing = providers[duplicateIndex];
      const existingHasGrouped = (existing.windows || []).some((w) => typeof w.windowMinutes === 'number');
      const localHasGrouped = (local.windows || []).some((w) => typeof w.windowMinutes === 'number');
      const localIsHealthy = local.status === 'ok';
      if (localIsHealthy && (localHasGrouped || !existingHasGrouped)) {
        providers.splice(duplicateIndex, 1, local);
      }
    } else {
      providers.unshift(local);
    }
  }
  return providers;
}

module.exports = {
  fetchAntigravityLimits
};
