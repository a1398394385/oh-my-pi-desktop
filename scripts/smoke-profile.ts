// Single source of truth for the profile every smoke/probe script must run under.
//
// Why this module exists: a host launched without OMP_PROFILE falls back to
// ~/.omp/desktop-profile.json (normally "default"), so a script that forgets to
// pass the env writes its sessions, prompt history and omp-desktop.json into
// the user's default profile. Before this, each of the ~90 scripts under
// scripts/ decided on its own whether to spell out "omp-desktop-test" — many
// spelled out nothing at all, and the ones that did hardcoded
// ~/.omp/agent/omp-desktop.json outright. Route every spawn through smokeEnv()
// and every config path through profileAgentPath() instead.
import os from "node:os";
import path from "node:path";

export const TEST_PROFILE = "omp-desktop-test";

/**
 * Profile this process actually runs under. An explicit OMP_PROFILE still wins
 * so `OMP_PROFILE=some-other-profile bun scripts/x.ts` keeps working; leaving
 * it unset is what makes a smoke run land on the default profile.
 */
export const activeProfile = process.env.OMP_PROFILE?.trim() || TEST_PROFILE;

// Pin this process too. A script that imports host/ modules in-process (not via a
// spawned child) resolves agentDir while those modules evaluate, and the side
// effect has to land before the first such import runs — hence callers keep this
// import above their host imports. PI_PROFILE is the SDK's fallback alias.
process.env.OMP_PROFILE = activeProfile;
process.env.PI_PROFILE = activeProfile;

/** Child env for spawn("bun", ["host/host.ts"]) — always pins a profile. */
export function smokeEnv(extra: Record<string, string> = {}) {
  return { ...process.env, OMP_PROFILE: activeProfile, ...extra };
}

/**
 * Absolute path inside the active profile's agent dir. Mirrors pi-utils'
 * getProfileAgentDir: "default" is the bare ~/.omp/agent, everything else is
 * namespaced under ~/.omp/profiles/<name>/agent.
 */
export function profileAgentPath(...parts: string[]): string {
  const root =
    activeProfile === "default"
      ? path.join(os.homedir(), ".omp", "agent")
      : path.join(os.homedir(), ".omp", "profiles", activeProfile, "agent");
  return path.join(root, ...parts);
}
