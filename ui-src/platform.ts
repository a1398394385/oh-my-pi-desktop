// 平台常量：快捷键的修饰键在 Windows 上用 Ctrl（Win 键被系统占用过多），
// macOS 保持 ⌘。所有 ⌘ 键位的判定与键帽文案统一从这里取。
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** 修饰键键帽文案：Windows 显示 Ctrl，其他平台显示 ⌘ */
export const MOD = IS_WINDOWS ? "Ctrl" : "⌘";

/** 修饰键是否按下（⌘ 键位的平台映射） */
export function modDown(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_WINDOWS ? e.ctrlKey : e.metaKey;
}
