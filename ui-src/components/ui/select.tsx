// Select base component (ported from ZCodium select): the trigger aligns with
// this repo's .sel pill (transparent background / hover --panel-2 / caret
// rotates 180° when open), the popover aligns with .menu (--ctl-bg surface +
// --line border + r-md + popIn entrance), and item rows align with .mi (r6 +
// hover --select) plus a 14px left check slot (✓, --green). Keyboard
// navigation / focus management provided by Radix.
import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "./cn.js";
import Icon from "../../Icon";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("flex flex-col gap-[2px] scroll-my-1 p-[2px]", className)}
      {...props}
    />
  );
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        // Pill language: same as .sel (transparent background + radius 999 + hover/open --panel-2 background)
        "group/sel inline-flex flex-none shrink-0 cursor-pointer items-center gap-[6px] rounded-full border-0 bg-transparent px-[10px] py-[5px] text-ui-base text-dim outline-none",
        "transition-[background-color,color] duration-[150ms] ease-[var(--swift)]",
        "hover:bg-panel-2 hover:text-text data-[state=open]:bg-panel-2 data-[state=open]:text-text",
        "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[1px]",
        className,
      )}
      {...props}
    >
      {children}
      {/* caret rotation sits on the Icon root span (same slot as .caret-svg), turning with the trigger's data-state */}
      <Icon
        name="caret"
        size={14}
        className="shrink-0 text-faint transition-transform duration-[220ms] ease-[var(--spring)] group-data-[state=open]/sel:rotate-180"
      />
    </SelectPrimitive.Trigger>
  );
}

// Popover: popper positioning (the original .sel>.menu sat 6px below the
// anchor, end-aligned, z-90); entrance uses the global popIn (dropping-down
// variants slide in from 6px above). Shadow keeps the dark-theme value (a
// lighter light-theme opacity awaits a unified pass in style.css, as noted in
// the report).
function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 6,
  align = "end",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-[500] flex flex-col overflow-x-hidden overflow-y-auto rounded-md border border-line bg-[var(--ctl-bg)] p-[5px] text-text shadow-[0_12px_32px_rgba(0,0,0,.5)] outline-none",
          "max-h-(--radix-select-content-available-height) min-w-[170px] origin-(--radix-select-content-transform-origin)",
          "[--pop-from:-6px] data-[state=open]:[animation:popIn_.18s_ease-out] data-[state=closed]:[animation:none]",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport data-slot="select-viewport" className="flex flex-col">
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-[8px] pb-[2px] pt-[5px] text-ui-sm text-faint", className)}
      {...props}
    />
  );
}

type SelectItemProps = React.ComponentProps<typeof SelectPrimitive.Item>;

const SelectItem = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, SelectItemProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <SelectPrimitive.Item
        ref={ref}
        data-slot="select-item"
        className={cn(
          "flex w-full cursor-default items-center gap-[7px] rounded-[6px] px-[9px] py-[6px] text-ui-base text-text outline-none select-none",
          "data-[highlighted]:bg-select data-[disabled]:pointer-events-none data-[disabled]:text-faint",
          className,
        )}
        {...props}
      >
        {/* Check slot aligns with .ck: fixed 14px column width, reserved even when unselected to keep text aligned */}
        <span className="flex w-[14px] flex-none justify-center text-green">
          <SelectPrimitive.ItemIndicator>✓</SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = "SelectItem";

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none my-[5px] h-px bg-line", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-[var(--ctl-bg)] py-1 text-faint",
        className,
      )}
      {...props}
    >
      <Icon name="chevronUp" size={12} />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-[var(--ctl-bg)] py-1 text-faint",
        className,
      )}
      {...props}
    >
      <Icon name="chevronDown" size={12} />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
