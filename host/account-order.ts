// Account priority ordering (desktop-only capability; the base is untouched):
// the credential pool serves ORDER BY id ASC and the first row is the account
// every request uses, with no reorder API exposed. This permutes the
// provider's active row ids in place — the new id multiset equals the old one
// (only ownership moves), so it can never collide with another provider's
// rows — and the base picks the new order up on the next reload.
// Dependent tables (auth_credential_blocks / auth_credential_refresh_leases /
// auth_credential_block_mirror_guard) follow their rows' ids: every id is
// first negated to avoid transient primary-key conflicts, then each row is
// moved to its target. The auth_credentials UPDATE triggers bump
// auth_change_revision on their own, so peer processes polling for external
// changes reload and observe the new order.
// shortcut: usage-limit blocks and refresh leases keep their attribution but
// ride along with the row id; upgrade if rows ever need real rewrite.
import { Database } from "bun:sqlite";

/** Tables keyed by credential_id: must follow the row id permutation. */
const CREDENTIAL_ID_TABLES = [
  "auth_credential_blocks",
  "auth_credential_refresh_leases",
  "auth_credential_block_mirror_guard",
] as const;

/**
 * Reorder a provider's active credential rows into `orderedIds`.
 * orderedIds must be a permutation of the current active id set, otherwise
 * false is returned (caller reports the mismatch). After true the caller must
 * refresh the in-memory snapshot (credentials.reload).
 */
export function reorderProviderAccounts(dbPath: string, provider: string, orderedIds: readonly number[]): boolean {
  const db = new Database(dbPath);
  try {
    const rows = db
      .query("SELECT id FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC")
      .all(provider) as Array<{ id: number }>;
    const current = rows.map((r) => r.id);
    if (orderedIds.length !== current.length) return false;
    if (new Set(orderedIds).size !== orderedIds.length) return false;
    if (!orderedIds.every((id) => current.includes(id))) return false;
    // Identity permutation already matches the target order: skip the write.
    if (orderedIds.every((id, i) => id === current[i])) return true;

    // Row at target position i takes the i-th smallest current id: the
    // multiset is preserved, so the permutation never touches other providers.
    const targets = [...current].sort((a, b) => a - b);

    const run = db.transaction(() => {
      db.run("UPDATE auth_credentials SET id = -id WHERE provider = ? AND disabled_cause IS NULL", [provider]);
      for (const table of CREDENTIAL_ID_TABLES) {
        db.run(
          `UPDATE ${table} SET credential_id = -credential_id WHERE credential_id IN (SELECT -id FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL)`,
          [provider],
        );
      }
      for (let i = 0; i < orderedIds.length; i++) {
        const from = -orderedIds[i]!;
        const to = targets[i]!;
        db.run("UPDATE auth_credentials SET id = ? WHERE id = ? AND provider = ? AND disabled_cause IS NULL", [to, from, provider]);
        for (const table of CREDENTIAL_ID_TABLES) {
          db.run(`UPDATE ${table} SET credential_id = ? WHERE credential_id = ?`, [to, from]);
        }
      }
    });
    run();
    return true;
  } finally {
    db.close();
  }
}
