// One-shot smoke: exercise the ssh host handlers (list/save/test/remove)
// in-process against the omp-desktop-test profile's ssh.json. Never touches
// ~/.ssh or the default profile.
import { smokeEnv, profileAgentPath } from "./smoke-profile.ts";
if (process.env.OMP_PROFILE !== "omp-desktop-test") {
  process.env.OMP_PROFILE = "omp-desktop-test";
}
import { sshHandlers } from "../host/rpc/ssh.ts";
import { readSSHConfigFile } from "../host/bootstrap.ts";

let pending: Array<(data: string) => void> = [];
const ws = { send(data: string) { const r = pending.shift(); r?.(data); } };
function next(): Promise<any> {
  const { promise, resolve } = Promise.withResolvers<any>();
  pending.push(resolve);
  return promise;
}
async function call(handler, msg) {
  const p = next();
  await handler(ws, msg ?? {});
  return JSON.parse(await p);
}

const path = profileAgentPath("ssh.json");
console.log("ssh.json:", path);

// clean slate: drop a leftover from a crashed earlier run
const initial = await call(sshHandlers.ssh_list_hosts);
if (initial.hosts.some((h) => h.name === "smoke-host")) await call(sshHandlers.ssh_remove_host, { name: "smoke-host" });
console.log("initial hosts:", initial.hosts.length);

// save
const saved = await call(sshHandlers.ssh_save_host, { name: "smoke-host", host: "192.0.2.1", username: "smoke", port: "2222", description: "smoke roundtrip" });
console.log("after save:", saved.hosts.find((h) => h.name === "smoke-host"));

// persisted on disk
const disk = await readSSHConfigFile(path);
console.log("disk entry:", disk.hosts?.["smoke-host"]);

// update (same alias, changed port)
const updated = await call(sshHandlers.ssh_save_host, { name: "smoke-host", host: "192.0.2.1", username: "smoke", port: "2223" });
console.log("after update port:", updated.hosts.find((h) => h.name === "smoke-host")?.port);

// probe: TEST-NET-1 address, BatchMode → unreachable, must reply ok:false with a diagnostic
const probe = await call(sshHandlers.ssh_test_host, { name: "smoke-host" });
console.log("probe ok:", probe.ok, "has error:", Boolean(probe.error), "latency:", probe.latencyMs);

// remove
const removed = await call(sshHandlers.ssh_remove_host, { name: "smoke-host" });
console.log("after remove:", removed.hosts.some((h) => h.name === "smoke-host"));

const diskAfter = await readSSHConfigFile(path);
if (diskAfter.hosts?.["smoke-host"]) throw new Error("smoke-host still on disk after remove");
console.log("SMOKE OK");
process.exit(0);
