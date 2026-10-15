// GUI PATH augment smoke: simulate the stripped PATH of a GUI-launched host
// (env -i wipes the whole environment) and verify augmentGuiPath restores
// visibility of nvm/Homebrew-installed commands.
// Run:
//   env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin SHELL=/bin/zsh \
//     OMP_PROFILE=omp-desktop-test bun scripts/smoke-gui-path.ts
import { augmentGuiPath } from "../host/gui-path.ts";

function fail(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}

// Step 1: precondition — npx is invisible under the stripped PATH (reproduces
// the reported failure mode)
const before = process.env.PATH ?? "";
if (before.split(":").filter(Boolean).length > 4) fail(`precondition failed, PATH not stripped: ${before}`);
try {
  const doomed = Bun.spawn(["npx", "--version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const code = await doomed.exited;
  if (code === 0) fail(`npx --version unexpectedly succeeded under stripped PATH (code=${code})`);
} catch {
  // spawn threw "Executable not found in $PATH" — the expected reproduction
}
console.log("✓ reproduced: npx invisible under stripped PATH");

// Step 2: after augment, PATH is extended and both reported commands respawn
await augmentGuiPath();

const after = process.env.PATH ?? "";
const added = after.split(":").filter((p) => !before.split(":").includes(p));
if (added.length === 0) fail(`PATH not extended: ${after}`);
console.log(`✓ PATH extended with ${added.length} entries`);

// Same spawn shape as probeStdioMcp in host/assets.ts: env passed explicitly
// (copied from the augmented process.env). Without an explicit env option
// Bun.spawn resolves against the PATH snapshot taken at process start — the
// runtime rewrite is invisible there (verified experimentally); both host MCP
// spawn paths (probe / SDK stdio transport) pass env explicitly.
async function spawnOk(cmd: string, args: string[]): Promise<void> {
  try {
    const proc = Bun.spawn([cmd, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) fail(`${cmd} ${args.join(" ")} exited with ${code} (visible but failed to run)`);
  } catch (e) {
    fail(`${cmd} spawn failed: ${e}`);
  }
  console.log(`✓ ${cmd} ${args.join(" ")} spawns fine`);
}

await spawnOk("npx", ["--version"]);
await spawnOk("codegraph", ["--help"]);
console.log("✓ GUI PATH augment smoke passed");
