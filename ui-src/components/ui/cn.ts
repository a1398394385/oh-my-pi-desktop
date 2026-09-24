// 类合成：clsx 拼接 + tailwind-merge 冲突去重（Radix 基件复写 className 的标准组合）。
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
