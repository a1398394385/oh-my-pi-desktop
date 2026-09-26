// 悬停提示基件（ZCodium tooltip 平移）：浮层卡视觉（--ctl-bg 卡面 + --line 边 + r-md），
// 入场走全局 popIn 纯淡入（--pop-from:0px）；Provider 默认无延迟，右栏 tab 头等贴近原生
// title 观感的场景在使用处传 delayDuration。
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
