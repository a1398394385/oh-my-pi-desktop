// Tooltip base component (ported from ZCodium tooltip): floating-card visuals
// (--ctl-bg surface + --line border + r-md), entering via the global popIn pure
// fade (--pop-from:0px); the Provider defaults to no delay — usage sites that
// want a near-native title feel (e.g. right-panel tab headers) pass
// delayDuration.
import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "./cn.js";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[600] inline-flex w-fit max-w-xs items-center gap-1.5 rounded-md border border-line bg-[var(--ctl-bg)] px-2 py-1 text-ui-sm text-text shadow-[0_8px_24px_rgba(0,0,0,.35)] outline-none",
          "[--pop-from:0px] data-[state=delayed-open]:[animation:popIn_.12s_ease-out] data-[state=instant-open]:[animation:popIn_.12s_ease-out] data-[state=closed]:[animation:none]",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
