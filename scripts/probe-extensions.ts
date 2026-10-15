// Probe: end-to-end verification of the four extension-center RPCs (against a real host WS).
// Read-only checks + paired toggles (off -> on) guarantee the final state matches the initial one; any failed assertion exits non-zero.
// Usage: bun scripts/probe-extensions.ts <wsPort>
const port = process.argv[2] ?? process.env.HOST_WS_PORT;
if (!port) throw new Error("缺少 ws 端口参数");
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = (e) => reject(new Error(String(e)));
});

let seq = 0;
const pending = new Map<string, (msg: Record<string, unknown>) => void>();
const strayFrames: Record<string, unknown>[] = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
  if (msg.type === "error" && typeof msg.message === "string") {
    // Host command failure reply: print it and fail all pending rpcs fast (the first waiter takes the error)
    console.error(`宿主 error 帧: ${msg.message}`);
    const first = pending.values().next().value as ((m: Record<string, unknown>) => void) | undefined;
    if (first) first(msg);
    return;
  }
  if (typeof msg.type === "string" && pending.has(msg.type)) {
    pending.get(msg.type)!(msg);
    pending.delete(msg.type);
  } else {
    strayFrames.push(msg);
  }
};
function rpc<T extends Record<string, unknown>>(type: string, payload: Record<string, unknown> = {}, replyType?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${type} 超时`)), 60000);
    pending.set(replyType ?? type, (msg) => {
      clearTimeout(t);
      resolve(msg as T);
    });
    ws.send(JSON.stringify({ reqId: ++seq, type, ...payload }));
  });
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

// 1) Initial disabledExtensions (the paired toggles must restore it)
const settings = (await rpc("get_settings", {}, "settings")) as { settings: { values?: Record<string, unknown> } };
const settingVal = (k: string) => settings.settings.values?.[k];
const initialDisabled = JSON.stringify(settingVal("disabledExtensions") ?? []);
console.log(`初始 disabledExtensions: ${initialDisabled}`);

// 2) list_extensions(profile)
const list = (await rpc("list_extensions", { scope: "profile" }, "extensions")) as {
  type: string;
  scope: string;
  scopes: { id: string; label: string }[];
  providers: { id: string; displayName: string; enabled: boolean; foreignUserSource: boolean; userSourceEnabled: boolean }[];
  extensions: { id: string; kind: string; name: string; state: string; source: { provider: string; level: string }; path: string }[];
};
assert(list.type === "extensions", "list_extensions 回包为 extensions 帧");
assert(Array.isArray(list.providers) && list.providers.length > 0, `供应商清单非空（${list.providers?.length ?? 0} 个）`);
// The provider enable states on the page must faithfully mirror settings.disabledProviders (regression defense for base-registry sync)
const disabledProv = new Set(
  Array.isArray(settingVal("disabledProviders")) ? (settingVal("disabledProviders") as string[]) : [],
);
const mismatch = list.providers.filter((p) => p.enabled === disabledProv.has(p.id));
assert(mismatch.length === 0, `供应商启用态与 settings.disabledProviders 一致（${list.providers.length - mismatch.length}/${list.providers.length}）`);
assert(list.scopes[0]?.id === "profile", "scopes 首项为 profile");
const byKind = new Map<string, number>();
for (const ext of list.extensions) byKind.set(ext.kind, (byKind.get(ext.kind) ?? 0) + 1);
console.log(`  profile 范围条目 ${list.extensions.length} 个:`, Object.fromEntries(byKind));
assert(list.extensions.every((x) => x.source.level !== "project"), "profile 范围无项目级条目");
assert(list.extensions.every((x) => x.id.includes(":")), "条目 id 均为 kind:name 形态");

// 3) Project scope (if any desktop project exists)
const projScope = list.scopes.find((s) => s.id.startsWith("project:"));
if (projScope) {
  const plist = (await rpc("list_extensions", { scope: projScope.id }, "extensions")) as typeof list;
  assert(plist.scope === projScope.id, `项目 scope 回显（${projScope.label}）`);
  assert(plist.extensions.every((x) => x.source.level === "project"), "项目范围全部为项目级条目");
  console.log(`  项目范围条目 ${plist.extensions.length} 个`);
} else {
  console.log("  (无桌面项目，跳过项目 scope 验证)");
}

// 4) Item-level toggle in pairs (pick an active, non-mcp entry)
const victim = list.extensions.find((x) => x.state === "active" && x.kind !== "mcp");
if (victim) {
  const off = (await rpc("toggle_extension_item", { id: victim.id, enabled: false, scope: "profile" }, "extensions")) as typeof list;
  const offItem = off.extensions.find((x) => x.id === victim.id);
  assert(offItem?.state === "disabled", `${victim.id} 禁用后状态为 disabled`);
  const on = (await rpc("toggle_extension_item", { id: victim.id, enabled: true, scope: "profile" }, "extensions")) as typeof list;
  const onItem = on.extensions.find((x) => x.id === victim.id);
  assert(onItem?.state === "active", `${victim.id} 重新启用后状态为 active`);
} else {
  console.log("  (无可用 active 条目，跳过项级开关验证)");
}

// 5) Provider master toggle in pairs (pick the first enabled provider)
const prov = list.providers.find((p) => p.enabled);
if (prov) {
  const off = (await rpc("toggle_extension_provider", { providerId: prov.id, scope: "profile" }, "extensions")) as typeof list;
  const offProv = off.providers.find((p) => p.id === prov.id);
  assert(offProv?.enabled === false, `供应商 ${prov.id} 主开关关闭生效`);
  const on = (await rpc("toggle_extension_provider", { providerId: prov.id, scope: "profile" }, "extensions")) as typeof list;
  const onProv = on.providers.find((p) => p.id === prov.id);
  assert(onProv?.enabled === true, `供应商 ${prov.id} 主开关重新开启`);
} else {
  console.log("  (无启用中的供应商，跳过主开关验证)");
}

// 6) Restoration check
const settings2 = (await rpc("get_settings", {}, "settings")) as { settings: { values?: Record<string, unknown> } };
const finalDisabled = JSON.stringify(settings2.settings.values?.disabledExtensions ?? []);
assert(finalDisabled === initialDisabled, "成对开关后 disabledExtensions 与初始一致");

ws.close();
console.log("扩展中心探针全部通过");
process.exit(0);

export {};
