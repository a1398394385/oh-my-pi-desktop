// Button base component (ported from ZCodium button): cva variants mapped to
// this repo's tokens — primary→--accent, secondary/hover→--panel-2/--select,
// ghost→--dim/--panel-2, destructive→--err; transitions colors only
// (transition-colors), never transition-all. Sizes follow the zai h-5~h-8
// range; the settings pages' 31px system is overridden via usage-site className.
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
