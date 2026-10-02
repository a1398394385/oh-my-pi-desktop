// Dropdown-menu base component (ported from ZCodium dropdown-menu): the content
// card / item rows align with this repo's .menu/.mi language (--ctl-bg surface
// + --line border + r-md + popIn entrance; items r6 + hover --select + a left
// ✓ check slot). Keyboard navigation / focus management provided by Radix;
// z-layer follows the menu family's 60.
import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "./cn.js";
import Icon from "../../Icon";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-[500] flex flex-col overflow-x-hidden overflow-y-auto rounded-md border border-line bg-[var(--ctl-bg)] p-[5px] text-text shadow-[0_12px_32px_rgba(0,0,0,.5)] outline-none",
          "max-h-(--radix-dropdown-menu-content-available-height) max-w-(--radix-dropdown-menu-content-available-width) min-w-[150px] origin-(--radix-dropdown-menu-content-transform-origin)",
          "[--pop-from:6px] data-[state=open]:[animation:popIn_.18s_ease-out] data-[state=closed]:[animation:none]",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "flex cursor-default items-center gap-[7px] rounded-[6px] px-[9px] py-[6px] text-ui-base text-text outline-none select-none",
        "data-[highlighted]:bg-select data-[variant=destructive]:text-err data-[variant=destructive]:data-[highlighted]:text-err",
        "data-[disabled]:pointer-events-none data-[disabled]:text-faint",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "flex cursor-default items-center gap-[7px] rounded-[6px] py-[6px] pl-[9px] pr-[30px] text-ui-base text-text outline-none select-none",
        "data-[highlighted]:bg-select data-[disabled]:pointer-events-none data-[disabled]:text-faint",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="flex w-[14px] flex-none justify-center text-green">
        <DropdownMenuPrimitive.ItemIndicator>✓</DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "flex cursor-default items-center gap-[7px] rounded-[6px] py-[6px] pl-[9px] pr-[30px] text-ui-base text-text outline-none select-none",
        "data-[highlighted]:bg-select data-[disabled]:pointer-events-none data-[disabled]:text-faint",
        className,
      )}
      {...props}
    >
      <span className="flex w-[14px] flex-none justify-center text-green">
        <DropdownMenuPrimitive.ItemIndicator>✓</DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-[8px] pb-[2px] pt-[5px] text-ui-sm text-faint", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-[5px] my-[5px] h-px bg-line", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto text-ui-xs tracking-widest text-faint", className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex cursor-default items-center gap-[7px] rounded-[6px] px-[9px] py-[6px] text-ui-base text-text outline-none select-none",
        "data-[highlighted]:bg-select data-[state=open]:bg-select",
        className,
      )}
      {...props}
    >
      {children}
      <Icon name="chevronRight" size={12} className="ml-auto text-faint" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-[500] flex flex-col overflow-hidden rounded-md border border-line bg-[var(--ctl-bg)] p-[5px] text-text shadow-[0_12px_32px_rgba(0,0,0,.5)] outline-none",
        "min-w-[150px] origin-(--radix-dropdown-menu-content-transform-origin)",
        "[--pop-from:6px] data-[state=open]:[animation:popIn_.18s_ease-out] data-[state=closed]:[animation:none]",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
