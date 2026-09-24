// 输入框基件（ZCodium input 平移，尺寸变体裁掉——本仓 .inp 单一形态）：视觉对齐 .inp——
// --bg 底 + --line-soft 边 + r9 + ui-sm 字号 + accent 半透明聚焦光晕（ring 即 box-shadow 实现）。
import * as React from "react";

import { cn } from "./cn.js";

type InputProps = React.ComponentProps<"input"> & { htmlSize?: number };

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, htmlSize, type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      size={htmlSize}
      data-slot="input"
      className={cn(
        "inline-block min-w-[240px] rounded-[9px] border border-line-soft bg-[var(--bg)] px-[10px] py-[6px] text-ui-sm text-text outline-none",
        "transition-[border-color,box-shadow] duration-[180ms] ease-[var(--swift)]",
        "placeholder:text-faint focus:border-accent/50 focus:ring-[3px] focus:ring-accent/13",
        "disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});

export { Input, type InputProps };
