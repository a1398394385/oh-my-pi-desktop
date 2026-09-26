// sidecar 入口：先把各版本 pi-natives addon 放入 loader 约定的版本目录，
// 再动态加载宿主。直接编译 host.ts 会在加载 SDK 前触发原生 addon，来不及准备文件。
import os from "node:os";
import path from "node:path";
import { copyFile, link, mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";

const platformTag = `${process.platform}-${process.arch}`;
const addonPrefix = `pi_natives.${platformTag}.`;
const addonDir = path.dirname(process.execPath);
const xdgDataHome = process.env.XDG_DATA_HOME;
const nativesRoot = xdgDataHome && fs.existsSync(path.join(xdgDataHome, "omp"))
  ? path.join(xdgDataHome, "omp", "natives")
  : path.join(os.homedir(), ".omp", "natives");

for (const file of await readdir(addonDir)) {
  if (!file.startsWith(addonPrefix) || !file.endsWith(".node")) continue;
  const version = file.slice(addonPrefix.length, -".node".length);
  const targetDir = path.join(nativesRoot, version);
  await mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, `pi_natives.${platformTag}.node`);
  if (!fs.existsSync(target)) {
    const source = path.join(addonDir, file);
    try {
      // sidecar 与用户缓存通常在同一卷，硬链接避免首次启动复制数百 MB。
      await link(source, target);
    } catch {
      // 跨卷或文件系统不支持硬链接时才复制，保证便携安装仍可启动。
      await copyFile(source, target);
    }
  }
}

await import("./host.ts");
