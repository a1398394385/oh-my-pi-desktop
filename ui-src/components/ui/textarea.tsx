// Textarea base component (ported from ZCodium textarea): visually aligned with
// .inp (--bg background + --line-soft border + r9 + accent focus glow);
// rows/sizes are passed by the usage site; zai-specific features like
// field-sizing are not carried over.
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
