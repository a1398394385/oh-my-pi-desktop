// Input base component (ported from ZCodium input, size variants dropped —
// this repo's .inp is a single shape): visually aligned with .inp — --bg
// background + --line-soft border + r9 + ui-sm font size + accent translucent
// focus glow (the ring is implemented as box-shadow).
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
