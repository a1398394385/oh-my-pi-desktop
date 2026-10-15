// Generic icon component: icons.js's icon() returns an svg string, injected on
// the React side via dangerouslySetInnerHTML. size overrides the registry
// default (viewBox unchanged); className/title pass through to the host span.
// The host span always carries .pi-ic: the Font Awesome alignment recipe
// (inline-flex box + vertical-align: -0.15em) defined in global/controls.css.
import type { CSSProperties } from "react";
import { cn } from "./components/ui/cn";
import { icon } from "../ui/icons";

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  id?: string;
  title?: string;
  style?: CSSProperties;
}

export default function Icon({ name, size, className, id, title, style }: IconProps) {
  const svg = icon(name, size);
  if (!svg) return null;
  return <span className={cn("pi-ic", className)} id={id} title={title} style={style} dangerouslySetInnerHTML={{ __html: svg }} />;
}
