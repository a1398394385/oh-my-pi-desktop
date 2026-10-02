// Switch base component (ported from ZCodium switch): visually aligned with
// this repo's .tg — a 38x23 rounded pill, off=--select / on=--accent, an 18px
// white round thumb sliding along the spring curve, squashing to 21px while
// pressed for a skeuomorphic feel. All via :root tokens.
import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "./cn.js";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Motion discipline: background color uses --swift, thumb slide/squash uses --spring (same as .tg)
        "group/tg relative inline-flex h-[23px] w-[38px] flex-none shrink-0 cursor-pointer items-center rounded-full border-0 bg-select outline-none transition-colors duration-[220ms] ease-[var(--swift)] data-[state=checked]:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[1px]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-[18px] w-[18px] rounded-full bg-[#f2f2f4] shadow-[0_1px_3px_rgba(0,0,0,.4)] outline-none",
          "translate-x-[2px] transition-[translate,width] duration-[240ms] ease-[var(--spring)]",
          "data-[state=checked]:translate-x-[18px] group-active/tg:w-[21px] group-active/tg:data-[state=checked]:translate-x-[15px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
