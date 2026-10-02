// Popover base component (ported from ZCodium popover): floating-card language
// (--ctl-bg surface + --line border + r-md + popIn entrance).
import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "./cn.js";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-[500] flex w-72 flex-col gap-4 overflow-hidden rounded-md border border-line bg-[var(--ctl-bg)] p-2.5 text-ui-base text-text shadow-[0_12px_32px_rgba(0,0,0,.5)] outline-none",
          "origin-(--radix-popover-content-transform-origin)",
          "[--pop-from:6px] data-[state=open]:[animation:popIn_.18s_ease-out] data-[state=closed]:[animation:none]",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
