// 按钮基件（ZCodium button 平移）：cva 变体映射到本仓 token——primary→--accent、
// secondary/hover→--panel-2/--select、ghost→--dim/--panel-2、destructive→--err；
// 只过渡颜色（transition-colors），不做 transition-all。尺寸沿用 zai h-5~h-8 系，设置页 31px
// 体系由使用处 className 覆盖。
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "./cn.js";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-transparent text-ui-base whitespace-nowrap transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-white hover:bg-accent/85",
        outline:
          "border-line bg-transparent text-text hover:bg-panel-2 hover:text-text aria-expanded:bg-panel-2 aria-expanded:text-text",
        secondary:
          "bg-panel-2 text-text hover:bg-select aria-expanded:bg-select aria-expanded:text-text",
        ghost:
          "text-dim hover:bg-panel-2 hover:text-text aria-expanded:bg-panel-2 aria-expanded:text-text",
        destructive: "bg-err text-white hover:brightness-110",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-2",
        xs: "h-5 rounded-sm px-2",
        sm: "h-6 px-2",
        lg: "h-8 rounded-lg px-2.5",
        icon: "size-7",
        "icon-xs": "size-5 rounded-sm",
        "icon-sm": "size-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
