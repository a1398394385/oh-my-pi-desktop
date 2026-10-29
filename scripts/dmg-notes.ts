#!/usr/bin/env bun
// Injects the bilingual install note and the window layout into a built .dmg.
// Why post-processing: Tauri's DmgConfig (config schema `DmgConfig`) only takes background/window/
// icon-position fields, it cannot put extra files into the image, and the Finder AppleScript Tauri
// runs while bundling silently fails on machines without an interactive Finder session (verified:
// the image came out without a .DS_Store, so neither background nor icon positions applied).
// The note also carries the copy-pasteable `xattr -dr com.apple.quarantine` command for ad-hoc signed
// builds, which a background image cannot offer.
// Re-runnable: the writable copy is rebuilt from scratch each time.
// Usage: bun scripts/dmg-notes.ts [path/to/omp-desktop_*.dmg]
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOTE_NAME = "安装说明 How to Install.txt";
const NOTE_SRC = `src-tauri/dmg/${NOTE_NAME}`;
const BACKGROUND_SRC = "src-tauri/dmg/background.png";
const WINDOW_BOUNDS = "200, 200, 860, 660";
const APP_POSITION = "130, 250";
const APPLICATIONS_POSITION = "370, 250";
const NOTE_POSITION = "560, 250";

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${err.trim() || out.trim()}`);
  return out;
}

// CI builds with --target, which nests the bundle one level deeper than a local build.
function findDmg(): string {
  const dirs = ["src-tauri/target/release/bundle/dmg"];
  for (const entry of readdirSync("src-tauri/target", { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "release") {
      dirs.push(`src-tauri/target/${entry.name}/release/bundle/dmg`);
    }
  }
  const found: string[] = [];
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".dmg")) found.push(join(dir, file));
      }
    } catch {
      // target/<triple>/release/bundle/dmg does not exist for every triple
    }
  }
  if (found.length === 0) throw new Error("no .dmg found under src-tauri/target/**/release/bundle/dmg");
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function layoutScript(volume: string): string {
  const appItem = `${JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).productName}.app`;
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `tell application "Finder"
  tell disk ${quote(volume)}
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {${WINDOW_BOUNDS}}
    set arrangement of icon view options of container window to not arranged
    set icon size of icon view options of container window to 96
    set background picture of icon view options of container window to file ".background:background.png"
    set position of item ${quote(appItem)} to {${APP_POSITION}}
    set position of item "Applications" to {${APPLICATIONS_POSITION}}
    set position of item ${quote(NOTE_NAME)} to {${NOTE_POSITION}}
    update without registering applications
  end tell
end tell`;
}

const dmg = process.argv[2] ?? findDmg();
const work = mkdtempSync(join(tmpdir(), "dmg-notes-"));
const rw = join(work, "rw.dmg");
const mount = join(work, "mount");

try {
  // A built image is compressed and read-only; convert to writable first, then back.
  await run(["hdiutil", "convert", dmg, "-format", "UDRW", "-o", rw]);
  mkdirSync(mount);
  await run(["hdiutil", "attach", "-readwrite", "-noverify", "-noautoopen", "-mountpoint", mount, rw]);
  try {
    mkdirSync(join(mount, ".background"), { recursive: true });
    cpSync(BACKGROUND_SRC, join(mount, ".background", "background.png"));
    cpSync(NOTE_SRC, join(mount, NOTE_NAME));
    const volume = (await run(["basename", mount])).trim();
    try {
      await run(["osascript", "-e", layoutScript(volume)]);
      // Finder writes .DS_Store asynchronously; detaching too early drops the layout.
      await Bun.sleep(3000);
    } catch (error) {
      console.warn(`::warning::dmg-notes: no Finder session, layout skipped (${(error as Error).message})`);
    }
  } finally {
    await run(["hdiutil", "detach", mount]);
  }
  await run(["hdiutil", "convert", rw, "-format", "UDZO", "-o", join(work, "out.dmg")]);
  // Copy instead of rename: the temp dir and the repository live on different volumes.
  cpSync(join(work, "out.dmg"), dmg);
  console.log(`dmg-notes: injected "${NOTE_NAME}" into ${dmg}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
