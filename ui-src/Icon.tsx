// Generic icon component: icons.js's icon() returns an svg string, injected on
// the React side via dangerouslySetInnerHTML. size overrides the registry
// default (viewBox unchanged); className/title pass through to the host span.
import type { CSSProperties } from "react";
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
  return <span className={className} id={id} title={title} style={style} dangerouslySetInnerHTML={{ __html: svg }} />;
}
