// Provider account priority-order smoke (desktop-only capability).
// The base credential pool serves ORDER BY id ASC and the first row is the
// account every request uses; provider_reorder_account permutes the active
// row ids in place so list()/get() follow the user's ranking, and the order
// must survive a process restart (fresh store) plus keep credential_id-keyed
// dependent rows attached.
// Run: OMP_PROFILE=omp-desktop-test bun scripts/smoke-provider-order.ts
// OMP_PROFILE must be set before any host module loads (state.ts reads it at
// import time), so the host imports below cannot be static.
process.env.OMP_PROFILE = process.env.OMP_PROFILE || "omp-desktop-test";

import { Database } from "bun:sqlite";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const { H } = await import("../host/state.ts");
const { refreshAvailableProfiles, applyProfile } = await import("../host/profile.ts");
const { loginHandlers } = await import("../host/rpc/login.ts");
const { reorderProviderAccounts } = await import("../host/account-order.ts");
const { discoverAuthStorage } = await import("../host/bootstrap.ts");

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const assert = (cond: unknown, msg: string) => {
  if (!cond) fail(msg);
};

const PROVIDER = "minimax";
const KEY_A = "smoke-order-key-a";
const KEY_B = "smoke-order-key-b";

H.currentProfile = process.env.OMP_PROFILE!;
await refreshAvailableProfiles();
await applyProfile(process.env.OMP_PROFILE!);
const dbPath = getAgentDbPath(H.agentDir);

const storage = await discoverAuthStorage(H.agentDir);
H.authStorage = storage;

// Clean slate so repeated runs are independent.
for (const cred of storage.credentials.list(PROVIDER)) await storage.credentials.removeById(PROVIDER, cred.id);

// Two accounts, inserted in order: naive storage order makes A the served one.
await storage.credentials.upsert(PROVIDER, { type: "api_key", key: KEY_A });
await storage.credentials.upsert(PROVIDER, { type: "api_key", key: KEY_B });

const apiKey = (cred: unknown): string => {
  const c = cred as { type?: string; key?: string };
  return c?.type === "api_key" ? (c.key ?? "") : "";
};
const servedKey = (): string => apiKey(storage.credentials.get(PROVIDER));
const idOfKey = (key: string): number => {
  const row = storage.credentials.list(PROVIDER).find((r) => apiKey(r.credential) === key);
  if (!row) fail(`account ${key} missing from storage`);
  return row!.id;
};

let rows = storage.credentials.list(PROVIDER);
assert(rows.length === 2, `expected 2 accounts, got ${rows.length}`);
const idA = idOfKey(KEY_A);
const idB = idOfKey(KEY_B);
assert(idA < idB, `insertion order should give A the lower id (A=${idA}, B=${idB})`);
assert(servedKey() === KEY_A, "A should be the served account initially");

// Dependent row keyed by credential_id must follow the permutation.
{
  const db = new Database(dbPath);
  db.run(
    "INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
    [idA, PROVIDER, "meter", Date.now() + 600_000, Date.now()],
  );
  db.close();
}

// Negative guards: partial / duplicated / extra / unknown ids are rejected, storage untouched.
assert(reorderProviderAccounts(dbPath, PROVIDER, [idA]) === false, "missing id must be rejected");
assert(reorderProviderAccounts(dbPath, PROVIDER, [idA, idA]) === false, "duplicate id must be rejected");
assert(reorderProviderAccounts(dbPath, PROVIDER, [idA, idB, idB]) === false, "extra id must be rejected");
assert(reorderProviderAccounts(dbPath, PROVIDER, [idA, 999_999]) === false, "unknown id must be rejected");

// Promote B through the real RPC handler: A stays, B moves ahead.
const frames: Array<Record<string, unknown>> = [];
const ws = { send: (data: string) => frames.push(JSON.parse(data)) };
await loginHandlers.provider_reorder_account(ws as never, { provider: PROVIDER, ids: [idB, idA] });
assert(frames.some((f) => f.type === "provider_accounts"), "handler must push provider_accounts");
assert(servedKey() === KEY_B, "B must become the served account after reorder");
assert(storage.credentials.list(PROVIDER).length === 2, "row count must be preserved by the permutation");

// Handler-level guard: a partial id list must be rejected before touching storage.
{
  const before = storage.credentials.list(PROVIDER).map((r) => r.id);
  let rejected = false;
  try {
    await loginHandlers.provider_reorder_account(ws as never, { provider: PROVIDER, ids: [idA] });
  } catch {
    rejected = true;
  }
  assert(rejected, "handler must reject an id list that does not cover every active account");
  assert(
    JSON.stringify(storage.credentials.list(PROVIDER).map((r) => r.id)) === JSON.stringify(before),
    "rejected reorder must leave storage untouched",
  );
}

// The block inserted on A's old id must now sit on whichever row owns A's credential.
{
  const db = new Database(dbPath);
  const blocks = db.query("SELECT credential_id FROM auth_credential_blocks WHERE provider_key = ?").all(PROVIDER) as Array<{ credential_id: number }>;
  db.close();
  assert(blocks.length === 1 && blocks[0]!.credential_id === idOfKey(KEY_A), "block row must follow its credential id");
}

// Restart simulation: a brand-new store instance must observe the same order.
const fresh = await discoverAuthStorage(H.agentDir);
assert(
  JSON.stringify(fresh.credentials.list(PROVIDER).map((r) => r.id)) ===
    JSON.stringify(storage.credentials.list(PROVIDER).map((r) => r.id)),
  "order must survive a fresh store (persistence)",
);
assert(apiKey(fresh.credentials.get(PROVIDER)) === KEY_B, "B must remain the served account after restart");
fresh.close();

// Cleanup: remove both rows (tombstones) and hard-delete so the test profile stays clean.
for (const cred of storage.credentials.list(PROVIDER)) await storage.credentials.removeById(PROVIDER, cred.id);
{
  const db = new Database(dbPath);
  db.run("DELETE FROM auth_credential_blocks WHERE provider_key = ?", [PROVIDER]);
  db.run("DELETE FROM auth_credentials WHERE provider = ?", [PROVIDER]);
  db.close();
}
storage.close();

console.log("✓ 账号优先级排序冒烟通过：RPC 生效切换、持久化、附属表跟随、负例拦截");
