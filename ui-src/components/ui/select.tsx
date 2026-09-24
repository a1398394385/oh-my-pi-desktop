// 下拉选择基件（ZCodium select 平移）：trigger 对齐本仓 .sel 胶囊（透明底 / hover --panel-2 /
// caret 展开旋转 180°），弹层对齐 .menu（--ctl-bg 卡面 + --line 边 + r-md + popIn 入场），
// 选项行对齐 .mi（r6 + hover --select）+ 左侧 14px 勾位（✓，--green）。键盘导航/焦点管理由 Radix 提供。
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
        // 胶囊语言：与 .sel 同款（透明底 + 圆角 999 + hover/open --panel-2 底）
        "group/sel inline-flex flex-none shrink-0 cursor-pointer items-center gap-[6px] rounded-full border-0 bg-transparent px-[10px] py-[5px] text-ui-base text-dim outline-none",
        "transition-[background-color,color] duration-[150ms] ease-[var(--swift)]",
        "hover:bg-panel-2 hover:text-text data-[state=open]:bg-panel-2 data-[state=open]:text-text",
        "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[1px]",
        className,
      )}
      {...props}
    >
      {children}
      {/* caret 旋转挂 Icon 根 span（与 .caret-svg 同位），随 trigger 的 data-state 转向 */}
      <Icon
        name="caret"
        size={14}
        className="shrink-0 text-faint transition-transform duration-[220ms] ease-[var(--spring)] group-data-[state=open]/sel:rotate-180"
      />
    </SelectPrimitive.Trigger>
  );
}

// 弹层：popper 定位（原 .sel>.menu 为锚下 6px、右对齐、z-90）；入场走全局 popIn（下弹自上方 6px 滑入）。
// 阴影沿用深色档（浅色降透明度待 style.css 统一，见汇报）。
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
          "z-[90] flex flex-col overflow-x-hidden overflow-y-auto rounded-md border border-line bg-[var(--ctl-bg)] p-[5px] text-text shadow-[0_12px_32px_rgba(0,0,0,.5)] outline-none",
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
        {/* 勾位对齐 .ck：固定 14px 栏宽，未选中时也占位保持文字对齐 */}
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
