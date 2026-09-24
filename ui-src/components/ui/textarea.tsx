// 多行输入基件（ZCodium textarea 平移）：视觉对齐 .inp 同款（--bg 底 + --line-soft 边 + r9 +
// accent 聚焦光晕）；rows/尺寸由使用处传，field-sizing 等 zai 特性不带。
import * as React from "react";

import { cn } from "./cn.js";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
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
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
